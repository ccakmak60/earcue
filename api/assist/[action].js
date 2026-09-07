import { randomUUID, createHash } from "node:crypto";
import { sql } from "../_lib/db.js";
import { requireUser, touchTz, Unauthorized } from "../_lib/auth.js";
import { assertEntitled, PaymentRequired } from "../_lib/entitlement.js";
import { consume, QuotaExceeded } from "../_lib/quota.js";
import { callInteraction, getInteraction, parseJsonOutput, mintAuthToken } from "../_lib/gemini.js";
import { env } from "../_lib/env.js";

async function requireAuthed(req, res, { entitled }) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof Unauthorized) {
      res.status(401).json({ error: "unauthorized" });
      return null;
    }
    throw e;
  }
  if (entitled) {
    try {
      assertEntitled(user);
    } catch (e) {
      if (e instanceof PaymentRequired) {
        res.status(402).json({ error: "payment_required" });
        return null;
      }
      throw e;
    }
  }
  return user;
}

async function handleLiveToken(req, res) {
  const user = await requireAuthed(req, res, { entitled: true });
  if (!user) return;
  try {
    await consume(user, "live_seconds", 1800);
  } catch (e) {
    if (e instanceof QuotaExceeded) return res.status(429).json({ error: "quota", metric: e.metric });
    throw e;
  }
  const model = env.MODEL_LIVE;
  const wsUrl = env.GEMINI_LIVE_WS_URL;
  const now = Date.now();
  const body = {
    uses: 1,
    expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
    newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
    liveConnectConstraints: {
      model,
      config: { sessionResumption: {}, responseModalities: ["AUDIO"] },
    },
  };
  let json;
  try {
    json = await mintAuthToken(body);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
  res.status(200).json({ token: json.name, model, wsUrl });
}

// ---------- meeting notes ----------

const MEETING_SCHEMA = {
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
  "You are writing notes for one meeting, given a timestamped trace of what was said (speaker labels are chunk-local and not stable across the meeting \u2014 never claim cross-chunk speaker identity) and what was on the user's screen. " +
  "Name owners only when someone explicitly took the item. followup_message is a short message the user could send as-is. Empty arrays are correct when the meeting contained no decisions or actions.";

function fmtHHMM(ts, tz) {
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz });
}

function renderTrace(rows, tz) {
  return rows
    .map((r) => {
      const time = fmtHHMM(r.ts, tz);
      const tag = [r.kind, r.source, r.speaker].filter(Boolean).join("/");
      let text = r.text;
      if (r.kind === "screen" && r.meta) {
        const extra = [r.meta.app, r.meta.salient_text].filter(Boolean).join(" | ");
        if (extra) text += ` (${extra})`;
      }
      return `${time} [${tag}] ${text}`;
    })
    .join("\n");
}

async function handleMeetingOpen(req, res) {
  const user = await requireAuthed(req, res, { entitled: true });
  if (!user) return;

  const { clientId, startedAt, localDay, source } = req.body || {};
  if (!clientId || !startedAt || !localDay || !source) {
    return res.status(400).json({ error: "clientId, startedAt, localDay, source required" });
  }

  await sql`
    insert into meetings (user_id, client_id, started_at, local_day, source)
    values (${user.id}, ${clientId}, ${startedAt}, ${localDay}, ${source})
    on conflict (user_id, client_id) do nothing
  `;
  const [row] = await sql`select id from meetings where user_id = ${user.id} and client_id = ${clientId}`;
  res.status(200).json({ id: row.id });
}

async function handleMeetingClose(req, res) {
  const user = await requireAuthed(req, res, { entitled: true });
  if (!user) return;

  const { id, endedAt } = req.body || {};
  if (!id || !endedAt) return res.status(400).json({ error: "id, endedAt required" });

  const [meeting] = await sql`select * from meetings where id = ${id} and user_id = ${user.id}`;
  if (!meeting) return res.status(404).json({ error: "not found" });

  await sql`update meetings set ended_at = ${endedAt}, updated_at = now() where id = ${id} and user_id = ${user.id}`;

  const durationMs = new Date(endedAt).getTime() - new Date(meeting.started_at).getTime();
  const traceRows = await sql`
    select ts, kind, source, speaker, text, meta from traces
    where user_id = ${user.id} and ts >= ${meeting.started_at} and ts <= ${endedAt}
    order by ts asc
  `;

  if (durationMs < 60000 || traceRows.length === 0) {
    await sql`update meetings set notes_status = 'none', updated_at = now() where id = ${id} and user_id = ${user.id}`;
    return res.status(200).json({ notesStatus: "none" });
  }

  try {
    await consume(user, "assist_calls", 1);
  } catch (e) {
    if (e instanceof QuotaExceeded) {
      await sql`update meetings set notes_status = 'none', updated_at = now() where id = ${id} and user_id = ${user.id}`;
      return res.status(429).json({ error: "quota", metric: e.metric });
    }
    throw e;
  }

  const rendered = renderTrace(traceRows, user.tz);
  const interaction = await callInteraction({
    model: env.MODEL_REASON,
    background: true,
    input: [{ type: "text", text: `${MEETING_INSTRUCTION}\n\n${rendered}` }],
    response_format: { type: "text", mime_type: "application/json", schema: MEETING_SCHEMA },
  });

  await sql`
    update meetings set notes_status = 'in_progress', notes_interaction_id = ${interaction.id}, updated_at = now()
    where id = ${id} and user_id = ${user.id}
  `;
  res.status(200).json({ notesStatus: "in_progress" });
}

async function handleMeetingsGet(req, res) {
  const user = await requireAuthed(req, res, { entitled: false });
  if (!user) return;

  const day = req.query.day;
  if (!day) return res.status(400).json({ error: "day required" });

  const rows = await sql`
    select id, client_id, started_at, ended_at, source, title, notes, notes_status, notes_interaction_id, error
    from meetings where user_id = ${user.id} and local_day = ${day} order by started_at desc
  `;

  const settled = [];
  for (const row of rows) {
    if (row.notes_status !== "in_progress" || !row.notes_interaction_id) {
      settled.push(row);
      continue;
    }
    const interaction = await getInteraction(row.notes_interaction_id);
    if (interaction.status === "completed") {
      const notes = parseJsonOutput(interaction);
      await sql`
        update meetings set notes_status = 'completed', notes = ${notes}, title = ${notes.title}, updated_at = now()
        where id = ${row.id} and user_id = ${user.id}
      `;
      settled.push({ ...row, notes_status: "completed", notes, title: notes.title });
    } else if (interaction.status === "failed" || interaction.status === "cancelled") {
      const error = interaction.error ? JSON.stringify(interaction.error) : interaction.status;
      await sql`
        update meetings set notes_status = 'failed', error = ${error}, updated_at = now()
        where id = ${row.id} and user_id = ${user.id}
      `;
      settled.push({ ...row, notes_status: "failed", error });
    } else {
      settled.push(row);
    }
  }

  res.status(200).json({
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

// ---------- proactive suggestions ----------

const SUGGEST_SCHEMA = {
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
  "You are a proactive assistant watching one person work. You get the last 15 minutes of their screen and speech, their connected calendar/email/Slack context, any meeting in progress, and the titles of suggestions already made today. " +
  "Emit at most two suggestions, and only when they beat silence: idea for a concrete next move on the task in front of them, mistake when the screen or speech contradicts their own context (wrong figure, wrong recipient, missed constraint), draft when a message, reply, or pitch is clearly owed \u2014 put the full sendable text in draft_text, reminder for a commitment or meeting about to lapse, answer for a question they just asked out loud that the context answers. " +
  "Every evidence entry must quote a specific HH:MM trace line or a context title you were given. Never repeat a title from `already`. An empty array is the common case.";

function localDay(tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC" }).format(new Date());
}

function dedupKeyFor(title) {
  const normalized = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

async function handleSuggest(req, res) {
  const user = await requireAuthed(req, res, { entitled: true });
  if (!user) return;

  const { tz } = req.body || {};
  await touchTz(user.id, tz);

  try {
    await consume(user, "assist_calls", 1);
  } catch (e) {
    if (e instanceof QuotaExceeded) return res.status(429).json({ error: "quota", metric: e.metric });
    throw e;
  }

  const recent = await sql`
    select ts, kind, source, speaker, text, meta from traces
    where user_id = ${user.id} and ts > now() - interval '15 minutes'
    order by ts asc limit 80
  `;
  if (recent.length === 0) return res.status(200).json({ suggestions: [] });

  const focus = recent
    .slice(-5)
    .map((r) => r.text)
    .join(" ")
    .slice(0, 400);

  const contextMatches = focus
    ? await sql`
        select provider, kind, title, body, url, ts from context_items
        where user_id = ${user.id} and body_tsv @@ plainto_tsquery('english', ${focus})
        order by ts desc limit 8
      `
    : [];

  const calendar = await sql`
    select provider, kind, title, body, url, ts from context_items
    where user_id = ${user.id} and kind = 'event' and ts between now() - interval '2 hours' and now() + interval '12 hours'
    order by ts asc limit 5
  `;

  const inbox = await sql`
    select provider, kind, title, body, url, ts from context_items
    where user_id = ${user.id} and kind in ('email', 'message') and ts > now() - interval '6 hours'
    order by ts desc limit 10
  `;

  const [meeting] = await sql`
    select id, started_at, source from meetings where user_id = ${user.id} and ended_at is null
    order by started_at desc limit 1
  `;

  const day = localDay(user.tz);
  const already = await sql`
    select title from suggestions where user_id = ${user.id} and local_day = ${day} order by ts desc limit 20
  `;

  const payload = {
    recent,
    focus_context: contextMatches,
    calendar,
    inbox,
    meeting: meeting || null,
    already: already.map((r) => r.title),
  };

  const interaction = await callInteraction({
    model: env.MODEL_REASON,
    store: false,
    input: [{ type: "text", text: `${SUGGEST_INSTRUCTION}\n\n${JSON.stringify(payload)}` }],
    response_format: { type: "text", mime_type: "application/json", schema: SUGGEST_SCHEMA },
  });

  const result = parseJsonOutput(interaction);
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

  res.status(200).json({
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

async function handleFeedback(req, res) {
  const user = await requireAuthed(req, res, { entitled: false });
  if (!user) return;

  const { clientId, status } = req.body || {};
  if (!["shown", "accepted", "dismissed"].includes(status)) return res.status(400).json({ error: "bad status" });
  if (!clientId) return res.status(400).json({ error: "clientId required" });

  await sql`update suggestions set status = ${status} where user_id = ${user.id} and client_id = ${clientId}`;
  res.status(200).json({ ok: true });
}

async function handleSuggestionsGet(req, res) {
  const user = await requireAuthed(req, res, { entitled: false });
  if (!user) return;

  const day = req.query.day;
  if (!day) return res.status(400).json({ error: "day required" });

  const rows = await sql`
    select client_id, ts, kind, title, detail, draft_text, evidence, urgency, confidence, status
    from suggestions where user_id = ${user.id} and local_day = ${day}
    order by ts desc limit 100
  `;
  res.status(200).json({
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

export default async function handler(req, res) {
  const action = req.query.action;
  if (action === "meeting-open" && req.method === "POST") return handleMeetingOpen(req, res);
  if (action === "meeting-close" && req.method === "POST") return handleMeetingClose(req, res);
  if (action === "meetings" && req.method === "GET") return handleMeetingsGet(req, res);
  if (action === "suggest" && req.method === "POST") return handleSuggest(req, res);
  if (action === "feedback" && req.method === "POST") return handleFeedback(req, res);
  if (action === "live-token" && req.method === "POST") return handleLiveToken(req, res);
  return res.status(404).json({ error: "not found" });
}
