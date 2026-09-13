import "server-only";
import { requireAuthed } from "../auth";
import { DisconnectedError, ensureFreshToken, type ConnectionRow } from "../connectors";
import { sql } from "../db";
import { env } from "../env";
import { QuotaExceeded } from "../errors";
import { IMPORT_SOURCES, insertContextItems, normalizeBrowserRows, normalizeItems, profileFor, runDistillPass } from "../knowledge";
import { logError } from "../log";
import { consume } from "../quota";
import { json, readJson } from "../respond";
import { chatMessages, chatsOverview, normalizeWahaMessage, sessionNameFor, type ContextItem } from "../waha";

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

  await sql`delete from imports where id = ${importId} and user_id = ${user.id}`;
  return json({ removed: true });
}

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
  let pageToken: string | undefined = importRow.cursor || undefined;

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
      const messages: { id: string }[] = listJson.messages || [];

      const items: ContextItem[] = [];
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
          const headersList: { name: string; value: string }[] = msg.payload?.headers || [];
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

      if (items.length > 0) await consume(user, "import_items", items.length);

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
      return json({ error: "disconnected" }, 400);
    }
    throw err;
  }

  return json({ ingested: totalIngested, done, remainingPages: done ? 0 : 1 });
}

export async function handleWhatsappBackfill(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true });

  const [conn] = await sql`select scope from connections where user_id = ${user.id} and provider = 'whatsapp'`;
  if (!conn) return json({ error: "whatsapp not connected" }, 400);
  const sessionName: string = conn.scope || sessionNameFor(user.id);

  const body = await readJson(request);
  const days = Math.min(730, Math.max(1, Number(body.days) || Number(env.IMPORT_LOOKBACK_DAYS)));
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
      const items: ContextItem[] = [];
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
            return json({ error: "quota", metric: e.metric }, 429);
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
    const message = String((err as Error).message || err).slice(0, 300);
    await sql`update imports set status = 'failed', error = ${message}, updated_at = now() where id = ${importId}`;
    logError("waha_backfill_failed", err, { userId: user.id });
    return json({ error: "waha_unreachable", detail: message }, 502);
  }

  return json({ ingested: totalIngested, done });
}

export async function handleDistill(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers, { entitled: true });
  await consume(user, "distills", 1);

  const result = await runDistillPass(user, Date.now() + 45000);
  return json(result);
}

export async function handleProfile(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);

  const profile = await profileFor(user.id);
  return json(profile || { summary: "", static: [], dynamic: [], buckets: {}, builtAt: null });
}

export async function handleExcludes(request: Request): Promise<Response> {
  const user = await requireAuthed(request.headers);

  const { domains } = await readJson(request);
  const raw = Array.isArray(domains) ? domains.join("\n") : String(domains || "");
  const arr = raw
    .split(/[\n,]/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 200);

  await sql`update users set excluded_domains = ${arr} where id = ${user.id}`;
  return json({ excludedDomains: arr });
}
