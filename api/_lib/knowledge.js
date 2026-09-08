import { createHash } from "node:crypto";
import { sql } from "./db.js";
import { chatJson } from "./nim.js";
import { embedTexts, embedOne, toVectorLiteral } from "./embed.js";
import { env } from "./env.js";
import { logError } from "./log.js";

export const IMPORT_SOURCES = {
  browser_history: { provider: "browser", raw: "history" },
  browser_bookmarks: { provider: "browser", raw: "bookmarks" },
  whatsapp: { provider: "whatsapp", raw: null },
  gmail_backfill: { provider: "google", raw: null },
  doc: { provider: "upload", raw: null },
};

function sha256Hex(str) {
  return createHash("sha256").update(str).digest("hex");
}

function isExcludedHost(host, excludedDomains) {
  const h = host.toLowerCase();
  for (const raw of excludedDomains || []) {
    const d = String(raw || "").toLowerCase();
    if (!d) continue;
    if (h === d || h.endsWith(`.${d}`)) return true;
  }
  return false;
}

function cleanUrlAndHost(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) return null;
  return { cleanUrl: `${u.origin}${u.pathname}`, host };
}

// ---------- normalisation ----------

export function normalizeBrowserRows(rows, { kind, excludedDomains }) {
  const items = [];
  let skipped = 0;

  for (const row of rows || []) {
    const parsed = cleanUrlAndHost(row.url);
    if (!parsed) {
      skipped++;
      continue;
    }
    const { cleanUrl, host } = parsed;
    if (isExcludedHost(host, excludedDomains)) {
      skipped++;
      continue;
    }

    if (kind === "history") {
      const title = String(row.title || "").trim();
      if (!title) {
        skipped++;
        continue;
      }
      const visitCount = Number(row.visitCount) || 0;
      const typedCount = Number(row.typedCount) || 0;
      if (visitCount < 2 && typedCount < 1) {
        skipped++;
        continue;
      }
      items.push({
        externalId: `bh:${sha256Hex(cleanUrl).slice(0, 32)}`,
        ts: new Date(row.lastVisitTime).toISOString(),
        kind: "page",
        title: title.slice(0, 300),
        body: `${host} \u2014 visited ${visitCount}\u00d7`,
        url: cleanUrl,
        meta: { host, visitCount, typedCount },
      });
    } else if (kind === "bookmarks") {
      const title = String(row.title || "").trim();
      const folder = row.folder || null;
      let ts;
      if (row.addedAt) {
        const d = new Date(row.addedAt);
        ts = isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
      } else {
        ts = new Date().toISOString();
      }
      items.push({
        externalId: `bm:${sha256Hex(cleanUrl).slice(0, 32)}`,
        ts,
        kind: "bookmark",
        title: title || cleanUrl,
        body: folder ? `folder: ${folder} \u2014 ${host}` : host,
        url: cleanUrl,
        meta: { host, folder },
      });
    } else {
      skipped++;
    }
  }

  return { items, skipped };
}

export function normalizeItems(rows) {
  const items = [];
  let skipped = 0;

  for (const row of rows || []) {
    if (!row || !row.externalId) {
      skipped++;
      continue;
    }
    const tsDate = new Date(row.ts);
    if (isNaN(tsDate.getTime())) {
      skipped++;
      continue;
    }
    if (row.kind !== "chat" && row.kind !== "doc") {
      skipped++;
      continue;
    }
    const body = String(row.body || "").trim().slice(0, 4000);
    if (!body) {
      skipped++;
      continue;
    }
    items.push({
      externalId: row.externalId,
      ts: tsDate.toISOString(),
      kind: row.kind,
      title: String(row.title || "").slice(0, 300),
      body,
      url: row.url || null,
      meta: row.meta || {},
    });
  }

  return { items, skipped };
}

// ---------- storage ----------

export async function insertContextItems(userId, provider, importId, items) {
  if (!items || items.length === 0) return 0;

  const ids = items.map((i) => i.externalId);
  const tss = items.map((i) => i.ts);
  const kinds = items.map((i) => i.kind);
  const titles = items.map((i) => i.title || "");
  const bodies = items.map((i) => i.body || "");
  const urls = items.map((i) => i.url || "");
  const metas = items.map((i) => JSON.stringify(i.meta || {}));

  const rows = await sql`
    insert into context_items (user_id, provider, external_id, ts, kind, title, body, url, meta, import_id)
    select ${userId}::uuid, ${provider}, x.external_id, x.ts::timestamptz, x.kind, x.title, x.body,
           nullif(x.url, ''), x.meta::jsonb, ${importId}::bigint
    from unnest(${ids}::text[], ${tss}::text[], ${kinds}::text[], ${titles}::text[],
                ${bodies}::text[], ${urls}::text[], ${metas}::text[])
      as x(external_id, ts, kind, title, body, url, meta)
    on conflict (user_id, provider, external_id) do update set
      ts = greatest(context_items.ts, excluded.ts),
      title = excluded.title, body = excluded.body, url = excluded.url, meta = excluded.meta,
      import_id = coalesce(excluded.import_id, context_items.import_id)
    returning 1
  `;
  return rows.length;
}

function subjectKeyOf(subject) {
  return String(subject || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function upsertMemories(userId, produced, origin) {
  if (!produced || produced.length === 0) return { created: 0, updated: 0, idByIndex: {} };

  const vectors = await embedTexts(
    produced.map((m) => m.text),
    "RETRIEVAL_DOCUMENT"
  );

  let created = 0;
  let updated = 0;
  const idByIndex = {};

  for (let i = 0; i < produced.length; i++) {
    const m = produced[i];
    const subjectKey = subjectKeyOf(m.subject);
    const lit = toVectorLiteral(vectors[i]);
    const expiresAt = m.expires_in_days ? new Date(Date.now() + m.expires_in_days * 86400000).toISOString() : null;
    const evidence = JSON.stringify(m.evidence || []);

    const nearest = await sql`
      select id, 1 - (embedding <=> ${lit}::vector) as sim from memories
      where user_id = ${userId} and kind = ${m.kind} and subject_key = ${subjectKey}
        and superseded_by is null and embedding is not null
      order by embedding <=> ${lit}::vector limit 1
    `;

    if (nearest.length > 0 && nearest[0].sim >= Number(env.MEMORY_DEDUP_SIM)) {
      const id = nearest[0].id;
      await sql`
        update memories set
          text = ${m.text}, importance = ${m.importance}, confidence = ${m.confidence},
          evidence = ${evidence}::jsonb, embedding = ${lit}::vector,
          last_seen_at = now(), expires_at = ${expiresAt}
        where id = ${id}
      `;
      idByIndex[i] = id;
      updated++;
    } else {
      const [row] = await sql`
        insert into memories (user_id, kind, subject, subject_key, text, importance, confidence, evidence, origin, embedding, expires_at)
        values (${userId}, ${m.kind}, ${m.subject}, ${subjectKey}, ${m.text}, ${m.importance}, ${m.confidence}, ${evidence}::jsonb, ${origin}, ${lit}::vector, ${expiresAt})
        returning id
      `;
      idByIndex[i] = row.id;
      created++;
    }
  }

  return { created, updated, idByIndex };
}

export async function searchMemories(userId, queryText, limit) {
  if (!queryText || !queryText.trim()) return [];

  const vector = await embedOne(queryText, "RETRIEVAL_QUERY");
  const lit = toVectorLiteral(vector);

  const rows = await sql`
    select id, kind, subject, text, importance, last_seen_at, 1 - (embedding <=> ${lit}::vector) as sim
    from memories
    where user_id = ${userId} and superseded_by is null and embedding is not null
      and (expires_at is null or expires_at > now())
    order by embedding <=> ${lit}::vector limit ${limit}
  `;

  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    await sql`update memories set hit_count = hit_count + 1 where id = any(${ids}::bigint[])`;
  }

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    subject: r.subject,
    text: r.text,
    importance: r.importance,
    lastSeenAt: r.last_seen_at,
    sim: r.sim,
  }));
}

export async function searchArchive(userId, queryText, limit) {
  if (!queryText || !queryText.trim()) return [];
  return sql`
    select provider, kind, title, body, url, ts from context_items
    where user_id = ${userId} and body_tsv @@ plainto_tsquery('english', ${queryText})
    order by ts desc limit ${limit}
  `;
}

export async function domainSummary(userId, days) {
  return sql`
    select meta->>'host' as host, count(*)::int as pages, sum((meta->>'visitCount')::int)::int as visits
    from context_items
    where user_id = ${userId} and provider = 'browser' and kind = 'page'
      and ts > now() - (${days} || ' days')::interval
    group by 1 order by visits desc nulls last limit 25
  `;
}

export async function profileFor(userId) {
  const rows = await sql`select summary, sections, built_at from user_profile where user_id = ${userId}`;
  if (rows.length === 0) return null;
  return { summary: rows[0].summary, sections: rows[0].sections, builtAt: rows[0].built_at };
}

// ---------- distillation ----------

const DISTILL_SCHEMA = {
  type: "object",
  properties: {
    memories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["person", "project", "preference", "routine", "goal", "fact"] },
          subject: { type: "string" },
          text: { type: "string" },
          importance: { type: "number" },
          confidence: { type: "number" },
          evidence: { type: "array", items: { type: "string" } },
          expires_in_days: { type: "integer" },
          supersedes: { type: "array", items: { type: "integer" } },
        },
        required: ["kind", "subject", "text", "importance", "confidence", "evidence"],
      },
    },
  },
  required: ["memories"],
};

const DISTILL_INSTRUCTION =
  "You are building a durable memory of one person from their own archive: imported browser history and bookmarks, " +
  "WhatsApp threads, email, calendar, Slack, and their captured working days. Emit only facts that will still be " +
  "true and useful in a month: who the people around them are and how they relate, what projects and goals they are " +
  "pursuing, the tools and sites they actually work in, their routines, and their stated preferences. `subject` is " +
  "the person, project, tool, or topic the memory is about \u2014 reuse the exact subject string from `existing` when the " +
  "memory is about the same thing. One standalone sentence per memory, understandable with no other context. Never " +
  "store one-off trivia, transient status, credentials, ids, or anything you would not want read back to them. " +
  "`evidence` quotes the item title or thread it came from. `supersedes` lists ids from `existing` that this memory " +
  "corrects or replaces. At most 25 memories per pass; an empty array is a valid answer.";

const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    who: { type: "string" },
    work: { type: "string" },
    people: { type: "array", items: { type: "string" } },
    tools: { type: "array", items: { type: "string" } },
    routines: { type: "array", items: { type: "string" } },
    preferences: { type: "array", items: { type: "string" } },
    current_focus: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "who", "work", "people", "tools", "routines", "preferences", "current_focus"],
};

const PROFILE_INSTRUCTION =
  "Write a standing brief on this person from their memories, for an assistant that will read it before every " +
  "suggestion. `summary` is at most 1200 characters, dense, second person absent \u2014 plain statements of fact. " +
  "Arrays hold at most 8 short entries each. Do not speculate beyond the memories.";

export async function rebuildProfile(userId) {
  const memories = await sql`
    select kind, subject, text, importance from memories
    where user_id = ${userId} and superseded_by is null and (expires_at is null or expires_at > now())
    order by importance desc, last_seen_at desc limit 120
  `;

  if (memories.length === 0) {
    await sql`
      insert into user_profile (user_id, summary, sections, built_at, updated_at)
      values (${userId}, '', '{}'::jsonb, now(), now())
      on conflict (user_id) do update set summary = '', sections = '{}'::jsonb, built_at = now(), updated_at = now()
    `;
    return { summary: "", sections: {} };
  }

  const result = await chatJson({
    model: env.MODEL_REASON,
    messages: [{ role: "user", content: `${PROFILE_INSTRUCTION}\n\n${JSON.stringify(memories)}` }],
    schema: PROFILE_SCHEMA,
    maxTokens: 1500,
    deadlineMs: 45000,
  });
  const { summary, ...sections } = result;

  await sql`
    insert into user_profile (user_id, summary, sections, built_at, updated_at)
    values (${userId}, ${summary}, ${JSON.stringify(sections)}::jsonb, now(), now())
    on conflict (user_id) do update set
      summary = ${summary}, sections = ${JSON.stringify(sections)}::jsonb, built_at = now(), updated_at = now()
  `;
  return { summary, sections };
}

export async function runDistillPass(user, deadline) {
  const userId = user.id;

  await sql`insert into user_profile (user_id) values (${userId}) on conflict do nothing`;
  const [profileRow] = await sql`select distill_cursor from user_profile where user_id = ${userId}`;
  const cursor = profileRow.distill_cursor;

  const batch = Number(env.DISTILL_BATCH);
  const rows = await sql`
    select id, provider, kind, title, body, ts from context_items
    where user_id = ${userId} and id > ${cursor}
    order by id asc limit ${batch}
  `;

  if (rows.length === 0) {
    return { processed: 0, created: 0, updated: 0, remaining: 0, profileUpdated: false };
  }

  if (Date.now() >= deadline) {
    const [r] = await sql`select count(*)::int as n from context_items where user_id = ${userId} and id > ${cursor}`;
    return { processed: 0, created: 0, updated: 0, remaining: r.n, profileUpdated: false };
  }

  const maxProcessedId = rows[rows.length - 1].id;

  const items = rows.map((r) => ({
    provider: r.provider,
    kind: r.kind,
    title: String(r.title || "").slice(0, 200),
    body: String(r.body || "").slice(0, 600),
    ts: new Date(r.ts).toISOString().slice(0, 10),
  }));

  const payload = { items };
  if (rows.some((r) => r.provider === "browser")) {
    payload.browsing = await domainSummary(userId, 90);
  }
  payload.existing = await sql`
    select id, kind, subject, text from memories
    where user_id = ${userId} and superseded_by is null
    order by importance desc, last_seen_at desc limit 60
  `;
  const recentReviewRows = await sql`
    select payload from day_reviews where user_id = ${userId} and status = 'completed'
    order by day desc limit 3
  `;
  payload.recent_reviews = recentReviewRows.map((r) => ({
    day_summary: r.payload?.day_summary,
    commitments: r.payload?.commitments,
  }));

  const result = await chatJson({
    model: env.MODEL_REASON,
    messages: [{ role: "user", content: `${DISTILL_INSTRUCTION}\n\n${JSON.stringify(payload)}` }],
    schema: DISTILL_SCHEMA,
    maxTokens: 2500,
    deadlineMs: 45000,
  });
  const produced = result.memories || [];

  const { created, updated, idByIndex } = await upsertMemories(userId, produced, "import");

  for (let i = 0; i < produced.length; i++) {
    const m = produced[i];
    if (m.supersedes && m.supersedes.length > 0) {
      const newId = idByIndex[i];
      const oldIds = m.supersedes;
      await sql`
        update memories set superseded_by = ${newId}
        where user_id = ${userId} and id = any(${oldIds}::bigint[]) and id <> ${newId}
      `;
    }
  }

  await sql`update user_profile set distill_cursor = ${maxProcessedId}, updated_at = now() where user_id = ${userId}`;

  let profileUpdated = false;
  if (created + updated > 0 && Date.now() < deadline) {
    // The memories above are already durably persisted and distill_cursor already advanced;
    // a transient failure rebuilding the summary must not look like the whole pass failed,
    // and must not get silently stranded (no more un-distilled items to retrigger it).
    try {
      await rebuildProfile(userId);
      profileUpdated = true;
    } catch (err) {
      logError("knowledge_rebuild_profile_failed", err, { userId });
    }
  }

  const [remainingRow] = await sql`
    select count(*)::int as n from context_items where user_id = ${userId} and id > ${maxProcessedId}
  `;

  return { processed: rows.length, created, updated, remaining: remainingRow.n, profileUpdated };
}
