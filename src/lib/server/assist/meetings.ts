import "server-only";
import { requireAuthed } from "../auth";
import { sql } from "../db";
import { env } from "../env";
import { QuotaExceeded } from "../errors";
import { insertContextItems } from "../knowledge";
import { logError } from "../log";
import { chatJson, type JsonSchema } from "../llm";
import { consume } from "../quota";
import { json, query, readJson } from "../respond";
import { renderTrace, type TraceRecord } from "../review";

// ---------- meeting notes ----------

const MEETING_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    participants: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    decisions: { type: "array", items: { type: "string" } },
    action_items: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, owner: { type: "string" }, due: { type: "string" } },
        required: ["text", "owner"],
      },
    },
    open_questions: { type: "array", items: { type: "string" } },
    followup_message: { type: "string" },
  },
  required: ["title", "participants", "summary", "decisions", "action_items", "open_questions", "followup_message"],
};

const MEETING_INSTRUCTION =
  "You are writing notes for one meeting, given a timestamped trace of what was said (speaker labels are chunk-local and not stable across the meeting — never claim cross-chunk speaker identity) and what was on the user's screen. " +
  "Name owners only when someone explicitly took the item. followup_message is a short message the user could send as-is. Empty arrays are correct when the meeting contained no decisions or actions.";

interface MeetingNotes {
  title: string;
  participants?: string[];
  summary?: string;
  decisions?: string[];
  action_items?: { text: string; owner: string; due?: string }[];
}

export async function handleMeetingOpen(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true });

  const { clientId, startedAt, localDay, source } = await readJson(request);
  if (!clientId || !startedAt || !localDay || !source) {
    return json({ error: "clientId, startedAt, localDay, source required" }, 400);
  }

  await sql`
    insert into meetings (user_id, client_id, started_at, local_day, source)
    values (${user.id}, ${clientId}, ${startedAt}, ${localDay}, ${source})
    on conflict (user_id, client_id) do nothing
  `;
  const [row] = await sql`select id from meetings where user_id = ${user.id} and client_id = ${clientId}`;
  return json({ id: row.id });
}

export async function handleMeetingClose(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true });

  const { id, endedAt } = await readJson(request);
  if (!id || !endedAt) return json({ error: "id, endedAt required" }, 400);

  const [meeting] = await sql`select * from meetings where id = ${id} and user_id = ${user.id}`;
  if (!meeting) return json({ error: "not found" }, 404);

  await sql`update meetings set ended_at = ${endedAt}, updated_at = now() where id = ${id} and user_id = ${user.id}`;

  const durationMs = new Date(endedAt).getTime() - new Date(meeting.started_at).getTime();
  const traceRows = (await sql`
    select ts, kind, source, speaker, text, meta from traces
    where user_id = ${user.id} and ts >= ${meeting.started_at} and ts <= ${endedAt}
    order by ts asc
  `) as TraceRecord[];

  if (durationMs < 60000 || traceRows.length === 0) {
    await sql`update meetings set notes_status = 'none', updated_at = now() where id = ${id} and user_id = ${user.id}`;
    return json({ notesStatus: "none" });
  }

  try {
    await consume(user, "assist_calls", 1);
  } catch (e) {
    if (e instanceof QuotaExceeded) {
      await sql`update meetings set notes_status = 'none', updated_at = now() where id = ${id} and user_id = ${user.id}`;
    }
    throw e;
  }

  const rendered = renderTrace(traceRows, user.tz);

  await sql`
    update meetings set notes_status = 'in_progress', updated_at = now()
    where id = ${id} and user_id = ${user.id}
  `;

  try {
    const notes = await chatJson<MeetingNotes>({
      model: env.MODEL_REASON,
      messages: [{ role: "user", content: `${MEETING_INSTRUCTION}\n\n${rendered}` }],
      schema: MEETING_SCHEMA,
      maxTokens: 2000,
      deadlineMs: 45000,
      userId: user.id,
    });
    await sql`
      update meetings set notes_status = 'completed', notes = ${notes}, title = ${notes.title}, updated_at = now()
      where id = ${id} and user_id = ${user.id}
    `;
    try {
      await insertContextItems(user.id, "earcue", null, [
        {
          externalId: `mtg:${id}`,
          ts: meeting.started_at,
          kind: "doc",
          title: notes.title,
          body: [notes.summary, ...(notes.decisions || []), ...(notes.action_items || []).map((a) => `${a.text} (${a.owner})`)]
            .filter(Boolean)
            .join(" — ")
            .slice(0, 4000),
          url: null,
          meta: { meetingId: id, participants: notes.participants || [] },
        },
      ]);
    } catch (err) {
      logError("meeting_note_context_failed", err, { userId: user.id, meetingId: id });
    }
    return json({ notesStatus: "completed", notes });
  } catch (err) {
    const message = (err as Error).message;
    await sql`
      update meetings set notes_status = 'failed', error = ${message}, updated_at = now()
      where id = ${id} and user_id = ${user.id}
    `;
    return json({ notesStatus: "failed", error: message });
  }
}

export async function handleMeetingsGet(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);

  const day = query(request).get("day");
  if (!day) return json({ error: "day required" }, 400);

  const rows = await sql`
    select id, client_id, started_at, ended_at, source, title, notes, notes_status, updated_at, error
    from meetings where user_id = ${user.id} and local_day = ${day} order by started_at desc
  `;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const settled: Record<string, any>[] = [];
  for (const row of rows) {
    if (row.notes_status === "in_progress" && Date.now() - new Date(row.updated_at).getTime() > 90000) {
      const error = "generation timed out";
      await sql`
        update meetings set notes_status = 'failed', error = ${error}, updated_at = now()
        where id = ${row.id} and user_id = ${user.id}
      `;
      settled.push({ ...row, notes_status: "failed", error });
    } else {
      settled.push(row);
    }
  }

  return json({
    meetings: settled.map((m) => ({
      id: m.id,
      clientId: m.client_id,
      startedAt: m.started_at,
      endedAt: m.ended_at,
      source: m.source,
      title: m.title,
      notesStatus: m.notes_status,
      notes: m.notes,
      error: m.error,
    })),
  });
}
