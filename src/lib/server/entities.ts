import "server-only";
import { participantEntries } from "@/lib/shared/participants";
import { sql } from "./db";

// Entities (memory architecture plan, Phase 3, migration 026): the people, projects, ideas,
// organisations, places and topics items and memories are about. The upkeep runs as SQL functions
// in the migration, so each call here is one subrequest:
//   - link_participants: when items are stored, their participants become people (aliases), with
//     decision D6's only automatic merges: an exact address, or a WhatsApp contact and a mail
//     display name with exactly the same name.
//   - link_memory_entities: distill and the chat name what a memory is about; it is found or made.
//   - merge_entities / move_alias: the person merges two people, or confirms their WhatsApp name.

export const ENTITY_KINDS = ["person", "project", "idea", "org", "place", "topic"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

// Kinds distill and the chat may name for a memory. Topics come from annotation's list later.
export const MEMORY_ENTITY_KINDS: readonly EntityKind[] = ["person", "project", "idea", "org", "place"];

// Links stored items to the people on them. Items with no participants cost nothing.
export async function linkParticipants(userId: string, items: { id: string | number; provider: string; kind: string; meta: Record<string, unknown> | null }[]): Promise<number> {
  const ids: (string | number)[] = [];
  const keys: string[] = [];
  const names: string[] = [];
  const roles: string[] = [];
  for (const item of items) {
    for (const p of participantEntries(item.provider, item.kind, item.meta)) {
      ids.push(item.id);
      keys.push(p.key);
      names.push(p.name);
      roles.push(p.role);
    }
  }
  if (keys.length === 0) return 0;
  const [row] = await sql`
    select link_participants(${userId}::uuid, ${ids}::bigint[], ${keys}::text[], ${names}::text[], ${roles}::text[]) as linked
  `;
  return Number(row.linked);
}

export interface EntityLink {
  memoryId: string | number;
  kind: string;
  name: string;
}

// Links memories to the entities they are about, making the ones that do not exist yet.
export async function linkMemoryEntities(userId: string, links: EntityLink[]): Promise<number> {
  const todo = links.filter((l) => (MEMORY_ENTITY_KINDS as readonly string[]).includes(l.kind) && l.name.trim());
  if (todo.length === 0) return 0;
  const [row] = await sql`
    select link_memory_entities(${userId}::uuid, ${todo.map((l) => l.memoryId)}::bigint[],
                                ${todo.map((l) => l.kind)}::text[], ${todo.map((l) => l.name.trim().slice(0, 200))}::text[]) as linked
  `;
  return Number(row.linked);
}

// The person's own merge of two entities of one kind (the People section). False when either is
// not theirs, they differ in kind, or `from` is the person themselves.
export async function mergeEntities(userId: string, from: string, into: string): Promise<boolean> {
  const [row] = await sql`select merge_entities(${userId}::uuid, ${from}::bigint, ${into}::bigint) as merged`;
  return row.merged === true;
}

// Entities nothing holds up any more: after items or memories are deleted (an import removed, a
// domain excluded, a connector disconnected, a memory forgotten), an entity with no item and no
// memory left goes, names and addresses with it; so does an alias no remaining item carries, unless
// the person gave it (confirmed, merged) or it is one of their own addresses. The person themselves
// always stays.
export async function pruneEntities(userId: string): Promise<void> {
  await sql`
    with gone as (
      delete from entities e
      where e.user_id = ${userId} and not e.is_self
        and not exists (select 1 from item_entities ie where ie.entity_id = e.id)
        and not exists (select 1 from memories m where m.entity_id = e.id)
      returning e.id
    )
    delete from entity_aliases a using entities e
    where a.entity_id = e.id and a.user_id = ${userId} and not e.is_self and a.source in ('participant', 'name')
      and e.id not in (select id from gone)
      and not exists (select 1 from context_items ci where ci.user_id = ${userId} and ci.participants @> array[a.alias])
  `;
}

// An entity id from a request body, or null when it cannot be one.
export function entityIdOf(raw: unknown): string | null {
  const id = String(raw ?? "");
  return /^[1-9]\d{0,17}$/.test(id) ? id : null;
}

// ---------- the person themselves ----------

export interface WhatsappSelf {
  // Exported chats (conversations) there are.
  chats: number;
  // The WhatsApp name the person confirmed as theirs, if any.
  confirmed: string | null;
  // Speakers in every chat: one of them is the person. `suggested` when it is already on their own
  // entity because it matches their mail display name exactly (decision D6).
  candidates: { name: string; suggested: boolean }[];
}

// Finds the person's own WhatsApp name as the plan says: the speaker who appears in every exported
// chat. With one chat both sides qualify, so the Sources view asks which one is them.
export async function whatsappSelf(userId: string): Promise<WhatsappSelf> {
  const rows = await sql`
    with speakers as (
      select distinct ci.thread_key, 'whatsapp:' || lower(btrim(n)) as key, btrim(n) as name
      from context_items ci,
           jsonb_array_elements_text(case when jsonb_typeof(ci.meta->'participants') = 'array' then ci.meta->'participants' else '[]'::jsonb end) as n
      where ci.user_id = ${userId} and ci.provider = 'whatsapp' and ci.kind = 'chat' and ci.thread_key is not null and btrim(n) <> ''
    ),
    total as (select count(distinct thread_key)::int as chats from speakers),
    confirmed as (
      select substring(a.alias from 10) as name from entity_aliases a join entities e on e.id = a.entity_id
      where a.user_id = ${userId} and e.is_self and a.source = 'confirmed' and a.alias like 'whatsapp:%'
      order by a.created_at desc limit 1
    )
    select t.chats, (select name from confirmed) as confirmed, c.name, c.suggested
    from total t
    left join lateral (
      select min(s.name) as name, bool_or(coalesce(self.is_self, false)) as suggested
      from speakers s
      left join entity_aliases a on a.user_id = ${userId} and a.alias = s.key
      left join entities self on self.id = a.entity_id and self.is_self
      group by s.key
      having count(distinct s.thread_key) = t.chats
    ) c on true
    order by c.name
  `;
  const chats = Number(rows[0]?.chats ?? 0);
  return {
    chats,
    confirmed: rows[0]?.confirmed ?? null,
    candidates: chats === 0 ? [] : rows.filter((r) => r.name).map((r) => ({ name: r.name, suggested: r.suggested === true })),
  };
}

// The person says `name` is them in WhatsApp: its alias moves to their own entity, with the chats
// it is on. False when no exported chat has that speaker.
export async function confirmWhatsappSelf(userId: string, name: string): Promise<boolean> {
  const key = `whatsapp:${name.trim().toLowerCase()}`;
  const [row] = await sql`
    select case when exists (
      select 1 from context_items where user_id = ${userId} and provider = 'whatsapp' and participants @> array[${key}]::text[]
    ) then move_alias(${userId}::uuid, ${key}, ensure_self_entity(${userId}::uuid), 'confirmed') else false end as moved
  `;
  return row.moved === true;
}

// ---------- reading ----------

// What the model may be told about entities, in one read. `you`: the names the person goes by,
// their own entity's name and the WhatsApp names on it (trusted state for annotate and distill,
// which cannot otherwise tell a chat line of theirs from anyone else's). `known`: up to `limit`
// entities, latest first, that the model may name or be offered: anything but people, and the
// people the person is actually in touch with (one they wrote to, one earcue has a memory about, a
// chat or Slack contact). A newsletter's sender is none of those.
export async function entityContext(userId: string, limit: number): Promise<{ you: string[]; known: { id: string; kind: string; name: string }[] }> {
  const rows = await sql`
    (select e.id, e.kind, e.name, true as is_self,
            (select coalesce(array_agg(substring(a.alias from 10) order by a.alias), '{}') from entity_aliases a
             where a.entity_id = e.id and a.alias like 'whatsapp:%') as whatsapp
     from entities e where e.user_id = ${userId} and e.is_self)
    union all
    (select e.id, e.kind, e.name, false, null
     from entities e
     where e.user_id = ${userId} and not e.is_self and ${limit}::int > 0
       and (e.kind <> 'person'
            or exists (select 1 from memories m where m.entity_id = e.id and m.forgotten_at is null)
            or exists (select 1 from entity_aliases a where a.entity_id = e.id and (a.alias like 'whatsapp:%' or a.alias like 'slack:%'))
            or exists (select 1 from item_entities ie join context_items ci on ci.id = ie.context_item_id
                       where ie.entity_id = e.id and ie.role = 'to' and ci.meta->>'sent' = 'true'))
     order by e.last_seen_at desc, e.id desc
     limit greatest(${limit}::int, 0))
  `;
  const you = new Set<string>();
  const known: { id: string; kind: string; name: string }[] = [];
  for (const r of rows) {
    if (r.is_self) {
      if (r.name !== "You") you.add(r.name);
      for (const w of (r.whatsapp as string[]) ?? []) you.add(w);
    } else known.push({ id: String(r.id), kind: r.kind, name: r.name });
  }
  return { you: [...you], known };
}

export interface PersonSummary {
  id: string;
  name: string;
  aliases: string[];
  items: number;
  items90d: number;
  lastContact: string | null;
  topTopics: string[];
  memories: number;
}

const iso = (ts: unknown) => (ts ? new Date(ts as string).toISOString() : null);

// The People section's list: the people the person is in touch with (entityContext's rule), latest
// contact first. Private memories are not counted.
export async function peopleList(userId: string, limit = 60): Promise<PersonSummary[]> {
  const rows = await sql`
    select e.id, e.name, pa.items, pa.items_90d, pa.last_contact, pa.top_topics,
           (select count(*) from memories m where m.entity_id = e.id and m.superseded_by is null and m.forgotten_at is null and not m.sensitive)::int as memories,
           (select coalesce(array_agg(a.alias order by a.alias), '{}') from entity_aliases a where a.entity_id = e.id) as aliases
    from entities e join person_activity pa on pa.entity_id = e.id
    where e.user_id = ${userId} and pa.user_id = ${userId} and e.kind = 'person' and not e.is_self
      and (exists (select 1 from memories m where m.entity_id = e.id and m.forgotten_at is null)
           or exists (select 1 from entity_aliases a where a.entity_id = e.id and (a.alias like 'whatsapp:%' or a.alias like 'slack:%'))
           or pa.last_outbound is not null)
    order by pa.last_contact desc nulls last, e.name
    limit ${limit}
  `;
  return rows.map((r) => ({
    id: String(r.id),
    name: r.name,
    aliases: r.aliases,
    items: r.items,
    items90d: r.items_90d,
    lastContact: iso(r.last_contact),
    topTopics: r.top_topics ?? [],
    memories: r.memories,
  }));
}

export interface EntityMemoryRow {
  id: string | number;
  kind: string;
  subject: string;
  text: string;
  container: string;
  sensitive: boolean;
  strength: number;
}

export interface EntityItemRow {
  id: string | number;
  provider: string;
  kind: string;
  title: string;
  ts: string | null;
  from: string | null;
  sent: boolean;
  role: string;
}

export interface EntityData {
  entity: { id: string; kind: string; name: string; status: string | null; isSelf: boolean; aliases: string[] };
  activity: { items: number; items90d: number; lastInbound: string | null; lastOutbound: string | null; lastContact: string | null; medianGapDays: number | null; topTopics: string[] } | null;
  memories: EntityMemoryRow[];
  itemsTotal: number;
  recent: EntityItemRow[];
}

// One entity as the `person` and `entity` tools and the People section read it: its aliases, a
// person's activity, the live memories about it (sensitive ones only when `includeSensitive`) and
// the latest items linked to it. A memory is about it when linked to it, or, when linked to
// nothing (a manual or derived memory), when its subject has the entity's name. Null when the id
// is not this account's.
export async function entityData(userId: string, entityId: string, { includeSensitive = false, memoryLimit = 12, itemLimit = 8 } = {}): Promise<EntityData | null> {
  const [entityRows, activity, memories, items] = await Promise.all([
    sql`
      select e.id, e.kind, e.name, e.status, e.is_self,
             (select coalesce(array_agg(a.alias order by a.alias), '{}') from entity_aliases a where a.entity_id = e.id) as aliases
      from entities e where e.id = ${entityId} and e.user_id = ${userId}
    `,
    sql`
      select items, items_90d, last_inbound, last_outbound, last_contact, median_gap_days, top_topics
      from person_activity where user_id = ${userId} and entity_id = ${entityId}
    `,
    sql`
      select id, kind, subject, text, container, sensitive, memory_strength(importance, kind, last_seen_at) as strength
      from memories
      where user_id = ${userId} and superseded_by is null and forgotten_at is null
        and (entity_id = ${entityId}
             or (entity_id is null and subject_key <> ''
                 and subject_key = (select name_key from entities where id = ${entityId} and user_id = ${userId})))
        and (expires_at is null or expires_at > now())
        and (${includeSensitive}::boolean or not sensitive)
      order by importance desc, last_seen_at desc
      limit ${memoryLimit}
    `,
    sql`
      select ci.id, ci.provider, ci.kind, ci.title, ci.ts, ci.meta->>'from' as sender, ci.meta->>'sent' as sent,
             min(ie.role) as role, count(*) over () as total
      from item_entities ie join context_items ci on ci.id = ie.context_item_id
      where ie.entity_id = ${entityId} and ie.user_id = ${userId}
      group by ci.id
      order by ci.ts desc
      limit ${itemLimit}
    `,
  ]);
  const e = entityRows[0];
  if (!e) return null;
  const a = activity[0];
  return {
    entity: { id: String(e.id), kind: e.kind, name: e.name, status: e.status ?? null, isSelf: e.is_self === true, aliases: e.aliases },
    activity: a
      ? {
          items: a.items,
          items90d: a.items_90d,
          lastInbound: iso(a.last_inbound),
          lastOutbound: iso(a.last_outbound),
          lastContact: iso(a.last_contact),
          medianGapDays: a.median_gap_days === null ? null : Math.round(Number(a.median_gap_days) * 10) / 10,
          topTopics: a.top_topics ?? [],
        }
      : null,
    memories: memories as EntityMemoryRow[],
    itemsTotal: Number(items[0]?.total ?? 0),
    recent: items.map((r) => ({
      id: r.id,
      provider: r.provider,
      kind: r.kind,
      title: r.title,
      ts: iso(r.ts),
      from: r.sender ?? null,
      sent: r.sent === "true",
      role: r.role,
    })),
  };
}

// The entity a model or a person means by `who`: an exact address or WhatsApp name first, then an
// exact name, then a name that contains it; among equals the one seen most recently. `kind` limits
// it to one kind. Also returns up to two other matches, so an ambiguous name can be said to be one.
export async function findEntity(userId: string, who: string, kind: string | null = null): Promise<{ id: string; name: string; others: string[] } | null> {
  const needle = who.trim().toLowerCase();
  if (needle.length < 2) return null;
  const key = needle.replace(/[^a-z0-9]+/g, " ").trim();
  const contains = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await sql`
    select e.id, e.name, min(case
      when a.alias = ${needle} or a.alias = ${`whatsapp:${needle}`} then 0
      when e.name_key = ${key} and ${key} <> '' then 1
      when a.label = ${needle} then 1
      else 2 end) as rank
    from entities e left join entity_aliases a on a.entity_id = e.id
    where e.user_id = ${userId} and (${kind}::text is null or e.kind = ${kind}::text)
      and (a.alias = ${needle} or a.alias = ${`whatsapp:${needle}`} or (e.name_key = ${key} and ${key} <> '')
           or a.label = ${needle} or e.name ilike ${contains})
    group by e.id
    order by rank, max(e.last_seen_at) desc, e.id desc
    limit 3
  `;
  if (rows.length === 0) return null;
  return { id: String(rows[0].id), name: rows[0].name, others: rows.slice(1).map((r) => r.name) };
}
