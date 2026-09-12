import { env } from "./env.js";

export class WahaError extends Error {
  constructor(status, path, body) {
    super(`waha ${status} ${path}: ${String(body).slice(0, 200)}`);
    this.status = status;
  }
}

function baseUrl() {
  return env.WAHA_BASE_URL.replace(/\/+$/, "");
}

// WAHA treats the session name as an id. Hyphens are stripped so the name stays inside the
// conservative [A-Za-z0-9_-] set regardless of engine.
export function sessionNameFor(userId) {
  return `ec${String(userId).replace(/-/g, "")}`;
}

// Separate from BETTER_AUTH_URL because WAHA usually runs in Docker and cannot reach the
// host's `localhost` during local dev.
export function webhookUrl() {
  const root = (env.WAHA_WEBHOOK_BASE_URL || env.BETTER_AUTH_URL).replace(/\/+$/, "");
  return `${root}/api/connect/whatsapp-webhook`;
}

async function waha(path, { method = "GET", body, accept = "application/json" } = {}) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      "x-api-key": env.WAHA_API_KEY,
      accept,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new WahaError(res.status, path, await res.text());
  if (res.status === 204) return null;
  return res.json();
}

export async function getSession(sessionName) {
  return waha(`/api/sessions/${sessionName}`);
}

function sessionConfig(webhookToken, userId) {
  return {
    metadata: { "earcue.userId": String(userId) },
    ignore: { status: true, channels: true },
    webhooks: [
      {
        url: webhookUrl(),
        events: ["message", "session.status"],
        customHeaders: [{ name: "X-Earcue-Waha-Token", value: webhookToken }],
        retries: { policy: "exponential", delaySeconds: 2, attempts: 5 },
      },
    ],
  };
}

// Create-or-update-and-start. Probes with GET rather than relying on the status code
// POST /api/sessions returns for a name conflict.
export async function ensureSession(sessionName, webhookToken, userId) {
  const config = sessionConfig(webhookToken, userId);
  let existing = null;
  try {
    existing = await getSession(sessionName);
  } catch {
    existing = null;
  }
  if (!existing) {
    return waha("/api/sessions", { method: "POST", body: { name: sessionName, start: true, config } });
  }
  await waha(`/api/sessions/${sessionName}`, { method: "POST", body: { config } });
  if (existing.status === "STOPPED" || existing.status === "FAILED") {
    await waha(`/api/sessions/${sessionName}/start`, { method: "POST" });
  }
  return getSession(sessionName);
}

// { mimetype, data } with data base64. Only meaningful while status is SCAN_QR_CODE.
export async function getQr(sessionName) {
  return waha(`/api/${sessionName}/auth/qr?format=image`);
}

export async function deleteSession(sessionName) {
  await waha(`/api/sessions/${sessionName}/logout`, { method: "POST" }).catch(() => {});
  await waha(`/api/sessions/${sessionName}`, { method: "DELETE" }).catch(() => {});
}

export async function chatsOverview(sessionName, limit) {
  return waha(`/api/${sessionName}/chats/overview?limit=${limit}&offset=0`);
}

export async function chatMessages(sessionName, chatId, sinceSeconds, limit, offset) {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    downloadMedia: "false",
    "filter.timestamp.gte": String(sinceSeconds),
  });
  return waha(`/api/${sessionName}/chats/${encodeURIComponent(chatId)}/messages?${params.toString()}`);
}

// Shared by the webhook and the backfill. Returns null for anything not worth storing.
// Output shape matches what insertContextItems() in api/_lib/knowledge.js expects.
export function normalizeWahaMessage(msg, chatName) {
  const body = String(msg?.body || "").trim();
  if (!body) return null;
  const chatId = String((msg.fromMe ? msg.to : msg.from) || "");
  if (!chatId || chatId === "status@broadcast") return null;
  const tsMs = Number(msg.timestamp) * 1000;
  if (!Number.isFinite(tsMs) || tsMs <= 0) return null;
  const name = chatName || msg._data?.notifyName || msg._data?.pushName || chatId.replace(/@.*$/, "");
  return {
    externalId: `waha:${msg.id}`,
    ts: new Date(tsMs).toISOString(),
    kind: "chat",
    title: `WhatsApp \u2014 ${name}`.slice(0, 300),
    body: body.slice(0, 4000),
    url: null,
    meta: { chatId, from: msg.from ?? null, fromMe: Boolean(msg.fromMe) },
  };
}
