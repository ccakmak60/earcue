import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { requireAuthed } from "./auth";
import { authorizeUrl, DisconnectedError, ensureFreshToken, exchangeCode, fetchItems, type ConnectionRow } from "./connectors";
import { sql } from "./db";
import { env } from "./env";
import { logError } from "./log";
import { consume } from "./quota";
import { json, query, readJson } from "./respond";
import { encryptSecret } from "./secretbox";

// Actions behind /api/connect/[action]. The route wraps each in the typed-error mapper.

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

function secureFlag(): string {
  return env.BETTER_AUTH_URL.startsWith("https") ? "; Secure" : "";
}

// Built by hand rather than with Response.redirect: that one has immutable headers (no Set-Cookie)
// and requires an absolute URL, while the legacy callback redirected to a relative path.
function redirect(location: string, cookie: string): Response {
  return new Response(null, { status: 302, headers: { location, "set-cookie": cookie } });
}

export function connectorsDisabled(): boolean {
  return !env.GOOGLE_CLIENT_ID && !env.SLACK_CLIENT_ID;
}

export async function handleList(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);

  const conns = await sql`
    select provider, account_label, scope, last_synced_at, last_error
    from connections where user_id = ${user.id}
  `;
  const counts = await sql`
    select provider, count(*)::int as item_count from context_items where user_id = ${user.id} group by provider
  `;
  const countByProvider: Record<string, number> = Object.fromEntries(counts.map((c) => [c.provider, c.item_count]));

  return json({
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

export async function handleStart(request: Request): Promise<Response> {
  await requireAuthed(request.headers);

  const provider = query(request).get("provider");
  if (provider !== "google" && provider !== "slack") return json({ error: "bad provider" }, 400);

  const state = `${provider}.${randomBytes(16).toString("base64url")}`;
  return redirect(authorizeUrl(provider, state), `ec_oauth=${state}; Path=/api/connect; HttpOnly; SameSite=Lax; Max-Age=600${secureFlag()}`);
}

export async function handleCallback(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);

  const params = query(request);
  const code = params.get("code");
  const state = params.get("state");
  const cookieState = cookieValue(request, "ec_oauth");
  const clearCookie = `ec_oauth=; Path=/api/connect; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag()}`;
  let provider: string | null = null;

  try {
    if (!state || !cookieState) throw new Error("missing state");
    const a = Buffer.from(String(state));
    const b = Buffer.from(String(cookieState));
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("state mismatch");
    provider = String(state).split(".")[0];
    if (provider !== "google" && provider !== "slack") throw new Error("bad provider in state");

    const tokens = await exchangeCode(provider, String(code));
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

    return redirect(`/app?connected=${provider}`, clearCookie);
  } catch (err) {
    logError("connect_exchange_failed", err, { provider });
    return redirect(`/app?connect_error=${provider || "unknown"}`, clearCookie);
  }
}

export async function handleSync(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true });
  await consume(user, "connector_syncs", 1);

  const conns = (await sql`select * from connections where user_id = ${user.id}`) as ConnectionRow[];
  const results: Record<string, unknown>[] = [];

  for (const conn of conns) {
    try {
      const accessToken = await ensureFreshToken(user.id, conn);
      const { items, cursor } = await fetchItems(conn.provider, accessToken, conn.cursor as string | null);

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
      const message = String((err as Error).message || err).slice(0, 300);
      await sql`update connections set last_error = ${message} where user_id = ${user.id} and provider = ${conn.provider}`;
      results.push({ provider: conn.provider, error: message, upserted: 0 });
    }
  }

  await sql`
    delete from context_items where user_id = ${user.id} and import_id is null
      and ts < now() - (${Number(env.CONTEXT_RETENTION_DAYS)} || ' days')::interval
  `;

  return json({ results });
}

export async function handleUpload(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true });
  await consume(user, "connector_syncs", 1);

  const { name, text } = await readJson(request);
  if (typeof name !== "string" || !/\.(txt|md|csv)$/i.test(name)) {
    return json({ error: "unsupported file type" }, 400);
  }
  if (typeof text !== "string" || text.length > 200000) {
    return json({ error: "file too large" }, 400);
  }

  const truncated = text.slice(0, 200000);
  const externalId = `up:${createHash("sha256").update(`${name}:${text.length}`).digest("hex").slice(0, 32)}`;

  await sql`
    insert into context_items (user_id, provider, external_id, ts, kind, title, body)
    values (${user.id}, 'upload', ${externalId}, now(), 'doc', ${name}, ${truncated})
    on conflict (user_id, provider, external_id) do update set
      ts = excluded.ts, title = excluded.title, body = excluded.body
  `;

  return json({ upserted: 1 });
}

export async function handleDisconnect(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);

  const { provider } = await readJson(request);
  if (!provider) return json({ error: "provider required" }, 400);

  await sql`delete from connections where user_id = ${user.id} and provider = ${provider}`;
  await sql`delete from context_items where user_id = ${user.id} and provider = ${provider}`;
  return json({ disconnected: true });
}

