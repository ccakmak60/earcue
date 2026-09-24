import "server-only";
import { sql } from "./db";
import { env } from "./env";
import { encryptSecret, decryptSecret } from "./secretbox";
import type { ContextItem } from "./knowledge";
import { GMAIL_QUERY_FILTER, type GmailMessage, gmailItem } from "@/lib/shared/gmail";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

const SLACK_USER_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "users:read",
].join(",");

function redirectUri(): string {
  return `${env.BETTER_AUTH_URL}/api/connect/callback`;
}

export const PROVIDERS = {
  google: {},
  slack: {},
};

export type Provider = keyof typeof PROVIDERS;

export class DisconnectedError extends Error {
  readonly provider: string;
  readonly disconnected = true;
  constructor(provider: string) {
    super(`disconnected:${provider}`);
    this.provider = provider;
  }
}

export interface ExchangedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scope: string;
  accountLabel: string | null;
}

// A connections row as the sync paths read it.
export interface ConnectionRow {
  provider: string;
  access_token_enc: string;
  refresh_token_enc: string | null;
  expires_at: string | Date | null;
  [key: string]: unknown;
}

export function authorizeUrl(provider: string, state: string): string {
  if (provider === "google") {
    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
      scope: GOOGLE_SCOPES,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }
  if (provider === "slack") {
    const params = new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID,
      redirect_uri: redirectUri(),
      state,
      user_scope: SLACK_USER_SCOPES,
    });
    return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
  }
  throw new Error(`unknown provider: ${provider}`);
}

async function exchangeGoogle(code: string): Promise<ExchangedTokens> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(),
    }),
  });
  if (!res.ok) throw new Error(`google token exchange ${res.status}: ${await res.text()}`);
  const json = await res.json();

  const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { authorization: `Bearer ${json.access_token}` },
  });
  const userInfo = userInfoRes.ok ? await userInfoRes.json() : {};

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: new Date(Date.now() + json.expires_in * 1000).toISOString(),
    scope: json.scope || GOOGLE_SCOPES,
    accountLabel: userInfo.email || null,
  };
}

async function exchangeSlack(code: string): Promise<ExchangedTokens> {
  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID,
      client_secret: env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri(),
    }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`slack:${json.error}`);

  return {
    accessToken: json.authed_user?.access_token,
    refreshToken: json.authed_user?.refresh_token ?? null,
    expiresAt: json.authed_user?.expires_in ? new Date(Date.now() + json.authed_user.expires_in * 1000).toISOString() : null,
    scope: json.authed_user?.scope || SLACK_USER_SCOPES,
    accountLabel: json.team?.name || null,
  };
}

export async function exchangeCode(provider: string, code: string): Promise<ExchangedTokens> {
  if (provider === "google") return exchangeGoogle(code);
  if (provider === "slack") return exchangeSlack(code);
  throw new Error(`unknown provider: ${provider}`);
}

async function refreshGoogle(userId: string, conn: ConnectionRow): Promise<string> {
  const refreshToken = decryptSecret(conn.refresh_token_enc);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    }),
  });
  if (res.status === 400 || res.status === 401) {
    await sql`delete from connections where user_id = ${userId} and provider = 'google'`;
    throw new DisconnectedError("google");
  }
  if (!res.ok) throw new Error(`google refresh ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const expiresAt = new Date(Date.now() + json.expires_in * 1000).toISOString();
  await sql`
    update connections set access_token_enc = ${encryptSecret(json.access_token)}, expires_at = ${expiresAt}, last_error = null
    where user_id = ${userId} and provider = 'google'
  `;
  return json.access_token;
}

export async function ensureFreshToken(userId: string, conn: ConnectionRow): Promise<string> {
  const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : null;
  const expiringSoon = expiresAt !== null && expiresAt - Date.now() < 60000;

  if (conn.provider === "google" && expiringSoon) {
    return refreshGoogle(userId, conn);
  }
  return decryptSecret(conn.access_token_enc);
}

// Gmail answers a per-user quota ("Units per minute per user") with 429, or with 403 and a
// rateLimitExceeded / userRateLimitExceeded reason. The limit is per minute, so a caller waits a
// minute and tries the same page again.
export class GmailRateLimited extends Error {
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super("gmail_rate_limited");
    this.retryAfter = retryAfter;
  }
}

export const GMAIL_RETRY_SECONDS = 60;

export async function gmailRateLimit(res: Response): Promise<GmailRateLimited | null> {
  if (res.status !== 429 && res.status !== 403) return null;
  const text = await res.clone().text();
  if (res.status === 403 && !/rate_?limit_?exceeded/i.test(text)) return null;
  const header = Number(res.headers.get("retry-after"));
  return new GmailRateLimited(Number.isFinite(header) && header > 0 ? Math.min(header, 300) : GMAIL_RETRY_SECONDS);
}

// format=full carries the message text (Gmail's metadata format stops at a 200-character snippet).
// Attachments come back as ids only, never inline, so the payload stays the text and HTML parts.
export async function fetchGmailMessage(headers: Record<string, string>, id: string): Promise<GmailMessage | null> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers });
  if (res.status === 401) throw new DisconnectedError("google");
  const limited = await gmailRateLimit(res);
  if (limited) throw limited;
  return res.ok ? ((await res.json()) as GmailMessage) : null;
}

interface FetchResult {
  items: ContextItem[];
  cursor: string;
}

async function fetchGoogle(accessToken: string, cursor: string | null): Promise<FetchResult> {
  const items: ContextItem[] = [];
  const headers = { authorization: `Bearer ${accessToken}` };

  let maxInternalDate = cursor ? Number(cursor) : 0;
  const cursorNum = cursor ? Number(cursor) : 0;

  try {
    const listParams = new URLSearchParams({ maxResults: "15", q: `newer_than:1d ${GMAIL_QUERY_FILTER}` });
    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${listParams.toString()}`, { headers });
    if (listRes.status === 401) throw new DisconnectedError("google");
    if (listRes.ok) {
      const listJson = await listRes.json();
      for (const m of listJson.messages || []) {
        const msg = await fetchGmailMessage(headers, m.id);
        if (!msg) continue;
        const internalDate = Number(msg.internalDate);
        if (internalDate <= cursorNum) continue;
        if (internalDate > maxInternalDate) maxInternalDate = internalDate;
        const item = gmailItem(msg);
        if (item) items.push(item);
      }
    }
  } catch (err) {
    if (err instanceof DisconnectedError) throw err;
  }

  try {
    const now = Date.now();
    const timeMin = new Date(now - 3600000).toISOString();
    const timeMax = new Date(now + 12 * 3600000).toISOString();
    const evRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=20&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`,
      { headers }
    );
    if (evRes.status === 401) throw new DisconnectedError("google");
    if (evRes.ok) {
      const evJson = await evRes.json();
      for (const ev of evJson.items || []) {
        items.push({
          externalId: `cal:${ev.id}`,
          ts: ev.start?.dateTime || ev.start?.date,
          kind: "event",
          title: ev.summary || "(untitled event)",
          body: ev.description || "",
          url: ev.htmlLink || null,
          meta: {
            attendees: (ev.attendees || []).map((a: { email: string }) => a.email),
            location: ev.location || null,
            hangoutLink: ev.hangoutLink || null,
          },
        });
      }
    }
  } catch (err) {
    if (err instanceof DisconnectedError) throw err;
  }

  return { items, cursor: String(maxInternalDate || cursorNum) };
}

async function fetchSlack(accessToken: string, cursor: string | null): Promise<FetchResult> {
  const items: ContextItem[] = [];
  const headers = { authorization: `Bearer ${accessToken}` };

  const convRes = await fetch("https://slack.com/api/users.conversations?types=public_channel,private_channel,mpim,im&limit=30", { headers });
  const convJson = await convRes.json();
  if (!convJson.ok) {
    if (convJson.error === "invalid_auth" || convJson.error === "token_revoked") throw new DisconnectedError("slack");
    throw new Error(`slack:${convJson.error}`);
  }

  const oldest = cursor || String(Math.floor(Date.now() / 1000) - 3600);
  let maxTs = cursor || "0";
  const channels: { id: string; name?: string }[] = (convJson.channels || []).slice(0, 5);

  for (const ch of channels) {
    const histRes = await fetch(`https://slack.com/api/conversations.history?channel=${ch.id}&oldest=${oldest}&limit=20`, { headers });
    const histJson = await histRes.json();
    if (!histJson.ok) {
      if (histJson.error === "invalid_auth" || histJson.error === "token_revoked") throw new DisconnectedError("slack");
      continue;
    }
    for (const msg of histJson.messages || []) {
      if (msg.subtype || !msg.text) continue;
      if (Number(msg.ts) > Number(maxTs)) maxTs = msg.ts;
      items.push({
        externalId: `${ch.id}:${msg.ts}`,
        ts: new Date(Number(msg.ts) * 1000).toISOString(),
        kind: "message",
        title: `#${ch.name || "dm"}`,
        body: msg.text,
        url: `https://slack.com/archives/${ch.id}/p${msg.ts.replace(".", "")}`,
        meta: { channelId: ch.id, user: msg.user || null, threadTs: msg.thread_ts ?? null },
      });
      if (items.length >= 60) break;
    }
    if (items.length >= 60) break;
  }

  return { items: items.slice(0, 60), cursor: maxTs };
}

export async function fetchItems(provider: string, accessToken: string, cursor: string | null): Promise<FetchResult> {
  if (provider === "google") return fetchGoogle(accessToken, cursor);
  if (provider === "slack") return fetchSlack(accessToken, cursor);
  throw new Error(`unknown provider: ${provider}`);
}
