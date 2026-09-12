import { randomUUID, randomBytes, createHash } from "node:crypto";
import { sql } from "../_lib/db.js";
import { requireUser, requireIngestUser, touchTz, hashKey, Unauthorized } from "../_lib/auth.js";
import { assertEntitled, PaymentRequired } from "../_lib/entitlement.js";
import { consume, QuotaExceeded } from "../_lib/quota.js";
import { chatJson } from "../_lib/nim.js";
import { env } from "../_lib/env.js";
import {
  IMPORT_SOURCES,
  normalizeBrowserRows,
  normalizeItems,
  insertContextItems,
  profileFor,
  runDistillPass,
  recall,
  containersFor,
  addManualMemory,
  normalizeContainer,
} from "../_lib/knowledge.js";
import { ensureFreshToken, DisconnectedError } from "../_lib/connectors.js";
import { sessionNameFor, chatsOverview, chatMessages, normalizeWahaMessage } from "../_lib/waha.js";
import { logError } from "../_lib/log.js";

// Merged with the former api/knowledge/[action].js: Vercel's Hobby plan caps a
// deployment at 12 Serverless Functions, so the knowledge-base actions (imports,
// memories, profile, connector backfill, distillation) share this route and its
// requireAuthed/[action] dispatch instead of a second endpoint.

const CORS_ACTIONS = new Set(["begin", "browser", "finish"]);

function applyCors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  res.setHeader("access-control-max-age", "86400");
}

async function requireAuthed(req, res, { entitled, allowToken }) {
  let user;
  try {
    if (allowToken && /^Bearer\s+/.test(req.headers.authorization || "")) {
      user = await requireIngestUser(req);
    } else {
      user = await requireUser(req);
    }
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

  await sql`
    update meetings set notes_status = 'in_progress', updated_at = now()
    where id = ${id} and user_id = ${user.id}
  `;

  try {
    const notes = await chatJson({
      model: env.MODEL_REASON,
      messages: [{ role: "user", content: `${MEETING_INSTRUCTION}\n\n${rendered}` }],
      schema: MEETING_SCHEMA,
      maxTokens: 2000,
      deadlineMs: 45000,
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
            .join(" \u2014 ")
            .slice(0, 4000),
          url: null,
          meta: { meetingId: id, participants: notes.participants || [] },
        },
      ]);
    } catch (err) {
      logError("meeting_note_context_failed", err, { userId: user.id, meetingId: id });
    }
    res.status(200).json({ notesStatus: "completed", notes });
  } catch (err) {
    await sql`
      update meetings set notes_status = 'failed', error = ${err.message}, updated_at = now()
      where id = ${id} and user_id = ${user.id}
    `;
    res.status(200).json({ notesStatus: "failed", error: err.message });
  }
}

async function handleMeetingsGet(req, res) {
  const user = await requireAuthed(req, res, { entitled: false });
  if (!user) return;

  const day = req.query.day;
  if (!day) return res.status(400).json({ error: "day required" });

  const rows = await sql`
    select id, client_id, started_at, ended_at, source, title, notes, notes_status, updated_at, error
    from meetings where user_id = ${user.id} and local_day = ${day} order by started_at desc
  `;

  const settled = [];
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
  "You are a proactive assistant watching one person work. You get the last 15 minutes of their screen and speech, any meeting in progress, their profile and stored memories, and the titles of suggestions already made today. " +
  "Emit at most two suggestions, and only when they beat silence: idea for a concrete next move on the task in front of them, mistake when the screen or speech contradicts their own context (wrong figure, wrong recipient, missed constraint), draft when a message, reply, or pitch is clearly owed \u2014 put the full sendable text in draft_text, reminder for a commitment or meeting about to lapse, answer for a question they just asked out loud that the context answers. " +
  "Every evidence entry must quote a specific HH:MM trace line or a context title you were given. Never repeat a title from `already`. An empty array is the common case. " +
  "`profile` and `memories` are durable facts distilled from this person's own archive \u2014 imported browsing, bookmarks, chats, and mail. Use them to judge what is worth saying, to catch " +
  "contradictions with what they have previously decided, and to address people and projects by their real names. " +
  "Never present a memory back to them as news, and never cite a memory as evidence unless the current screen or " +
  "speech touches it. In briefing mode there may be no recent activity at all: then suggest from calendar, inbox, and " +
  "memories only. `profile_static` are facts that are always true about them; `profile_dynamic` is what they are working on right now.";

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

  const { tz, mode } = req.body || {};
  const briefing = mode === "briefing";
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
  if (!briefing && recent.length === 0) return res.status(200).json({ suggestions: [] });

  const profileRow = await profileFor(user.id);
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

  const result = await chatJson({
    model: env.MODEL_REASON,
    messages: [{ role: "user", content: `${SUGGEST_INSTRUCTION}\n\n${JSON.stringify(payload)}` }],
    schema: SUGGEST_SCHEMA,
    maxTokens: 1200,
    deadlineMs: 45000,
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

// ---------- imports / memories / profile / excludes ----------

async function handleImports(req, res) {
  const user = await requireAuthed(req, res, { entitled: false });
  if (!user) return;

  const imports = await sql`
    select id, source, label, status, items_ingested, items_skipped, created_at, updated_at, error
    from imports where user_id = ${user.id} order by created_at desc
  `;
  const [memCount] = await sql`select count(*)::int as n from memories where user_id = ${user.id} and superseded_by is null and forgotten_at is null`;
  const profile = await profileFor(user.id);
  const tokens = await sql`
    select label, created_at, last_used_at from ingest_tokens
    where user_id = ${user.id} and revoked_at is null order by created_at desc
  `;
  const [userRow] = await sql`select excluded_domains from users where id = ${user.id}`;

  res.status(200).json({
    imports: imports.map((i) => ({
      id: i.id,
      source: i.source,
      label: i.label,
      status: i.status,
      itemsIngested: i.items_ingested,
      itemsSkipped: i.items_skipped,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      error: i.error,
    })),
    memoryCount: memCount.n,
    profile: profile
      ? { summary: profile.summary, static: profile.static, dynamic: profile.dynamic, builtAt: profile.builtAt }
      : { summary: "", static: [], dynamic: [], builtAt: null },
    tokens: tokens.map((t) => ({ label: t.label, createdAt: t.created_at, lastUsedAt: t.last_used_at })),
    excludedDomains: userRow.excluded_domains,
  });
}

async function handleBegin(req, res) {
  const user = await requireAuthed(req, res, { entitled: true, allowToken: true });
  if (!user) return;

  const { source, label } = req.body || {};
  if (!IMPORT_SOURCES[source]) return res.status(400).json({ error: "bad source" });

  const [row] = await sql`
    insert into imports (user_id, source, label) values (${user.id}, ${source}, ${label || ""})
    returning id
  `;
  res.status(200).json({ importId: row.id });
}

async function handleBrowser(req, res) {
  const user = await requireAuthed(req, res, { entitled: true, allowToken: true });
  if (!user) return;

  const { importId, kind, rows } = req.body || {};
  if (!importId || (kind !== "history" && kind !== "bookmarks") || !Array.isArray(rows)) {
    return res.status(400).json({ error: "importId, kind, rows required" });
  }
  if (rows.length > 500) return res.status(400).json({ error: "batch too large" });

  const [importRow] = await sql`select id from imports where id = ${importId} and user_id = ${user.id}`;
  if (!importRow) return res.status(404).json({ error: "import not found" });

  const [userRow] = await sql`select excluded_domains from users where id = ${user.id}`;
  const { items, skipped } = normalizeBrowserRows(rows, { kind, excludedDomains: userRow.excluded_domains });

  try {
    if (items.length > 0) await consume(user, "import_items", items.length);
  } catch (e) {
    if (e instanceof QuotaExceeded) {
      await sql`update imports set status = 'failed', error = 'quota', updated_at = now() where id = ${importId}`;
      return res.status(429).json({ error: "quota", metric: e.metric });
    }
    throw e;
  }

  const ingested = await insertContextItems(user.id, "browser", importId, items);
  await sql`
    update imports set items_ingested = items_ingested + ${ingested}, items_skipped = items_skipped + ${skipped}, updated_at = now()
    where id = ${importId}
  `;
  res.status(200).json({ ingested, skipped });
}

async function handleItems(req, res) {
  const user = await requireAuthed(req, res, { entitled: true });
  if (!user) return;

  const { importId, items: rawItems } = req.body || {};
  if (!importId || !Array.isArray(rawItems)) return res.status(400).json({ error: "importId, items required" });
  if (rawItems.length > 500) return res.status(400).json({ error: "batch too large" });

  const [importRow] = await sql`select id, source from imports where id = ${importId} and user_id = ${user.id}`;
  if (!importRow) return res.status(404).json({ error: "import not found" });

  const { items, skipped } = normalizeItems(rawItems);
  const provider = (IMPORT_SOURCES[importRow.source] || {}).provider || "upload";

  try {
    if (items.length > 0) await consume(user, "import_items", items.length);
  } catch (e) {
    if (e instanceof QuotaExceeded) {
      await sql`update imports set status = 'failed', error = 'quota', updated_at = now() where id = ${importId}`;
      return res.status(429).json({ error: "quota", metric: e.metric });
    }
    throw e;
  }

  const ingested = await insertContextItems(user.id, provider, importId, items);
  await sql`
    update imports set items_ingested = items_ingested + ${ingested}, items_skipped = items_skipped + ${skipped}, updated_at = now()
    where id = ${importId}
  `;
  res.status(200).json({ ingested, skipped });
}

async function handleFinish(req, res) {
  const user = await requireAuthed(req, res, { entitled: true, allowToken: true });
  if (!user) return;

  const { importId, status } = req.body || {};
  if (!importId || (status !== "complete" && status !== "failed")) {
    return res.status(400).json({ error: "importId, status required" });
  }

  const [row] = await sql`
    update imports set status = ${status}, updated_at = now() where id = ${importId} and user_id = ${user.id}
    returning items_ingested
  `;
  if (!row) return res.status(404).json({ error: "import not found" });
  res.status(200).json({ ingested: row.items_ingested });
}

async function handleRemove(req, res) {
  const user = await requireAuthed(req, res, { entitled: true });
  if (!user) return;

  const { importId } = req.body || {};
  if (!importId) return res.status(400).json({ error: "importId required" });

  await sql`delete from imports where id = ${importId} and user_id = ${user.id}`;
  res.status(200).json({ removed: true });
}

async function handleGmailBackfill(req, res) {
  const user = await requireAuthed(req, res, { entitled: true });
  if (!user) return;

  const [conn] = await sql`select * from connections where user_id = ${user.id} and provider = 'google'`;
  if (!conn) return res.status(400).json({ error: "google not connected" });

  const days = Math.min(730, Math.max(1, Number((req.body || {}).days) || Number(env.IMPORT_LOOKBACK_DAYS)));

  let [importRow] = await sql`
    select id, cursor from imports where user_id = ${user.id} and source = 'gmail_backfill' and status = 'running'
    order by id desc limit 1
  `;
  if (!importRow) {
    [importRow] = await sql`
      insert into imports (user_id, source, label) values (${user.id}, 'gmail_backfill', 'Gmail backfill')
      returning id, cursor
    `;
  }
  const importId = importRow.id;
  let pageToken = importRow.cursor || undefined;

  const deadline = Date.now() + 45000;
  let totalIngested = 0;
  let done = false;

  try {
    while (Date.now() < deadline) {
      const accessToken = await ensureFreshToken(user.id, conn);
      const headers = { authorization: `Bearer ${accessToken}` };
      const params = new URLSearchParams({ maxResults: "100", q: `newer_than:${days}d` });
      if (pageToken) params.set("pageToken", pageToken);

      const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`, { headers });
      if (listRes.status === 401) throw new DisconnectedError("google");
      if (!listRes.ok) throw new Error(`gmail list ${listRes.status}: ${await listRes.text()}`);
      const listJson = await listRes.json();
      const messages = listJson.messages || [];

      const items = [];
      for (let i = 0; i < messages.length; i += 10) {
        const group = messages.slice(i, i + 10);
        const fetched = await Promise.all(
          group.map((m) =>
            fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
              { headers }
            ).then((r) => (r.ok ? r.json() : null))
          )
        );
        for (const msg of fetched) {
          if (!msg) continue;
          const headersList = msg.payload?.headers || [];
          const subject = headersList.find((h) => h.name === "Subject")?.value || "(no subject)";
          const from = headersList.find((h) => h.name === "From")?.value || "";
          items.push({
            externalId: `gm:${msg.id}`,
            ts: new Date(Number(msg.internalDate)).toISOString(),
            kind: "email",
            title: subject,
            body: msg.snippet || "",
            url: `https://mail.google.com/mail/u/0/#all/${msg.threadId}`,
            meta: { from, threadId: msg.threadId },
          });
        }
      }

      try {
        if (items.length > 0) await consume(user, "import_items", items.length);
      } catch (e) {
        if (e instanceof QuotaExceeded) {
          return res.status(429).json({ error: "quota", metric: e.metric });
        }
        throw e;
      }

      const ingested = await insertContextItems(user.id, "google", importId, items);
      totalIngested += ingested;

      pageToken = listJson.nextPageToken;
      await sql`
        update imports set items_ingested = items_ingested + ${ingested}, cursor = ${pageToken || null}, updated_at = now()
        where id = ${importId}
      `;

      if (!pageToken) {
        done = true;
        await sql`update imports set status = 'complete', updated_at = now() where id = ${importId}`;
        break;
      }
    }
  } catch (err) {
    if (err instanceof DisconnectedError) {
      await sql`delete from connections where user_id = ${user.id} and provider = 'google'`;
      logError("knowledge_gmail_backfill_disconnected", err, { userId: user.id });
      return res.status(400).json({ error: "disconnected" });
    }
    throw err;
  }

  res.status(200).json({ ingested: totalIngested, done, remainingPages: done ? 0 : 1 });
}

async function handleWhatsappBackfill(req, res) {
  const user = await requireAuthed(req, res, { entitled: true });
  if (!user) return;

  const [conn] = await sql`select scope from connections where user_id = ${user.id} and provider = 'whatsapp'`;
  if (!conn) return res.status(400).json({ error: "whatsapp not connected" });
  const sessionName = conn.scope || sessionNameFor(user.id);

  const days = Math.min(730, Math.max(1, Number((req.body || {}).days) || Number(env.IMPORT_LOOKBACK_DAYS)));
  const sinceSeconds = Math.floor(Date.now() / 1000) - days * 86400;

  // cursor = index of the next chat to walk, so a second call resumes where the deadline cut off.
  let [importRow] = await sql`
    select id, cursor from imports where user_id = ${user.id} and source = 'whatsapp_waha' and status = 'running'
    order by id desc limit 1
  `;
  if (!importRow) {
    [importRow] = await sql`
      insert into imports (user_id, source, label) values (${user.id}, 'whatsapp_waha', 'WhatsApp backfill')
      returning id, cursor
    `;
  }
  const importId = importRow.id;
  let chatIndex = Number(importRow.cursor) || 0;

  const deadline = Date.now() + 45000;
  let totalIngested = 0;
  let done = false;

  try {
    const chats = await chatsOverview(sessionName, 100);
    while (chatIndex < chats.length && Date.now() < deadline) {
      const chat = chats[chatIndex];
      const items = [];
      for (let offset = 0; offset < 500; offset += 100) {
        const msgs = await chatMessages(sessionName, chat.id, sinceSeconds, 100, offset);
        for (const m of msgs) {
          const item = normalizeWahaMessage(m, chat.name);
          if (item) items.push(item);
        }
        if (msgs.length < 100) break;
        if (Date.now() > deadline) break;
      }

      if (items.length > 0) {
        try {
          await consume(user, "import_items", items.length);
        } catch (e) {
          if (e instanceof QuotaExceeded) {
            await sql`update imports set status = 'failed', error = 'quota', updated_at = now() where id = ${importId}`;
            return res.status(429).json({ error: "quota", metric: e.metric });
          }
          throw e;
        }
        totalIngested += await insertContextItems(user.id, "whatsapp", importId, items);
      }

      chatIndex++;
      await sql`
        update imports set items_ingested = items_ingested + ${items.length}, cursor = ${String(chatIndex)}, updated_at = now()
        where id = ${importId}
      `;
    }
    if (chatIndex >= chats.length) {
      done = true;
      await sql`update imports set status = 'complete', updated_at = now() where id = ${importId}`;
    }
  } catch (err) {
    const message = String(err.message || err).slice(0, 300);
    await sql`update imports set status = 'failed', error = ${message}, updated_at = now() where id = ${importId}`;
    logError("waha_backfill_failed", err, { userId: user.id });
    return res.status(502).json({ error: "waha_unreachable", detail: message });
  }

  res.status(200).json({ ingested: totalIngested, done });
}

async function handleDistill(req, res) {
  const user = await requireAuthed(req, res, { entitled: true });
  if (!user) return;

  try {
    await consume(user, "distills", 1);
  } catch (e) {
    if (e instanceof QuotaExceeded) return res.status(429).json({ error: "quota", metric: e.metric });
    throw e;
  }

  const result = await runDistillPass(user, Date.now() + 45000);
  res.status(200).json(result);
}

async function handleMemories(req, res) {
  const user = await requireAuthed(req, res, { entitled: false });
  if (!user) return;

  const limit = Math.min(200, Number(req.query.limit) || 200);
  const container = req.query.container ? normalizeContainer(req.query.container) : null;
  const rows = await sql`
    select id, kind, subject, text, container, origin, importance, last_seen_at,
           memory_strength(importance, kind, last_seen_at) as strength
    from memories
    where user_id = ${user.id} and superseded_by is null and forgotten_at is null
      and (${container}::text is null or container = ${container}::text)
    order by last_seen_at desc limit ${limit}
  `;
  res.status(200).json({
    memories: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      subject: r.subject,
      text: r.text,
      container: r.container,
      origin: r.origin,
      importance: r.importance,
      strength: r.strength,
      lastSeenAt: r.last_seen_at,
    })),
  });
}

async function handleForget(req, res) {
  const user = await requireAuthed(req, res, { entitled: false });
  if (!user) return;

  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "id required" });

  await sql`delete from memories where id = ${id} and user_id = ${user.id}`;
  res.status(200).json({ removed: true });
}

async function handleProfile(req, res) {
  const user = await requireAuthed(req, res, { entitled: false });
  if (!user) return;

  const profile = await profileFor(user.id);
  res.status(200).json(profile || { summary: "", static: [], dynamic: [], buckets: {}, builtAt: null });
}

async function handleToken(req, res) {
  const user = await requireAuthed(req, res, { entitled: true });
  if (!user) return;

  const { label } = req.body || {};
  const token = `ec_it_${randomBytes(24).toString("base64url")}`;
  await sql`insert into ingest_tokens (token_hash, user_id, label) values (${hashKey(token)}, ${user.id}, ${label || ""})`;
  res.status(200).json({ token, label: label || "" });
}

async function handleTokenRevoke(req, res) {
  const user = await requireAuthed(req, res, { entitled: false });
  if (!user) return;

  const { label } = req.body || {};
  await sql`update ingest_tokens set revoked_at = now() where user_id = ${user.id} and label = ${label || ""}`;
  res.status(200).json({ revoked: true });
}

async function handleExcludes(req, res) {
  const user = await requireAuthed(req, res, { entitled: false });
  if (!user) return;

  const { domains } = req.body || {};
  const raw = Array.isArray(domains) ? domains.join("\n") : String(domains || "");
  const arr = raw
    .split(/[\n,]/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 200);

  await sql`update users set excluded_domains = ${arr} where id = ${user.id}`;
  res.status(200).json({ excludedDomains: arr });
}

async function handleRecall(req, res) {
  const user = await requireAuthed(req, res, { entitled: false });
  if (!user) return;

  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "q required" });

  try {
    await consume(user, "recalls", 1);
  } catch (e) {
    if (e instanceof QuotaExceeded) return res.status(429).json({ error: "quota", metric: e.metric });
    throw e;
  }

  const limit = Math.min(25, Math.max(1, Number(req.query.limit) || 8));
  const container = req.query.container ? normalizeContainer(req.query.container) : null;
  const rerank = req.query.rerank === "1" && user.plan === "pro";

  const result = await recall(user.id, { query: q, container, limit, includeRelated: true, rerank });
  const profile = await profileFor(user.id);
  res.status(200).json({
    memories: result.memories,
    documents: result.documents,
    related: result.related,
    profile: profile
      ? { summary: profile.summary, static: profile.static, dynamic: profile.dynamic }
      : { summary: "", static: [], dynamic: [] },
  });
}

async function handleContainers(req, res) {
  const user = await requireAuthed(req, res, { entitled: false });
  if (!user) return;
  res.status(200).json({ containers: await containersFor(user.id) });
}

async function handleRemember(req, res) {
  const user = await requireAuthed(req, res, { entitled: true });
  if (!user) return;

  const text = String((req.body || {}).text || "").trim();
  if (text.length < 3 || text.length > 1000) return res.status(400).json({ error: "text must be 3-1000 chars" });

  try {
    await consume(user, "assist_calls", 1);
  } catch (e) {
    if (e instanceof QuotaExceeded) return res.status(429).json({ error: "quota", metric: e.metric });
    throw e;
  }

  const memory = await addManualMemory(user.id, text, (req.body || {}).container || null);
  res.status(200).json({ memory });
}

export default async function handler(req, res) {
  const action = req.query.action;

  if (CORS_ACTIONS.has(action)) {
    applyCors(res);
    if (req.method === "OPTIONS") return res.status(204).end();
  }

  if (action === "meeting-open" && req.method === "POST") return handleMeetingOpen(req, res);
  if (action === "meeting-close" && req.method === "POST") return handleMeetingClose(req, res);
  if (action === "meetings" && req.method === "GET") return handleMeetingsGet(req, res);
  if (action === "suggest" && req.method === "POST") return handleSuggest(req, res);
  if (action === "feedback" && req.method === "POST") return handleFeedback(req, res);
  if (action === "suggestions" && req.method === "GET") return handleSuggestionsGet(req, res);
  if (action === "imports" && req.method === "GET") return handleImports(req, res);
  if (action === "begin" && req.method === "POST") return handleBegin(req, res);
  if (action === "browser" && req.method === "POST") return handleBrowser(req, res);
  if (action === "items" && req.method === "POST") return handleItems(req, res);
  if (action === "finish" && req.method === "POST") return handleFinish(req, res);
  if (action === "remove" && req.method === "POST") return handleRemove(req, res);
  if (action === "gmail-backfill" && req.method === "POST") return handleGmailBackfill(req, res);
  if (action === "whatsapp-backfill" && req.method === "POST") return handleWhatsappBackfill(req, res);
  if (action === "distill" && req.method === "POST") return handleDistill(req, res);
  if (action === "memories" && req.method === "GET") return handleMemories(req, res);
  if (action === "forget" && req.method === "POST") return handleForget(req, res);
  if (action === "profile" && req.method === "GET") return handleProfile(req, res);
  if (action === "recall" && req.method === "GET") return handleRecall(req, res);
  if (action === "containers" && req.method === "GET") return handleContainers(req, res);
  if (action === "remember" && req.method === "POST") return handleRemember(req, res);
  if (action === "token" && req.method === "POST") return handleToken(req, res);
  if (action === "token-revoke" && req.method === "POST") return handleTokenRevoke(req, res);
  if (action === "excludes" && req.method === "POST") return handleExcludes(req, res);
  return res.status(404).json({ error: "not found" });
}
