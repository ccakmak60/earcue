import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { requireAuthed, touchTz } from "../auth";
import { sql } from "../db";
import { env } from "../env";
import { profileFor, recall } from "../knowledge";
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
          evidence: { type: "array", items: { type: "string" } },
          urgency: { type: "string", enum: ["low", "medium", "high"] },
          confidence: { type: "number" },
        },
        required: ["kind", "title", "detail", "evidence", "urgency", "confidence"],
      },
    },
  },
  required: ["suggestions"],
};

const SUGGEST_INSTRUCTION =
  "You are a proactive assistant watching one person work. You get the last 15 minutes of their screen and speech, any meeting in progress, their profile and stored memories, and the titles of suggestions already made today. " +
  "Emit at most two suggestions, and only when they beat silence: idea for a concrete next move on the task in front of them, mistake when the screen or speech contradicts their own context (wrong figure, wrong recipient, missed constraint), draft when a message, reply, or pitch is clearly owed — put the full sendable text in draft_text, reminder for a commitment or meeting about to lapse, answer for a question they just asked out loud that the context answers. " +
  "Every evidence entry must quote a specific HH:MM trace line or a context title you were given. Never repeat a title from `already`. An empty array is the common case. " +
  "`profile` and `memories` are durable facts distilled from this person's own archive — imported browsing, bookmarks, chats, and mail. Use them to judge what is worth saying, to catch " +
  "contradictions with what they have previously decided, and to address people and projects by their real names. " +
  "Never present a memory back to them as news, and never cite a memory as evidence unless the current screen or " +
  "speech touches it. In briefing mode there may be no recent activity at all: then suggest from calendar, inbox, and " +
  "memories only. `profile_static` are facts that are always true about them; `profile_dynamic` is what they are working on right now.";

interface ProducedSuggestion {
  kind: string;
  title: string;
  detail: string;
  draft_text?: string;
  evidence?: string[];
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
    select ts, kind, source, speaker, text, meta from traces
    where user_id = ${user.id} and ts > now() - interval '15 minutes'
    order by ts asc limit 80
  `;
  if (!briefing && recent.length === 0) return json({ suggestions: [] });

  // Everything below reads independent rows, so it goes out as one batch (five connections — under
  // the Worker's six-open-connections ceiling). Only recall waits, because its query can be the profile.
  const day = localDay(user.tz);
  const [profileRow, calendar, inbox, [meeting], already] = await Promise.all([
    profileFor(user.id),
    sql`
      select provider, kind, title, body, url, ts from context_items
      where user_id = ${user.id} and kind = 'event' and ts between now() - interval '2 hours' and now() + interval '12 hours'
      order by ts asc limit 5
    `,
    sql`
      select provider, kind, title, body, url, ts from context_items
      where user_id = ${user.id} and kind in ('email', 'message') and ts > now() - interval '6 hours'
      order by ts desc limit 10
    `,
    sql`
      select id, started_at, source from meetings where user_id = ${user.id} and ended_at is null
      order by started_at desc limit 1
    `,
    sql`
      select title from suggestions where user_id = ${user.id} and local_day = ${day} order by ts desc limit 20
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

  const payload = {
    profile,
    profile_static: profileRow?.static || [],
    profile_dynamic: profileRow?.dynamic || [],
    memories,
    recent,
    focus_context: contextMatches,
    calendar,
    inbox,
    meeting: meeting || null,
    already: already.map((r) => r.title),
  };

  const result = await chatJson<{ suggestions?: ProducedSuggestion[] }>({
    model: env.MODEL_REASON,
    messages: [{ role: "user", content: `${SUGGEST_INSTRUCTION}\n\n${JSON.stringify(payload)}` }],
    schema: SUGGEST_SCHEMA,
    maxTokens: 1200,
    deadlineMs: 45000,
    userId: user.id,
  });

  const produced = [];

  for (const s of result.suggestions || []) {
    const clientId = randomUUID();
    const dedupKey = dedupKeyFor(s.title);
    const rows = await sql`
      insert into suggestions (user_id, client_id, local_day, kind, title, detail, draft_text, evidence, urgency, confidence, dedup_key)
      values (${user.id}, ${clientId}, ${day}, ${s.kind}, ${s.title}, ${s.detail}, ${s.draft_text || null}, ${JSON.stringify(s.evidence || [])}, ${s.urgency}, ${s.confidence}, ${dedupKey})
      on conflict (user_id, dedup_key, local_day) do nothing
      returning client_id, kind, title, detail, draft_text, evidence, urgency, confidence
    `;
    if (rows.length > 0) produced.push(rows[0]);
  }

  return json({
    suggestions: produced.map((r) => ({
      clientId: r.client_id,
      kind: r.kind,
      title: r.title,
      detail: r.detail,
      draftText: r.draft_text,
      evidence: r.evidence,
      urgency: r.urgency,
      confidence: r.confidence,
    })),
  });
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

  const day = query(request).get("day");
  if (!day) return json({ error: "day required" }, 400);

  const rows = await sql`
    select client_id, ts, kind, title, detail, draft_text, evidence, urgency, confidence, status
    from suggestions where user_id = ${user.id} and local_day = ${day}
    order by ts desc limit 100
  `;
  return json({
    suggestions: rows.map((r) => ({
      clientId: r.client_id,
      ts: r.ts,
      kind: r.kind,
      title: r.title,
      detail: r.detail,
      draftText: r.draft_text,
      evidence: r.evidence,
      urgency: r.urgency,
      confidence: r.confidence,
      status: r.status,
    })),
  });
}
