import { randomBytes } from "node:crypto";
import { sql } from "../_lib/db.js";
import { requireUser, requireIngestUser, hashKey, Unauthorized } from "../_lib/auth.js";
import { assertEntitled, PaymentRequired } from "../_lib/entitlement.js";
import { consume, QuotaExceeded } from "../_lib/quota.js";
import { env } from "../_lib/env.js";
import {
  IMPORT_SOURCES,
  normalizeBrowserRows,
  normalizeItems,
  insertContextItems,
  profileFor,
  runDistillPass,
} from "../_lib/knowledge.js";
import { ensureFreshToken, DisconnectedError } from "../_lib/connectors.js";
import { logError } from "../_lib/log.js";

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

// ---------- imports / memories / profile / excludes ----------

async function handleImports(req, res) {
  const user = await requireAuthed(req, res, { entitled: false });
  if (!user) return;

  const imports = await sql`
    select id, source, label, status, items_ingested, items_skipped, created_at, updated_at, error
    from imports where user_id = ${user.id} order by created_at desc
  `;
  const [memCount] = await sql`select count(*)::int as n from memories where user_id = ${user.id} and superseded_by is null`;
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
    profile: profile ? { summary: profile.summary, builtAt: profile.builtAt } : { summary: "", builtAt: null },
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
  const rows = await sql`
    select id, kind, subject, text, importance, last_seen_at from memories
    where user_id = ${user.id} and superseded_by is null
    order by last_seen_at desc limit ${limit}
  `;
  res.status(200).json({
    memories: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      subject: r.subject,
      text: r.text,
      importance: r.importance,
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
  res.status(200).json(profile || { summary: "", sections: {}, builtAt: null });
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

export default async function handler(req, res) {
  const action = req.query.action;

  if (CORS_ACTIONS.has(action)) {
    applyCors(res);
    if (req.method === "OPTIONS") return res.status(204).end();
  }

  if (action === "imports" && req.method === "GET") return handleImports(req, res);
  if (action === "begin" && req.method === "POST") return handleBegin(req, res);
  if (action === "browser" && req.method === "POST") return handleBrowser(req, res);
  if (action === "items" && req.method === "POST") return handleItems(req, res);
  if (action === "finish" && req.method === "POST") return handleFinish(req, res);
  if (action === "remove" && req.method === "POST") return handleRemove(req, res);
  if (action === "gmail-backfill" && req.method === "POST") return handleGmailBackfill(req, res);
  if (action === "distill" && req.method === "POST") return handleDistill(req, res);
  if (action === "memories" && req.method === "GET") return handleMemories(req, res);
  if (action === "forget" && req.method === "POST") return handleForget(req, res);
  if (action === "profile" && req.method === "GET") return handleProfile(req, res);
  if (action === "token" && req.method === "POST") return handleToken(req, res);
  if (action === "token-revoke" && req.method === "POST") return handleTokenRevoke(req, res);
  if (action === "excludes" && req.method === "POST") return handleExcludes(req, res);
  return res.status(404).json({ error: "not found" });
}
