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
  whatsapp_waha: { provider: "whatsapp", raw: null },
  gmail_backfill: { provider: "google", raw: null },
  doc: { provider: "upload", raw: null },
};

export const MEMORY_KINDS = ["person", "project", "preference", "routine", "goal", "fact", "episode"];
export const BASE_CONTAINERS = ["self", "work", "personal"];

export function normalizeContainer(raw) {
  const s = String(raw || "").toLowerCase().trim().replace(/\s+/g, "-");
  return /^[a-z0-9_:-]{1,100}$/.test(s) ? s : "self";
}

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
    const container = normalizeContainer(m.container);

    const nearest = await sql`
      select id, origin, 1 - (embedding <=> ${lit}::vector) as sim from memories
      where user_id = ${userId} and kind = ${m.kind} and subject_key = ${subjectKey}
        and superseded_by is null and forgotten_at is null and embedding is not null
      order by embedding <=> ${lit}::vector limit 1
    `;

    if (nearest.length > 0 && nearest[0].sim >= Number(env.MEMORY_DEDUP_SIM)) {
      const id = nearest[0].id;
      // A derived memory must never overwrite a first-party one: record the match
      // but leave the existing row untouched.
      if (origin === "derived" && nearest[0].origin !== "derived") {
        idByIndex[i] = id;
        continue;
      }
      await sql`
        update memories set
          text = ${m.text},
          container = ${container},
          importance = least(1.0, greatest(importance + 0.05, ${m.importance})),
          confidence = greatest(confidence, ${m.confidence}),
          evidence = ${evidence}::jsonb, embedding = ${lit}::vector,
          last_seen_at = now(), expires_at = ${expiresAt}, forgotten_at = null
        where id = ${id}
      `;
      idByIndex[i] = id;
      updated++;
    } else {
      const [row] = await sql`
        insert into memories (user_id, kind, subject, subject_key, text, container, importance, confidence, evidence, origin, embedding, expires_at)
        values (${userId}, ${m.kind}, ${m.subject}, ${subjectKey}, ${m.text}, ${container}, ${m.importance}, ${m.confidence}, ${evidence}::jsonb, ${origin}, ${lit}::vector, ${expiresAt})
        returning id
      `;
      idByIndex[i] = row.id;
      created++;
    }
  }

  return { created, updated, idByIndex };
}

export async function applyRelations(userId, produced, idByIndex) {
  let edges = 0;
  for (let i = 0; i < produced.length; i++) {
    const newId = idByIndex[i];
    if (!newId) continue;
    for (const rel of produced[i].relations || []) {
      const targetId = Number(rel.target_id);
      if (!Number.isInteger(targetId) || targetId === Number(newId)) continue;
      if (rel.relation !== "updates" && rel.relation !== "extends") continue;
      const [target] = await sql`select id from memories where id = ${targetId} and user_id = ${userId}`;
      if (!target) continue;
      await sql`
        insert into memory_edges (user_id, src_id, dst_id, relation)
        values (${userId}, ${newId}, ${targetId}, ${rel.relation})
        on conflict (src_id, dst_id, relation) do nothing
      `;
      if (rel.relation === "updates") {
        await sql`update memories set superseded_by = ${newId} where user_id = ${userId} and id = ${targetId} and id <> ${newId}`;
      }
      edges++;
    }
  }
  return edges;
}

// ---------- recall ----------

const RERANK_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, score: { type: "number" } },
        required: ["id", "score"],
      },
    },
  },
  required: ["scores"],
};

const RERANK_INSTRUCTION =
  "Score how well each memory answers the query, 0 to 1. Return one entry per input id and nothing else. " +
  "A memory that is merely on the same topic scores below 0.4; a memory that directly answers the query scores above 0.8.";

async function rerankMemories(query, rows) {
  const payload = { query, memories: rows.map((r) => ({ id: Number(r.id), text: r.text, subject: r.subject })) };
  let scored;
  try {
    scored = await chatJson({
      model: env.MODEL_REASON,
      messages: [{ role: "user", content: `${RERANK_INSTRUCTION}\n\n${JSON.stringify(payload)}` }],
      schema: RERANK_SCHEMA,
      maxTokens: 600,
      deadlineMs: 20000,
    });
  } catch (err) {
    logError("memory_rerank_failed", err, {});
    return rows;
  }
  const byId = new Map((scored.scores || []).map((s) => [Number(s.id), Number(s.score)]));
  return [...rows].sort((a, b) => (byId.get(Number(b.id)) ?? 0) - (byId.get(Number(a.id)) ?? 0) || b.score - a.score);
}

export async function recall(userId, { query, container = null, limit = 8, includeRelated = false, rerank = false } = {}) {
  const q = String(query || "").trim();
  if (!q) return { memories: [], documents: [], related: [] };

  const depth = Number(env.RECALL_CANDIDATES);
  const k = Number(env.RECALL_RRF_K);
  const space = container ? normalizeContainer(container) : null;
  const lit = toVectorLiteral(await embedOne(q, "RETRIEVAL_QUERY"));

  const fused = await sql`
    with mv as (
      select id, row_number() over (order by embedding <=> ${lit}::vector) as rank
      from memories
      where user_id = ${userId} and superseded_by is null and forgotten_at is null
        and embedding is not null and (expires_at is null or expires_at > now())
        and (${space}::text is null or container = ${space}::text)
      order by embedding <=> ${lit}::vector
      limit ${depth}
    ),
    mf as (
      select m.id, row_number() over (order by ts_rank_cd(m.text_tsv, tq.q) desc) as rank
      from memories m, plainto_tsquery('english', ${q}) as tq(q)
      where m.user_id = ${userId} and m.superseded_by is null and m.forgotten_at is null
        and (m.expires_at is null or m.expires_at > now())
        and (${space}::text is null or m.container = ${space}::text)
        and m.text_tsv @@ tq.q
      order by ts_rank_cd(m.text_tsv, tq.q) desc
      limit ${depth}
    ),
    fused as (
      select id, sum(w) as rrf from (
        select id, 1.0 / (${k} + rank) as w from mv
        union all
        select id, 0.8 / (${k} + rank) as w from mf
      ) parts group by id
    )
    select m.id, m.kind, m.subject, m.text, m.container, m.origin, m.importance, m.confidence, m.last_seen_at,
           memory_strength(m.importance, m.kind, m.last_seen_at) as strength,
           f.rrf * (1 + 0.5 * memory_strength(m.importance, m.kind, m.last_seen_at)) as score
    from fused f join memories m on m.id = f.id
    order by score desc
    limit ${limit}
  `;

  const documents = await sql`
    select provider, kind, title, body, url, ts
    from context_items ci, plainto_tsquery('english', ${q}) as tq(q)
    where ci.user_id = ${userId} and ci.body_tsv @@ tq.q
    order by ts_rank_cd(ci.body_tsv, tq.q) desc, ci.ts desc
    limit ${Math.max(3, Math.ceil(limit / 2))}
  `;

  let ordered = fused;
  if (rerank && fused.length > 1) ordered = await rerankMemories(q, fused);

  if (ordered.length > 0) {
    const ids = ordered.map((r) => r.id);
    await sql`update memories set hit_count = hit_count + 1 where id = any(${ids}::bigint[])`;
  }

  const memories = ordered.map((r) => ({
    id: r.id, kind: r.kind, subject: r.subject, text: r.text, container: r.container,
    origin: r.origin, importance: r.importance, strength: r.strength, score: r.score,
    lastSeenAt: r.last_seen_at,
  }));

  let related = [];
  if (includeRelated && memories.length > 0) {
    const ids = memories.map((m) => m.id);
    related = await sql`
      select e.relation, e.src_id, e.dst_id,
             other.id as id, other.subject, other.text, other.container
      from memory_edges e
      join memories other on other.id = case when e.src_id = any(${ids}::bigint[]) then e.dst_id else e.src_id end
      where e.user_id = ${userId}
        and (e.src_id = any(${ids}::bigint[]) or e.dst_id = any(${ids}::bigint[]))
        and other.forgotten_at is null
      limit 40
    `;
  }

  return { memories, documents, related };
}

export async function containersFor(userId) {
  const rows = await sql`
    select container, count(*)::int as memories
    from memories
    where user_id = ${userId} and superseded_by is null and forgotten_at is null
      and (expires_at is null or expires_at > now())
    group by container order by memories desc
  `;
  return rows.map((r) => ({ container: r.container, memories: r.memories }));
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
  const rows = await sql`
    select summary, static_facts, dynamic_facts, buckets, built_at from user_profile where user_id = ${userId}
  `;
  if (rows.length === 0) return null;
  return {
    summary: rows[0].summary,
    static: rows[0].static_facts || [],
    dynamic: rows[0].dynamic_facts || [],
    buckets: rows[0].buckets || {},
    builtAt: rows[0].built_at,
  };
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
          kind: { type: "string", enum: MEMORY_KINDS },
          subject: { type: "string" },
          text: { type: "string" },
          container: { type: "string" },
          importance: { type: "number" },
          confidence: { type: "number" },
          evidence: { type: "array", items: { type: "string" } },
          expires_in_days: { type: "integer" },
          relations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                target_id: { type: "integer" },
                relation: { type: "string", enum: ["updates", "extends"] },
              },
              required: ["target_id", "relation"],
            },
          },
        },
        required: ["kind", "subject", "text", "container", "importance", "confidence", "evidence"],
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
  "`evidence` quotes the item title or thread it came from. `container` is the space this memory belongs to: " +
  "reuse one of the strings in `containers` when it fits, use `project:<kebab-slug>` for a distinct piece of work, " +
  "`work` or `personal` for general life areas, and `self` when the memory is about the person themselves. " +
  "`relations` links this memory to ids from `existing`: `updates` when it corrects or replaces that memory " +
  "(the old one stops being returned), `extends` when it adds detail and both stay true. Use `episode` kind for " +
  "something that happened at a point in time; it decays quickly unless it recurs. " +
  "At most 25 memories per pass; an empty array is a valid answer.";

export async function rollupTraceEpisodes(userId, tz, maxTraces = 600) {
  const [row] = await sql`select trace_cursor from user_profile where user_id = ${userId}`;
  const cursor = row?.trace_cursor || 0;
  const rows = await sql`
    select id, ts, local_day, kind, source, speaker, text from traces
    where user_id = ${userId} and id > ${cursor}
    order by id asc limit ${maxTraces}
  `;
  if (rows.length === 0) return { episodes: 0, traces: 0 };

  const gap = Number(env.EPISODE_GAP_MS);
  const hhmm = (ts) =>
    new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz || "UTC" });

  const dayKey = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));

  const groups = [];
  let cur = null;
  for (const r of rows) {
    const t = new Date(r.ts).getTime();
    const rDay = dayKey(r.local_day);
    if (!cur || rDay !== cur.localDay || t - cur.lastTs > gap || cur.lines.length >= 80) {
      cur = { firstId: r.id, lastId: r.id, localDay: rDay, firstTs: r.ts, lastTs: t, lines: [] };
      groups.push(cur);
    }
    cur.lastId = r.id;
    cur.lastTs = t;
    const tag = [r.kind, r.source, r.speaker].filter(Boolean).join("/");
    cur.lines.push(`${hhmm(r.ts)} [${tag}] ${String(r.text).slice(0, 400)}`);
  }

  // A session still in progress is held back rather than cut in half: its traces stay
  // beyond the cursor and roll up on the next pass.
  const last = groups[groups.length - 1];
  if (groups.length > 1 && Date.now() - last.lastTs < 600000) groups.pop();
  else if (groups.length === 1 && Date.now() - last.lastTs < 600000) return { episodes: 0, traces: 0 };

  const items = groups.map((g) => ({
    externalId: `ep:${g.firstId}`,
    ts: new Date(g.firstTs).toISOString(),
    kind: "episode",
    title: `Session ${g.localDay} ${hhmm(g.firstTs)}`,
    body: g.lines.join("\n").slice(0, 4000),
    url: null,
    meta: { firstTraceId: g.firstId, lastTraceId: g.lastId, lines: g.lines.length },
  }));

  await insertContextItems(userId, "earcue", null, items);
  const lastId = groups[groups.length - 1].lastId;
  await sql`update user_profile set trace_cursor = ${lastId}, updated_at = now() where user_id = ${userId}`;
  return { episodes: items.length, traces: rows.length };
}

const PROFILE_BUCKETS = ["preferences", "people", "projects", "tools", "routines", "goals"];

const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    static_facts: { type: "array", items: { type: "string" } },
    dynamic_facts: { type: "array", items: { type: "string" } },
    buckets: {
      type: "object",
      properties: Object.fromEntries(PROFILE_BUCKETS.map((b) => [b, { type: "array", items: { type: "string" } }])),
      required: PROFILE_BUCKETS,
    },
  },
  required: ["summary", "static_facts", "dynamic_facts", "buckets"],
};

const PROFILE_INSTRUCTION =
  "Write a standing brief on this person from their memories, for an assistant that will read it before every " +
  "suggestion. `summary` is at most 1200 characters, dense, second person absent \u2014 plain statements of fact. " +
  "`static_facts` are things that will still be true in a year: who they are, role, the people around them, " +
  "standing preferences, timezone and working habits \u2014 the facts an assistant must know no matter what is asked. " +
  "`dynamic_facts` are what is true right now and will expire: what they are working on this week, what they are " +
  "preparing for, what is unresolved. Sort each bucket most important first. At most 12 entries per array, " +
  "8 per bucket, each one short sentence. Do not speculate beyond the memories.";

export async function rebuildProfile(userId) {
  const memories = await sql`
    select id, kind, subject, text, container, importance, origin,
           memory_strength(importance, kind, last_seen_at) as strength
    from memories
    where user_id = ${userId} and superseded_by is null and forgotten_at is null
      and (expires_at is null or expires_at > now())
    order by (importance * memory_strength(importance, kind, last_seen_at)) desc, last_seen_at desc
    limit 120
  `;

  if (memories.length === 0) {
    await sql`
      insert into user_profile (user_id, summary, buckets, static_facts, dynamic_facts, built_at, updated_at)
      values (${userId}, '', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, now(), now())
      on conflict (user_id) do update set
        summary = '', buckets = '{}'::jsonb, static_facts = '[]'::jsonb, dynamic_facts = '[]'::jsonb,
        built_at = now(), updated_at = now()
    `;
    return { summary: "", static: [], dynamic: [], buckets: {} };
  }

  const result = await chatJson({
    model: env.MODEL_REASON,
    messages: [{ role: "user", content: `${PROFILE_INSTRUCTION}\n\n${JSON.stringify(memories)}` }],
    schema: PROFILE_SCHEMA,
    maxTokens: 1500,
    deadlineMs: 45000,
  });

  await sql`
    insert into user_profile (user_id, summary, buckets, static_facts, dynamic_facts, built_at, updated_at)
    values (${userId}, ${result.summary}, ${JSON.stringify(result.buckets)}::jsonb,
            ${JSON.stringify(result.static_facts)}::jsonb, ${JSON.stringify(result.dynamic_facts)}::jsonb, now(), now())
    on conflict (user_id) do update set
      summary = ${result.summary}, buckets = ${JSON.stringify(result.buckets)}::jsonb,
      static_facts = ${JSON.stringify(result.static_facts)}::jsonb, dynamic_facts = ${JSON.stringify(result.dynamic_facts)}::jsonb,
      built_at = now(), updated_at = now()
  `;
  return { summary: result.summary, static: result.static_facts, dynamic: result.dynamic_facts, buckets: result.buckets };
}

const DERIVE_SCHEMA = {
  type: "object",
  properties: {
    derived: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: MEMORY_KINDS },
          subject: { type: "string" },
          text: { type: "string" },
          container: { type: "string" },
          importance: { type: "number" },
          confidence: { type: "number" },
          from_ids: { type: "array", items: { type: "integer" } },
        },
        required: ["kind", "subject", "text", "container", "importance", "confidence", "from_ids"],
      },
    },
  },
  required: ["derived"],
};

const DERIVE_INSTRUCTION =
  "You are given durable memories about one person. Infer facts that follow from combining two or more of them but " +
  "are not stated by any single one \u2014 what someone's role plus their daily reading implies about what they own, " +
  "which people cluster into which project, which routine explains which preference. Every entry must cite at least " +
  "two `from_ids`, must not restate an input memory, and must set `confidence` at 0.6 or below. At most 5 entries; " +
  "an empty array is the correct answer when nothing new follows.";

export async function runConsolidationPass(userId, deadline) {
  const rows = await sql`
    select id, kind, subject, text, container, importance from memories
    where user_id = ${userId} and superseded_by is null and forgotten_at is null
      and origin <> 'derived' and (expires_at is null or expires_at > now())
    order by last_seen_at desc limit 40
  `;
  if (rows.length < Number(env.DREAM_MIN_MEMORIES) || Date.now() >= deadline) return { derived: 0, edges: 0 };

  const result = await chatJson({
    model: env.MODEL_REASON,
    messages: [{ role: "user", content: `${DERIVE_INSTRUCTION}\n\n${JSON.stringify({ memories: rows })}` }],
    schema: DERIVE_SCHEMA,
    maxTokens: 1200,
    deadlineMs: 30000,
  });

  const known = new Set(rows.map((r) => Number(r.id)));
  const produced = (result.derived || []).filter(
    (d) => Array.isArray(d.from_ids) && d.from_ids.filter((x) => known.has(Number(x))).length >= 2
  );
  if (produced.length === 0) return { derived: 0, edges: 0 };

  const { created, idByIndex } = await upsertMemories(userId, produced, "derived");

  let edges = 0;
  for (let i = 0; i < produced.length; i++) {
    const newId = idByIndex[i];
    if (!newId) continue;
    for (const from of produced[i].from_ids) {
      if (!known.has(Number(from)) || Number(from) === Number(newId)) continue;
      await sql`
        insert into memory_edges (user_id, src_id, dst_id, relation)
        values (${userId}, ${newId}, ${Number(from)}, 'derives')
        on conflict (src_id, dst_id, relation) do nothing
      `;
      edges++;
    }
  }
  return { derived: created, edges };
}

export async function forgetStaleMemories() {
  const rows = await sql`
    update memories set forgotten_at = now()
    where forgotten_at is null and superseded_by is null
      and (
        (expires_at is not null and expires_at < now())
        or (kind = 'episode' and hit_count = 0
            and memory_strength(importance, kind, last_seen_at) < ${Number(env.MEMORY_FORGET_FLOOR)})
      )
    returning id
  `;
  return { forgotten: rows.length };
}

export async function runDistillPass(user, deadline) {
  const userId = user.id;

  await sql`insert into user_profile (user_id) values (${userId}) on conflict do nothing`;

  let episodes = 0;
  try {
    episodes = (await rollupTraceEpisodes(userId, user.tz)).episodes;
  } catch (err) {
    logError("trace_rollup_failed", err, { userId });
  }

  const [profileRow] = await sql`select distill_cursor from user_profile where user_id = ${userId}`;
  const cursor = profileRow.distill_cursor;

  const batch = Number(env.DISTILL_BATCH);
  const rows = await sql`
    select id, provider, kind, title, body, ts from context_items
    where user_id = ${userId} and id > ${cursor}
    order by id asc limit ${batch}
  `;

  if (rows.length === 0) {
    const [r] = await sql`select count(*)::int as n from context_items where user_id = ${userId} and id > ${cursor}`;
    return { processed: 0, created: 0, updated: 0, derived: 0, episodes, remaining: r.n, profileUpdated: false };
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
    select id, kind, subject, text, container from memories
    where user_id = ${userId} and superseded_by is null and forgotten_at is null
    order by importance desc, last_seen_at desc limit 60
  `;
  payload.containers = (await containersFor(userId))
    .map((c) => c.container)
    .concat(BASE_CONTAINERS)
    .filter((v, i, a) => a.indexOf(v) === i);
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
  await applyRelations(userId, produced, idByIndex);

  await sql`update user_profile set distill_cursor = ${maxProcessedId}, updated_at = now() where user_id = ${userId}`;

  let derived = 0;
  if (created + updated > 0 && Date.now() < deadline - 15000) {
    try {
      derived = (await runConsolidationPass(userId, deadline)).derived;
    } catch (err) {
      logError("memory_consolidation_failed", err, { userId });
    }
  }

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

  return { processed: rows.length, created, updated, derived, episodes, remaining: remainingRow.n, profileUpdated };
}

// ---------- manual remember ----------

const MANUAL_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: MEMORY_KINDS },
    subject: { type: "string" },
    text: { type: "string" },
    container: { type: "string" },
    importance: { type: "number" },
    confidence: { type: "number" },
    expires_in_days: { type: "integer" },
  },
  required: ["kind", "subject", "text", "container", "importance", "confidence"],
};

const MANUAL_INSTRUCTION =
  "Turn this one thing the person asked you to remember into a single durable memory. `text` is one standalone " +
  "sentence understandable with no other context, preserving their meaning. `subject` is the person, project, tool, " +
  "or topic it is about. Pick `container` from `containers` when one fits, else `self`. Set `expires_in_days` only " +
  "when the fact is explicitly time-bound.";

export async function addManualMemory(userId, rawText, container) {
  const containers = (await containersFor(userId)).map((c) => c.container).concat(BASE_CONTAINERS);
  const produced = await chatJson({
    model: env.MODEL_REASON,
    messages: [{
      role: "user",
      content: `${MANUAL_INSTRUCTION}\n\n${JSON.stringify({ remember: rawText, containers: [...new Set(containers)] })}`,
    }],
    schema: MANUAL_SCHEMA,
    maxTokens: 400,
    deadlineMs: 25000,
  });
  if (container) produced.container = container;
  produced.evidence = ["asked to remember"];
  const { idByIndex } = await upsertMemories(userId, [produced], "manual");
  return {
    id: idByIndex[0],
    kind: produced.kind,
    subject: produced.subject,
    text: produced.text,
    container: normalizeContainer(produced.container),
  };
}
