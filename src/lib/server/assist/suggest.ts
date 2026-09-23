import "server-only";
import { randomUUID } from "node:crypto";
import { requireAuthed, touchTz } from "../auth";
import { sql } from "../db";
import { env } from "../env";
import { profileFor, recall } from "../knowledge";
import { keepCited } from "../harness/check";
import { buildContext, contextMessages, UNTRUSTED_RULE, type Section } from "../harness/context";
import { Run, type Prompt } from "../harness/runs";
import { chatJson, type JsonSchema } from "../llm";
import { consume, localDay } from "../quota";
import { recordFeedback } from "../open-loops";
import { json, query, readJson } from "../respond";
import { dedupKeyFor, runBriefing } from "./briefing";

// ---------- proactive suggestions ----------

const SUGGEST_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["idea", "mistake", "draft", "reminder", "answer"] },
          title: { type: "string" },
          detail: { type: "string" },
          draft_text: { type: "string" },
          evidence: {
            type: "array",
            items: {
              type: "object",
              properties: { ref: { type: "string" }, quote: { type: "string" } },
              required: ["ref", "quote"],
            },
          },
          urgency: { type: "string", enum: ["low", "medium", "high"] },
          confidence: { type: "number" },
        },
        required: ["kind", "title", "detail", "evidence", "urgency", "confidence"],
      },
    },
  },
  required: ["suggestions"],
};

// Each prompt's `version` is recorded in agent_runs; bump it whenever the text changes.
const SUGGEST_PROMPT: Prompt = {
  version: "2",
  text:
    "You are a proactive assistant watching one person work. You get the last 15 minutes of their screen and speech, any meeting in progress, their profile and stored memories, and the titles of suggestions already made today. " +
    "Emit at most two suggestions, and only when they beat silence: idea for a concrete next move on the task in front of them, mistake when the screen or speech contradicts their own context (wrong figure, wrong recipient, missed constraint), draft when a message, reply, or pitch is clearly owed — put the full sendable text in draft_text, reminder for a commitment or meeting about to lapse, answer for a question they just asked out loud that the context answers. " +
    "Every trace line, memory and context item you are given carries a `ref`. Each evidence entry names one of those refs in `ref` and quotes the few words that matter in `quote`; a suggestion with no valid ref is discarded. Never repeat a title from `already`, and suggest nothing similar to `not_useful`, which they dismissed. An empty array is the common case. " +
    "`profile` and `memories` are durable facts distilled from this person's own archive — imported browsing, bookmarks, chats, and mail. Use them to judge what is worth saying, to catch " +
    "contradictions with what they have previously decided, and to address people and projects by their real names. " +
    "Never present a memory back to them as news, and never cite a memory as evidence unless the current screen or " +
    "speech touches it. In briefing mode there may be no recent activity at all: then suggest from calendar, inbox, and " +
    "memories only. `profile_static` are facts that are always true about them; `profile_dynamic` is what they are working on right now. " +
    UNTRUSTED_RULE,
};

// The payload's sections, most important first, each with its own token budget, and the whole
// under CONTEXT_TOKENS; the budget cuts from the bottom. Titles already made and dismissed come
// first because repeating one is the failure a person notices most, and they are short. The
// profile is earcue's own summary. Everything read from the archive is untrusted. Recall by the
// profile's opening is the weakest signal, so it goes first when the payload is over.
const CONTEXT_TOKENS = 12_000;
const INBOX_BODY_CHARS = 1500;

interface ContextParts {
  already: string[];
  notUseful: string[];
  profile: string;
  profileStatic: unknown[];
  profileDynamic: unknown[];
  meeting: unknown;
  recent: Record<string, unknown>[];
  calendar: Record<string, unknown>[];
  inbox: Record<string, unknown>[];
  memories: Record<string, unknown>[];
  focus: Record<string, unknown>[];
}

function suggestSections(p: ContextParts): Section[] {
  return [
    { key: "already", value: p.already, tokens: 800 },
    { key: "not_useful", value: p.notUseful, tokens: 400 },
    { key: "profile", value: p.profile, tokens: 400 },
    { key: "profile_static", value: p.profileStatic, tokens: 300 },
    { key: "profile_dynamic", value: p.profileDynamic, tokens: 300 },
    { key: "meeting", value: p.meeting, tokens: 100 },
    { key: "recent", value: p.recent, tokens: 3000, ref: "traces", untrusted: true },
    { key: "calendar", value: p.calendar, tokens: 1200, ref: "items", untrusted: true },
    { key: "inbox", value: p.inbox, tokens: 4000, ref: "items", untrusted: true },
    { key: "memories", value: p.memories, tokens: 1500, ref: "memories", untrusted: true },
    { key: "focus_context", value: p.focus, tokens: 1500, ref: "items", untrusted: true },
  ];
}

interface ProducedSuggestion {
  kind: string;
  title: string;
  detail: string;
  draft_text?: string;
  evidence?: { ref: string; quote: string }[];
  urgency: string;
  confidence: number;
}

// POST suggest. Gate: session (401), entitlement (402), then one assist_calls unit (429). Briefing
// mode (the For you feed) is the three-step pipeline in briefing.ts; live mode, behind capture, is
// one call over the last 15 minutes of screen and speech.
export async function handleSuggest(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true });

  const { tz, mode } = await readJson(request);
  await touchTz(user.id, tz);

  await consume(user, "assist_calls", 1);

  const day = localDay(user.tz);
  if (mode === "briefing") return json({ suggestions: (await runBriefing(user, day)).map(suggestionOut) });

  const recent = await sql`
    select id, ts, kind, source, speaker, text, meta from traces
    where user_id = ${user.id} and ts > now() - interval '15 minutes'
    order by ts asc limit 80
  `;
  if (recent.length === 0) return json({ suggestions: [] });

  // Everything below reads independent rows, so it goes out as one batch (five connections — under
  // the Worker's six-open-connections ceiling). Only recall waits, because its query uses the traces.
  const [profileRow, calendar, inbox, [meeting], already] = await Promise.all([
    profileFor(user.id),
    sql`
      select id, provider, kind, title, body, url, ts from context_items
      where user_id = ${user.id} and kind = 'event'
        and ts between now() - interval '2 hours' and now() + interval '12 hours'
      order by ts asc limit 8
    `,
    sql`
      select id, provider, kind, title, left(body, ${INBOX_BODY_CHARS}) as body, url, ts from context_items
      where user_id = ${user.id} and kind in ('email', 'message') and ts > now() - interval '6 hours'
      order by ts desc limit 10
    `,
    sql`
      select id, started_at, source from meetings where user_id = ${user.id} and ended_at is null
      order by started_at desc limit 1
    `,
    // Today's titles (never repeat) plus a month of dismissals (never suggest anything like them).
    sql`
      select title, status from suggestions
      where user_id = ${user.id} and local_day > ${day}::date - 30 and local_day <= ${day}::date
        and (status = 'dismissed' or local_day = ${day}::date)
      order by ts desc limit 60
    `,
  ]);
  const profile = profileRow?.summary || "";

  const focus = recent
    .slice(-5)
    .map((r) => r.text)
    .join(" ")
    .slice(0, 400);

  const { memories, documents: contextMatches } = await recall(user.id, { query: focus, limit: 8 });

  // Every row the model may cite goes out under a ref in place of its id, and only rows the budget
  // keeps are recorded as sent.
  const run = new Run(user.id, "live", SUGGEST_PROMPT, env.MODEL_REASON);
  const { refs } = run;
  const context = buildContext(
    refs,
    suggestSections({
      already: already.map((r) => r.title),
      notUseful: already.filter((r) => r.status === "dismissed").map((r) => r.title),
      profile,
      profileStatic: profileRow?.static || [],
      profileDynamic: profileRow?.dynamic || [],
      meeting: meeting || null,
      recent,
      calendar,
      inbox,
      memories,
      focus: contextMatches,
    }),
    CONTEXT_TOKENS
  );

  const { messages, redacted } = contextMessages(run.prompt.text, context.trusted, context.untrusted);

  const produced = await run.track(async () => {
    const result = await chatJson<{ suggestions: ProducedSuggestion[] }>({
      model: run.model,
      messages,
      schema: SUGGEST_SCHEMA,
      maxTokens: 1200,
      deadlineMs: 45000,
      userId: user.id,
      meter: run.meter,
    });

    // Only evidence citing a ref sent above survives; a suggestion left with none is dropped.
    const { kept, dropped, badRefs } = keepCited(result.suggestions || [], refs);
    const rows = [];
    for (const s of kept) {
      const clientId = randomUUID();
      const dedupKey = dedupKeyFor(s.title);
      const inserted = await sql`
        insert into suggestions (user_id, client_id, local_day, kind, title, detail, draft_text, evidence, urgency, confidence, dedup_key, run_id)
        values (${user.id}, ${clientId}, ${day}, ${s.kind}, ${s.title}, ${s.detail}, ${s.draft_text || null}, ${JSON.stringify(s.evidence)}, ${s.urgency}, ${s.confidence}, ${dedupKey}, ${run.id})
        on conflict (user_id, dedup_key, local_day) do nothing
        returning id, client_id, kind, title, detail, draft_text, evidence, urgency, confidence
      `;
      if (inserted.length > 0) rows.push(inserted[0]);
    }
    run.output = {
      suggestions: rows.map((r) => Number(r.id)),
      duplicates: kept.length - rows.length,
      dropped,
      bad_refs: badRefs,
      context_tokens: context.tokens,
      ...(Object.keys(context.cut).length > 0 ? { context_cut: context.cut } : {}),
      ...(redacted > 0 ? { redacted } : {}),
    };
    run.settle(kept.length, dropped);
    return rows;
  });

  return json({ suggestions: produced.map(suggestionOut) });
}

// Evidence is stored as {ref, quote} since migration 021 and as plain strings before it; the client
// shows the quote either way.
function evidenceOut(evidence: unknown): string[] {
  if (!Array.isArray(evidence)) return [];
  return evidence.map((e) => (typeof e === "string" ? e : String(e?.quote || e?.ref || ""))).filter(Boolean);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function suggestionOut(r: Record<string, any>) {
  return {
    clientId: r.client_id,
    kind: r.kind,
    title: r.title,
    detail: r.detail,
    draftText: r.draft_text,
    evidence: evidenceOut(r.evidence),
    urgency: r.urgency,
    confidence: r.confidence,
  };
}

export async function handleFeedback(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);

  const { clientId, status } = await readJson(request);
  if (!["shown", "accepted", "dismissed"].includes(status)) return json({ error: "bad status" }, 400);
  if (!clientId) return json({ error: "clientId required" }, 400);

  // A recommendation made from an open loop closes it: accepted marks it done, dismissed dismissed.
  await recordFeedback(user.id, String(clientId), status);
  return json({ ok: true });
}

export async function handleSuggestionsGet(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);

  // `days` widens the window backwards from `day` (the For you feed shows the last week).
  const params = query(request);
  const day = params.get("day");
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: "day required" }, 400);
  const days = Math.min(14, Math.max(1, Math.floor(Number(params.get("days")) || 1)));

  const rows = await sql`
    select client_id, ts, kind, title, detail, draft_text, evidence, urgency, confidence, status
    from suggestions
    where user_id = ${user.id} and local_day > ${day}::date - ${days}::int and local_day <= ${day}::date
    order by ts desc limit 100
  `;
  return json({
    suggestions: rows.map((r) => ({ ...suggestionOut(r), ts: r.ts, status: r.status })),
  });
}
