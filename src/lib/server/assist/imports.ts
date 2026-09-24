import "server-only";
import { annotateBatch, annotatePendingItems, annotationsPending } from "../annotate";
import { requireAuthed } from "../auth";
import { DisconnectedError, ensureFreshToken, fetchGmailMessage, type ConnectionRow } from "../connectors";
import { sql } from "../db";
import { whatsappSelf } from "../entities";
import { env } from "../env";
import { PayloadTooLarge, QuotaExceeded } from "../errors";
import {
  type ContextItem,
  IMPORT_SOURCES,
  insertContextItems,
  normalizeBrowserRows,
  normalizeItems,
  profileFor,
  purgeHost,
  removeImport,
  runDistillPass,
  sha256Hex,
} from "../knowledge";
import { logError } from "../log";
import { GMAIL_QUERY_FILTER, gmailItem } from "@/lib/shared/gmail";
import { cleanPageUrl, hostMatchesSkip, normalizePageText } from "@/lib/shared/pagetext";
import { consume, localDay } from "../quota";
import { json, readJson } from "../respond";

// ---------- imports / profile / excludes ----------
// begin, browser and finish also accept the extension's ingest bearer token.

async function markImportQuotaFailed(err: unknown, importId: unknown) {
  if (err instanceof QuotaExceeded) {
    await sql`update imports set status = 'failed', error = 'quota', updated_at = now() where id = ${importId}`;
  }
}

export async function handleImports(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);

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
  // Which WhatsApp speaker is the person, for the Sources view to confirm once.
  const self = await whatsappSelf(user.id);

  return json({
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
    whatsappSelf: self,
  });
}

export async function handleBegin(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true, allowToken: true });

  const { source, label } = await readJson(request);
  if (!Object.hasOwn(IMPORT_SOURCES, source)) return json({ error: "bad source" }, 400);

  const [row] = await sql`
    insert into imports (user_id, source, label) values (${user.id}, ${source}, ${label || ""})
    returning id
  `;
  return json({ importId: row.id });
}

export async function handleBrowser(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true, allowToken: true });

  const { importId, kind, rows } = await readJson(request);
  if (!importId || (kind !== "history" && kind !== "bookmarks") || !Array.isArray(rows)) {
    return json({ error: "importId, kind, rows required" }, 400);
  }
  if (rows.length > 500) return json({ error: "batch too large" }, 400);

  const [importRow] = await sql`select id from imports where id = ${importId} and user_id = ${user.id}`;
  if (!importRow) return json({ error: "import not found" }, 404);

  const [userRow] = await sql`select excluded_domains from users where id = ${user.id}`;
  const { items, skipped } = normalizeBrowserRows(rows, { kind, excludedDomains: userRow.excluded_domains });

  try {
    if (items.length > 0) await consume(user, "import_items", items.length);
  } catch (e) {
    await markImportQuotaFailed(e, importId);
    throw e;
  }

  const ingested = await insertContextItems(user.id, "browser", importId, items);
  await sql`
    update imports set items_ingested = items_ingested + ${ingested}, items_skipped = items_skipped + ${skipped}, updated_at = now()
    where id = ${importId}
  `;
  return json({ ingested, skipped });
}

export async function handlePage(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true, allowToken: true });

  const { importId, url, title, text, readMs, ts } = await readJson(request);
  const parsed = cleanPageUrl(url);
  if (!importId || !parsed) return json({ error: "importId, url required" }, 400);
  if (typeof readMs !== "number" || readMs < 0) return json({ error: "readMs required" }, 400);
  if (text !== undefined && (typeof text !== "string" || text.length > 200000)) throw new PayloadTooLarge("page too large");

  try {
    await consume(user, "import_items", 1);
  } catch (e) {
    await markImportQuotaFailed(e, importId);
    throw e;
  }

  const [userRow] = await sql`select capture_pages, excluded_domains from users where id = ${user.id}`;
  if (!userRow.capture_pages) return json({ skipped: "disabled" });
  const { cleanUrl, host } = parsed;
  if (hostMatchesSkip(host, userRow.excluded_domains)) return json({ skipped: "excluded" });

  const [importRow] = await sql`select id from imports where id = ${importId} and user_id = ${user.id}`;
  if (!importRow) return json({ error: "import not found" }, 404);

  const tsDate = new Date(ts);
  const pageTs = isNaN(tsDate.getTime()) ? new Date() : tsDate;
  const hash = sha256Hex(cleanUrl);

  let ingested = 0;
  if (typeof text === "string") {
    const body = normalizePageText(text);
    ingested = await insertContextItems(user.id, "browser", importId, [
      {
        externalId: `bh:${hash.slice(0, 32)}`,
        ts: pageTs.toISOString(),
        kind: "page_text",
        title: String(title || "").slice(0, 300),
        body,
        url: cleanUrl,
        meta: { host, readMs, chars: body.length, captured: true },
      },
    ]);
    await sql`
      update imports set items_ingested = items_ingested + ${ingested}, updated_at = now()
      where id = ${importId}
    `;
  }

  let traced = false;
  if (readMs >= Number(env.PAGE_TRACE_MS)) {
    const day = localDay(user.tz);
    const clientId = `pg:${hash.slice(0, 16)}:${day}`;
    const meta = JSON.stringify({ url: cleanUrl, host, readMs, excerpt: String(title || "").slice(0, 280) });
    await sql`
      insert into traces (user_id, ts, local_day, kind, source, speaker, text, meta, client_id)
      values (${user.id}, ${pageTs.toISOString()}::timestamptz, ${day}::date, 'page', 'browser', null, ${String(title || cleanUrl).slice(0, 300)}, ${meta}::jsonb, ${clientId})
      on conflict (user_id, client_id) do nothing
    `;
    traced = true;
  }

  return json({ ingested, traced });
}

export async function handleItems(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true });

  const { importId, items: rawItems } = await readJson(request);
  if (!importId || !Array.isArray(rawItems)) return json({ error: "importId, items required" }, 400);
  if (rawItems.length > 500) return json({ error: "batch too large" }, 400);

  const [importRow] = await sql`select id, source from imports where id = ${importId} and user_id = ${user.id}`;
  if (!importRow) return json({ error: "import not found" }, 404);

  const { items, skipped } = normalizeItems(rawItems);
  const provider = IMPORT_SOURCES[importRow.source]?.provider || "upload";

  try {
    if (items.length > 0) await consume(user, "import_items", items.length);
  } catch (e) {
    await markImportQuotaFailed(e, importId);
    throw e;
  }

  const ingested = await insertContextItems(user.id, provider, importId, items);
  await sql`
    update imports set items_ingested = items_ingested + ${ingested}, items_skipped = items_skipped + ${skipped}, updated_at = now()
    where id = ${importId}
  `;
  return json({ ingested, skipped });
}

export async function handleFinish(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true, allowToken: true });

  const { importId, status } = await readJson(request);
  if (!importId || (status !== "complete" && status !== "failed")) {
    return json({ error: "importId, status required" }, 400);
  }

  const [row] = await sql`
    update imports set status = ${status}, updated_at = now() where id = ${importId} and user_id = ${user.id}
    returning items_ingested
  `;
  if (!row) return json({ error: "import not found" }, 404);
  return json({ ingested: row.items_ingested });
}

export async function handleRemove(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true });

  const { importId } = await readJson(request);
  if (!importId) return json({ error: "importId required" }, 400);

  const { memories } = await removeImport(user.id, importId);
  return json({ removed: true, memoriesRemoved: memories });
}

// Workers Free allows 50 subrequests per request, and every message is its own fetch, so one
// call takes one list page of GMAIL_PAGE_SIZE messages and the client calls again until `done`.
// Around the fetches: the session as two, the users row, the connection, the running import (and
// its insert on the first call), a token refresh (fetch and update), the list, `consume`, the
// insert and its participant links, and the cursor update: 13 at most, so a page of 25 is 38
// counted calls.
export const GMAIL_PAGE_SIZE = 25;

export async function handleGmailBackfill(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true });

  const [conn] = (await sql`select * from connections where user_id = ${user.id} and provider = 'google'`) as ConnectionRow[];
  if (!conn) return json({ error: "google not connected" }, 400);

  const body = await readJson(request);
  const days = Math.min(730, Math.max(1, Number(body.days) || Number(env.IMPORT_LOOKBACK_DAYS)));

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

  try {
    const accessToken = await ensureFreshToken(user.id, conn);
    const headers = { authorization: `Bearer ${accessToken}` };
    const params = new URLSearchParams({ maxResults: String(GMAIL_PAGE_SIZE), q: `newer_than:${days}d ${GMAIL_QUERY_FILTER}` });
    if (importRow.cursor) params.set("pageToken", importRow.cursor);

    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`, { headers });
    if (listRes.status === 401) throw new DisconnectedError("google");
    if (!listRes.ok) throw new Error(`gmail list ${listRes.status}: ${await listRes.text()}`);
    const listJson = await listRes.json();
    const messages: { id: string }[] = (listJson.messages || []).slice(0, GMAIL_PAGE_SIZE);

    const items: ContextItem[] = [];
    for (let i = 0; i < messages.length; i += 10) {
      const group = messages.slice(i, i + 10);
      const fetched = await Promise.all(group.map((m) => fetchGmailMessage(headers, m.id)));
      for (const msg of fetched) {
        const item = msg && gmailItem(msg);
        if (item) items.push(item);
      }
    }

    if (items.length > 0) await consume(user, "import_items", items.length);

    const ingested = await insertContextItems(user.id, "google", importId, items);
    const pageToken: string | undefined = listJson.nextPageToken;
    const done = !pageToken;
    await sql`
      update imports set items_ingested = items_ingested + ${ingested}, cursor = ${pageToken || null},
        status = ${done ? "complete" : "running"}, updated_at = now()
      where id = ${importId}
    `;
    return json({ ingested, done, remainingPages: done ? 0 : 1 });
  } catch (err) {
    if (err instanceof DisconnectedError) {
      await sql`delete from connections where user_id = ${user.id} and provider = 'google'`;
      logError("knowledge_gmail_backfill_disconnected", err, { userId: user.id });
      return json({ error: "disconnected" }, 400);
    }
    throw err;
  }
}

export async function handleDistill(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true });
  await consume(user, "distills", 1);

  const result = await runDistillPass(user, Date.now() + 45000);
  return json(result);
}

// Item signals for the pending items, newest first: the client runs this from catch-up (and after
// an import) until nothing is pending, before it asks for a distill pass, so annotation spends
// `annotations` units and never a `distills` one. The one read between the body check and the
// charge is the batch itself, so the charge is the items actually read (D5) and an empty queue
// costs nothing; the charge comes before any model call. `limit` (optional) lowers the batch,
// which is capped by its subrequest budget (annotateBatch).
export async function handleAnnotate(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true });
  const body = await readJson(request);
  const limit = body.limit ?? null;
  if (limit !== null && (!Number.isInteger(limit) || (limit as number) < 1)) return json({ error: "limit must be a positive integer" }, 400);

  const batch = Math.min((limit as number | null) ?? Number.POSITIVE_INFINITY, annotateBatch());
  const result = await annotatePendingItems(user, batch, Date.now() + 45000);
  return json({ ...result, remaining: await annotationsPending(user.id) });
}

export async function handleProfile(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);

  const profile = await profileFor(user.id);
  return json(profile || { summary: "", static: [], dynamic: [], buckets: {}, builtAt: null });
}

export async function handleExcludesGet(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true, allowToken: true });

  const [row] = await sql`select excluded_domains, capture_pages from users where id = ${user.id}`;
  return json({ excludedDomains: row.excluded_domains, capturePages: row.capture_pages });
}

// Three mutually exclusive shapes: {domains} full-replaces the list (the /app textarea), {add} appends
// one host and purges anything already captured from it, {capturePages} flips the capture switch.
export async function handleExcludes(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { allowToken: true });
  const body = await readJson(request);

  if (typeof body.capturePages === "boolean") {
    await sql`update users set capture_pages = ${body.capturePages} where id = ${user.id}`;
    return json({ capturePages: body.capturePages });
  }

  if (typeof body.add === "string" && body.add.trim()) {
    const host = body.add.trim().toLowerCase();
    const [row] = await sql`
      update users set excluded_domains = (
        select coalesce(array_agg(distinct d), '{}') from unnest(excluded_domains || array[${host}]::text[]) as d
      )
      where id = ${user.id}
      returning excluded_domains
    `;
    const arr = (row.excluded_domains as string[]).slice(0, 200);
    await sql`update users set excluded_domains = ${arr} where id = ${user.id}`;

    const suffix = `%.${host}`;
    const purgedItems = await purgeHost(user.id, host);
    const purgedTraces = await sql`
      delete from traces where user_id = ${user.id} and kind = 'page'
        and (meta->>'host' = ${host} or meta->>'host' like ${suffix})
      returning 1
    `;
    return json({ excludedDomains: arr, purged: purgedItems.items + purgedTraces.length, memoriesRemoved: purgedItems.memories });
  }

  const { domains } = body;
  const raw = Array.isArray(domains) ? domains.join("\n") : String(domains || "");
  const arr = raw
    .split(/[\n,]/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 200);

  await sql`update users set excluded_domains = ${arr} where id = ${user.id}`;
  return json({ excludedDomains: arr });
}
