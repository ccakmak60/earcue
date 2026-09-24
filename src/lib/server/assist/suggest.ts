import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { requireAuthed, touchTz } from "../auth";
import { sql } from "../db";
import { env } from "../env";
import { profileFor, recall } from "../knowledge";
import { keepCited } from "../harness/check";
import { Run, type Prompt } from "../harness/runs";
import { chatJson, type JsonSchema } from "../llm";
import { consume, localDay } from "../quota";
import { json, query, readJson } from "../respond";

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
  version: "1",
  text:
    "You are a proactive assistant watching one person work. You get the last 15 minutes of their screen and speech, any meeting in progress, their profile and stored memories, and the titles of suggestions already made today. " +
    "Emit at most two suggestions, and only when they beat silence: idea for a concrete next move on the task in front of them, mistake when the screen or speech contradicts their own context (wrong figure, wrong recipient, missed constraint), draft when a message, reply, or pitch is clearly owed — put the full sendable text in draft_text, reminder for a commitment or meeting about to lapse, answer for a question they just asked out loud that the context answers. " +
    "Every trace line, memory and context item you are given carries a `ref`. Each evidence entry names one of those refs in `ref` and quotes the few words that matter in `quote`; a suggestion with no valid ref is discarded. Never repeat a title from `already`, and suggest nothing similar to `not_useful`, which they dismissed. An empty array is the common case. " +
    "`profile` and `memories` are durable facts distilled from this person's own archive — imported browsing, bookmarks, chats, and mail. Use them to judge what is worth saying, to catch " +
    "contradictions with what they have previously decided, and to address people and projects by their real names. " +
    "Never present a memory back to them as news, and never cite a memory as evidence unless the current screen or " +
    "speech touches it. In briefing mode there may be no recent activity at all: then suggest from calendar, inbox, and " +
    "memories only. `profile_static` are facts that are always true about them; `profile_dynamic` is what they are working on right now.",
};

// Briefing mode has no live screen or speech: it recommends from the imported archive alone, which
// is the whole product while capture is on hold (src/lib/shared/features.ts).
const BRIEFING_PROMPT: Prompt = {
  version: "1",
  text:
    "You are a personal assistant for one person. You get what they imported (mail, chats, calendar, documents, bookmarks and browsing) distilled into a profile and memories, " +
    "plus their recent inbox, their calendar for the next day, and the titles of recommendations already made this week. There is no live activity. " +
    "Recommend at most three next steps, and only ones worth interrupting them for: reminder for a commitment they made, a deadline, or an event they should prepare for; " +
    "draft when a reply or follow-up is clearly owed (put the full sendable text in draft_text, in their voice and language); idea for a concrete next move on something they are actively working on; " +
    "mistake when two things they wrote or scheduled contradict each other. Write each title as a short imperative a busy person can act on, and each detail as one or two plain sentences with no jargon. " +
    "Every calendar event, inbox message, document and memory you are given carries a `ref`. Each evidence entry names one of those refs in `ref` and quotes the subject, title or words that matter in `quote`; a recommendation with no valid ref is discarded. " +
    "Never repeat a title from `already`, and suggest nothing similar to `not_useful`, which they dismissed. " +
    "Address people and projects by their real names. Memories flagged sensitive are never included here. An empty array is fine when nothing is worth saying. " +
    "`profile_static` are facts that are always true about them; `profile_dynamic` is what they are working on right now.",
};

interface ProducedSuggestion {
  kind: string;
  title: string;
  detail: string;
  draft_text?: string;
  evidence?: { ref: string; quote: string }[];
  urgency: string;
  confidence: number;
}

function dedupKeyFor(title: string): string {
  const normalized = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

export async function handleSuggest(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true });

  const { tz, mode } = await readJson(request);
  const briefing = mode === "briefing";
  await touchTz(user.id, tz);

  await consume(user, "assist_calls", 1);

  const recent = await sql`
    select id, ts, kind, source, speaker, text, meta from traces
    where user_id = ${user.id} and ts > now() - interval '15 minutes'
    order by ts asc limit 80
  `;
  if (!briefing && recent.length === 0) return json({ suggestions: [] });

  // Everything below reads independent rows, so it goes out as one batch (five connections — under
  // the Worker's six-open-connections ceiling). Only recall waits, because its query can be the profile.
  // A briefing looks further out and further back than a live pass, which runs every few minutes.
  const day = localDay(user.tz);
  const aheadHours = briefing ? 24 : 12;
  const inboxHours = briefing ? 72 : 6;
  const inboxLimit = briefing ? 15 : 10;
  const alreadyDays = briefing ? 7 : 1;
  const [profileRow, calendar, inbox, [meeting], already] = await Promise.all([
    profileFor(user.id),
    sql`
      select id, provider, kind, title, body, url, ts from context_items
      where user_id = ${user.id} and kind = 'event'
        and ts between now() - interval '2 hours' and now() + (${aheadHours} || ' hours')::interval
      order by ts asc limit 8
    `,
    sql`
      select id, provider, kind, title, body, url, ts from context_items
      where user_id = ${user.id} and kind in ('email', 'message') and ts > now() - (${inboxHours} || ' hours')::interval
      order by ts desc limit ${inboxLimit}
    `,
    sql`
      select id, started_at, source from meetings where user_id = ${user.id} and ended_at is null
      order by started_at desc limit 1
    `,
    // Recent titles (never repeat) plus a month of dismissals (never suggest anything like them).
    sql`
      select title, status from suggestions
      where user_id = ${user.id} and local_day > ${day}::date - 30 and local_day <= ${day}::date
        and (status = 'dismissed' or local_day > ${day}::date - ${alreadyDays}::int)
      order by ts desc limit 60
    `,
  ]);
  const profile = profileRow?.summary || "";

  const focus =
    recent.length > 0
      ? recent
          .slice(-5)
          .map((r) => r.text)
          .join(" ")
          .slice(0, 400)
      : profile.slice(0, 300);

  const { memories, documents: contextMatches } = await recall(user.id, { query: focus, limit: 8 });

  // Every row the model may cite goes out under a ref in place of its id; the run records the set.
  const run = new Run(user.id, briefing ? "briefing" : "live", briefing ? BRIEFING_PROMPT : SUGGEST_PROMPT, env.MODEL_REASON);
  const { refs } = run;
  const payload = {
    profile,
    profile_static: profileRow?.static || [],
    profile_dynamic: profileRow?.dynamic || [],
    memories: memories.map(({ id, ...m }) => ({ ref: refs.memory(id), ...m })),
    recent: recent.map(({ id, ...r }) => ({ ref: refs.trace(id), ...r })),
    focus_context: contextMatches.map(({ id, ...d }) => ({ ref: refs.item(id), ...d })),
    calendar: calendar.map(({ id, ...c }) => ({ ref: refs.item(id), ...c })),
    inbox: inbox.map(({ id, ...i }) => ({ ref: refs.item(id), ...i })),
    meeting: meeting || null,
    already: already.map((r) => r.title),
    not_useful: already.filter((r) => r.status === "dismissed").map((r) => r.title),
  };

  const produced = await run.track(async () => {
    const result = await chatJson<{ suggestions: ProducedSuggestion[] }>({
      model: run.model,
      messages: [{ role: "user", content: `${run.prompt.text}\n\n${JSON.stringify(payload)}` }],
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
    run.output = { suggestions: rows.map((r) => Number(r.id)), duplicates: kept.length - rows.length, dropped, bad_refs: badRefs };
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

  await sql`update suggestions set status = ${status} where user_id = ${user.id} and client_id = ${clientId}`;
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
