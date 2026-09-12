import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { sql } from "../_lib/db.js";
import { requireUser, Unauthorized } from "../_lib/auth.js";
import { assertEntitled, PaymentRequired } from "../_lib/entitlement.js";
import { consume, QuotaExceeded } from "../_lib/quota.js";
import { env } from "../_lib/env.js";
import { encryptSecret, decryptSecret } from "../_lib/secretbox.js";
import { authorizeUrl, exchangeCode, ensureFreshToken, fetchItems, DisconnectedError } from "../_lib/connectors.js";
import { effectivePlan } from "../_lib/plans.js";
import { insertContextItems } from "../_lib/knowledge.js";
import { sessionNameFor, ensureSession, getSession, getQr, deleteSession, normalizeWahaMessage } from "../_lib/waha.js";
import { logError } from "../_lib/log.js";

function cookieValue(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

function secureFlag() {
  return env.BETTER_AUTH_URL.startsWith("https") ? "; Secure" : "";
}

function wahaEnabled() {
  return Boolean(env.WAHA_BASE_URL && env.WAHA_API_KEY && env.CONNECTOR_ENC_KEY);
}

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

async function handleList(req, res) {
  const user = await requireAuthed(req, res, { entitled: false });
  if (!user) return;

  const conns = await sql`
    select provider, account_label, scope, last_synced_at, last_error
    from connections where user_id = ${user.id}
  `;
  const counts = await sql`
    select provider, count(*)::int as item_count from context_items where user_id = ${user.id} group by provider
  `;
  const countByProvider = Object.fromEntries(counts.map((c) => [c.provider, c.item_count]));

  res.status(200).json({
    connections: conns.map((c) => ({
      provider: c.provider,
      accountLabel: c.account_label,
      scope: c.scope,
      lastSyncedAt: c.last_synced_at,
      lastError: c.last_error,
      itemCount: countByProvider[c.provider] || 0,
    })),
  });
}

async function handleStart(req, res) {
  const user = await requireAuthed(req, res, { entitled: false });
  if (!user) return;

  const provider = req.query.provider;
  if (provider !== "google" && provider !== "slack") return res.status(400).json({ error: "bad provider" });

  const state = `${provider}.${randomBytes(16).toString("base64url")}`;
  res.setHeader("set-cookie", `ec_oauth=${state}; Path=/api/connect; HttpOnly; SameSite=Lax; Max-Age=600${secureFlag()}`);
  res.writeHead(302, { location: authorizeUrl(provider, state) });
  res.end();
}

async function handleCallback(req, res) {
  const user = await requireAuthed(req, res, { entitled: false });
  if (!user) return;

  const { code, state } = req.query;
  const cookieState = cookieValue(req, "ec_oauth");
  let provider = null;

  try {
    if (!state || !cookieState) throw new Error("missing state");
    const a = Buffer.from(String(state));
    const b = Buffer.from(String(cookieState));
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("state mismatch");
    provider = String(state).split(".")[0];
    if (provider !== "google" && provider !== "slack") throw new Error("bad provider in state");

    const tokens = await exchangeCode(provider, code);
    const accessTokenEnc = encryptSecret(tokens.accessToken);
    const refreshTokenEnc = tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null;

    await sql`
      insert into connections (user_id, provider, account_label, access_token_enc, refresh_token_enc, expires_at, scope)
      values (${user.id}, ${provider}, ${tokens.accountLabel}, ${accessTokenEnc}, ${refreshTokenEnc}, ${tokens.expiresAt}, ${tokens.scope})
      on conflict (user_id, provider) do update set
        account_label = excluded.account_label,
        access_token_enc = excluded.access_token_enc,
        refresh_token_enc = coalesce(excluded.refresh_token_enc, connections.refresh_token_enc),
        expires_at = excluded.expires_at,
        scope = excluded.scope,
        last_error = null
    `;

    res.setHeader("set-cookie", `ec_oauth=; Path=/api/connect; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag()}`);
    res.writeHead(302, { location: `/app?connected=${provider}` });
    res.end();
  } catch (err) {
    logError("connect_exchange_failed", err, { provider });
    res.setHeader("set-cookie", `ec_oauth=; Path=/api/connect; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag()}`);
    res.writeHead(302, { location: `/app?connect_error=${provider || "unknown"}` });
    res.end();
  }
}

async function handleSync(req, res) {
  const user = await requireAuthed(req, res, { entitled: true });
  if (!user) return;

  try {
    await consume(user, "connector_syncs", 1);
  } catch (e) {
    if (e instanceof QuotaExceeded) return res.status(429).json({ error: "quota", metric: e.metric });
    throw e;
  }

  // WhatsApp is not OAuth-polled: live messages arrive on /api/connect/whatsapp-webhook and
  // history comes from /api/assist/whatsapp-backfill.
  const conns = await sql`select * from connections where user_id = ${user.id} and provider <> 'whatsapp'`;
  const results = [];

  for (const conn of conns) {
    try {
      const accessToken = await ensureFreshToken(user.id, conn);
      const { items, cursor } = await fetchItems(conn.provider, accessToken, conn.cursor);

      let upserted = 0;
      for (const item of items) {
        const title = String(item.title || "").slice(0, 300);
        const body = String(item.body || "").slice(0, 4000);
        await sql`
          insert into context_items (user_id, provider, external_id, ts, kind, title, body, url, meta)
          values (${user.id}, ${conn.provider}, ${item.externalId}, ${item.ts}, ${item.kind}, ${title}, ${body}, ${item.url || null}, ${JSON.stringify(item.meta || {})})
          on conflict (user_id, provider, external_id) do update set
            ts = excluded.ts, title = excluded.title, body = excluded.body, url = excluded.url, meta = excluded.meta
        `;
        upserted++;
      }

      await sql`
        update connections set cursor = ${cursor}, last_synced_at = now(), last_error = null
        where user_id = ${user.id} and provider = ${conn.provider}
      `;
      results.push({ provider: conn.provider, upserted });
    } catch (err) {
      if (err instanceof DisconnectedError) {
        await sql`delete from connections where user_id = ${user.id} and provider = ${conn.provider}`;
        results.push({ provider: conn.provider, disconnected: true, upserted: 0 });
        continue;
      }
      const message = String(err.message || err).slice(0, 300);
      await sql`update connections set last_error = ${message} where user_id = ${user.id} and provider = ${conn.provider}`;
      results.push({ provider: conn.provider, error: message, upserted: 0 });
    }
  }

  await sql`
    delete from context_items where user_id = ${user.id} and import_id is null
      and ts < now() - (${Number(env.CONTEXT_RETENTION_DAYS)} || ' days')::interval
  `;

  res.status(200).json({ results });
}

async function handleUpload(req, res) {
  const user = await requireAuthed(req, res, { entitled: true });
  if (!user) return;

  try {
    await consume(user, "connector_syncs", 1);
  } catch (e) {
    if (e instanceof QuotaExceeded) return res.status(429).json({ error: "quota", metric: e.metric });
    throw e;
  }

  const { name, text } = req.body || {};
  if (typeof name !== "string" || !/\.(txt|md|csv)$/i.test(name)) {
    return res.status(400).json({ error: "unsupported file type" });
  }
  if (typeof text !== "string" || text.length > 200000) {
    return res.status(400).json({ error: "file too large" });
  }

  const truncated = text.slice(0, 200000);
  const externalId = `up:${createHash("sha256").update(`${name}:${text.length}`).digest("hex").slice(0, 32)}`;

  await sql`
    insert into context_items (user_id, provider, external_id, ts, kind, title, body)
    values (${user.id}, 'upload', ${externalId}, now(), 'doc', ${name}, ${truncated})
    on conflict (user_id, provider, external_id) do update set
      ts = excluded.ts, title = excluded.title, body = excluded.body
  `;

  res.status(200).json({ upserted: 1 });
}

async function handleDisconnect(req, res) {
  const user = await requireAuthed(req, res, { entitled: false });
  if (!user) return;

  const { provider } = req.body || {};
  if (!provider) return res.status(400).json({ error: "provider required" });

  if (provider === "whatsapp") {
    const [conn] = await sql`select scope from connections where user_id = ${user.id} and provider = 'whatsapp'`;
    if (conn?.scope) {
      try {
        await deleteSession(conn.scope);
      } catch (err) {
        logError("waha_delete_failed", err, { userId: user.id });
      }
    }
  }

  await sql`delete from connections where user_id = ${user.id} and provider = ${provider}`;
  await sql`delete from context_items where user_id = ${user.id} and provider = ${provider}`;
  res.status(200).json({ disconnected: true });
}

async function handleWhatsappLink(req, res) {
  if (!wahaEnabled()) return res.status(501).json({ error: "whatsapp_disabled" });
  const user = await requireAuthed(req, res, { entitled: true });
  if (!user) return;

  const sessionName = sessionNameFor(user.id);
  // Reuse the existing secret on relink so webhooks already configured on the WAHA side keep
  // authenticating.
  const [existing] = await sql`
    select access_token_enc from connections where user_id = ${user.id} and provider = 'whatsapp'
  `;
  const token = existing ? decryptSecret(existing.access_token_enc) : randomBytes(32).toString("base64url");

  await sql`
    insert into connections (user_id, provider, access_token_enc, scope)
    values (${user.id}, 'whatsapp', ${encryptSecret(token)}, ${sessionName})
    on conflict (user_id, provider) do update set scope = excluded.scope, last_error = null
  `;

  try {
    const session = await ensureSession(sessionName, token, user.id);
    res.status(200).json({ session: sessionName, status: session?.status || "STARTING" });
  } catch (err) {
    const message = String(err.message || err).slice(0, 300);
    await sql`update connections set last_error = ${message} where user_id = ${user.id} and provider = 'whatsapp'`;
    logError("waha_link_failed", err, { userId: user.id });
    res.status(502).json({ error: "waha_unreachable", detail: message });
  }
}

async function handleWhatsappStatus(req, res) {
  if (!wahaEnabled()) return res.status(501).json({ error: "whatsapp_disabled" });
  const user = await requireAuthed(req, res, { entitled: false });
  if (!user) return;

  const [conn] = await sql`select scope from connections where user_id = ${user.id} and provider = 'whatsapp'`;
  if (!conn) return res.status(200).json({ linked: false, status: "NONE", qr: null, me: null });

  let session;
  try {
    session = await getSession(conn.scope);
  } catch (err) {
    return res.status(200).json({ linked: true, status: "UNKNOWN", qr: null, me: null, error: String(err.message || err).slice(0, 300) });
  }

  let qr = null;
  if (session.status === "SCAN_QR_CODE") qr = await getQr(conn.scope).catch(() => null);
  if (session.me?.id) {
    await sql`update connections set account_label = ${session.me.id} where user_id = ${user.id} and provider = 'whatsapp'`;
  }
  res.status(200).json({ linked: true, status: session.status, qr, me: session.me ?? null });
}

async function handleWhatsappWebhook(req, res) {
  if (!wahaEnabled()) return res.status(501).json({ error: "whatsapp_disabled" });

  const body = req.body || {};
  const sessionName = String(body.session || "");
  const presentedRaw = req.headers["x-earcue-waha-token"];
  const presented = Array.isArray(presentedRaw) ? presentedRaw[0] : presentedRaw;
  if (!sessionName || !presented) return res.status(401).json({ error: "unauthorized" });

  const [conn] = await sql`
    select c.user_id, c.access_token_enc, u.tz, u.plan, u.unlimited
    from connections c join users u on u.id = c.user_id
    where c.provider = 'whatsapp' and c.scope = ${sessionName}
  `;
  if (!conn) return res.status(404).json({ error: "unknown session" });

  let expected;
  try {
    expected = decryptSecret(conn.access_token_enc);
  } catch (err) {
    logError("waha_webhook_secret_unreadable", err, { sessionName });
    return res.status(500).json({ error: "server error" });
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(String(presented));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ error: "unauthorized" });

  if (body.event === "session.status") {
    const status = body.payload?.status || null;
    const me = body.me?.id || null;
    await sql`
      update connections
      set account_label = coalesce(${me}, account_label),
          last_error = ${status === "FAILED" ? "session failed \u2014 relink required" : null}
      where user_id = ${conn.user_id} and provider = 'whatsapp'
    `;
    return res.status(200).json({ ok: true });
  }
  if (body.event !== "message") return res.status(200).json({ ignored: true });

  const item = normalizeWahaMessage(body.payload);
  if (!item) return res.status(200).json({ ingested: 0 });

  const user = { id: conn.user_id, tz: conn.tz, plan: effectivePlan(conn.plan), unlimited: conn.unlimited };
  try {
    await consume(user, "import_items", 1);
  } catch (e) {
    // 200, not 429: a retry would fail identically and WAHA would keep redelivering all day.
    if (e instanceof QuotaExceeded) return res.status(200).json({ ingested: 0, quota: true });
    throw e;
  }

  const ingested = await insertContextItems(conn.user_id, "whatsapp", null, [item]);
  await sql`
    update connections set last_synced_at = now(), last_error = null
    where user_id = ${conn.user_id} and provider = 'whatsapp'
  `;
  res.status(200).json({ ingested });
}

export default async function handler(req, res) {
  if (!env.GOOGLE_CLIENT_ID && !env.SLACK_CLIENT_ID && !env.WAHA_BASE_URL) {
    return res.status(501).json({ error: "connectors_disabled" });
  }
  const action = req.query.action;
  if (action === "list" && req.method === "GET") return handleList(req, res);
  if (action === "start" && req.method === "GET") return handleStart(req, res);
  if (action === "callback" && req.method === "GET") return handleCallback(req, res);
  if (action === "sync" && req.method === "POST") return handleSync(req, res);
  if (action === "upload" && req.method === "POST") return handleUpload(req, res);
  if (action === "disconnect" && req.method === "POST") return handleDisconnect(req, res);
  if (action === "whatsapp-link" && req.method === "POST") return handleWhatsappLink(req, res);
  if (action === "whatsapp-status" && req.method === "GET") return handleWhatsappStatus(req, res);
  if (action === "whatsapp-webhook" && req.method === "POST") return handleWhatsappWebhook(req, res);
  return res.status(404).json({ error: "not found" });
}
