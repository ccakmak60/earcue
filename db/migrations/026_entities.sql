-- Entities and notes (memory architecture plan, Phase 3). What an item or a memory is about gets a
-- row of its own: a person (one row however many addresses they write from), a project, an idea,
-- an organisation, a place or a topic. Participants are linked to people when items are stored,
-- distill links each memory to the entity it is about, and annotation routes items to known ones.

-- 1. Entities. `name_key` is the name as memories.subject_key normalises a subject (lowercase ASCII
--    letters and digits, anything else a single space), so a subject and an entity name compare the
--    same way. Two people can share a name, so only non-person kinds are unique by name. `status`
--    is for projects and ideas. One person row per account is the person themselves (`is_self`).
--    `summary` and `summary_built_at` are for per-entity summaries, which nothing writes yet.
create table entities (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('person', 'project', 'idea', 'org', 'place', 'topic')),
  name text not null,
  name_key text not null,
  status text check (status in ('active', 'parked', 'done')),
  is_self boolean not null default false,
  summary text not null default '',
  summary_built_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  check (not is_self or kind = 'person'),
  check (status is null or kind in ('project', 'idea'))
);
create unique index entities_kind_name on entities (user_id, kind, name_key) where kind <> 'person';
create index entities_person_name on entities (user_id, name_key) where kind = 'person';
create unique index entities_self on entities (user_id) where is_self;

-- 2. Aliases: the participant keys participantsOf() produces (a lowercase email, `whatsapp:<name>`,
--    `slack:<id>`), one entity each. `label` is the display name seen with an address, lowercased
--    and trimmed. `source` says why the alias belongs to its entity:
--      participant  the entity was made for it, or it is one of the person's own addresses (self)
--      name         decision D6: a WhatsApp contact and a mail display name with exactly the same
--                   name (lowercased and trimmed), when exactly one entity carries that name
--      confirmed    the person said this WhatsApp name is theirs (the Sources view)
--      merge        the person merged two entities (the People section)
--    Nothing fuzzier merges on its own: a wrong merge mixes two people's memories.
create table entity_aliases (
  user_id uuid not null references users(id) on delete cascade,
  entity_id bigint not null references entities(id) on delete cascade,
  alias text not null,
  label text not null default '',
  source text not null default 'participant' check (source in ('participant', 'name', 'confirmed', 'merge')),
  created_at timestamptz not null default now(),
  primary key (user_id, alias)
);
create index entity_aliases_entity on entity_aliases (entity_id);
create index entity_aliases_label on entity_aliases (user_id, label) where label <> '';

-- 3. Which items are about which entities. `from` and `to` are linked from participants when an
--    item is stored; `mention` (a person) and `topic` (anything else) by annotation and by distill,
--    for the items a memory about the entity was drawn from.
create table item_entities (
  context_item_id bigint not null references context_items(id) on delete cascade,
  entity_id bigint not null references entities(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('from', 'to', 'mention', 'topic')),
  primary key (context_item_id, entity_id, role)
);
create index item_entities_entity on item_entities (entity_id, context_item_id);

-- 4. The entity a memory is about. subject_key stays, so recall and dedup work as before.
alter table memories add column entity_id bigint references entities(id) on delete set null;
create index memories_entity on memories (entity_id) where entity_id is not null;

-- 5. Notes: what the person tells earcue in Ask earcue is kept word for word as a context item
--    (provider earcue, kind note). Both work queues now take them; their kind lists must match
--    EMBED_KINDS in src/lib/server/knowledge.ts and ANNOTATE_KINDS in src/lib/server/annotate.ts.
drop index context_items_unembedded;
create index context_items_unembedded on context_items (user_id, id)
  where embedding is null and kind in ('email', 'message', 'chat', 'doc', 'page_text', 'event', 'episode', 'note');
drop index context_items_unannotated;
create index context_items_unannotated on context_items (user_id, id)
  where signals_at is null and kind in ('email', 'message', 'chat', 'doc', 'page_text', 'event', 'note');

-- ---------- functions ----------
-- Entity upkeep runs inside Postgres so that one call is one subrequest (Workers Free allows 50 per
-- request). src/lib/server/entities.ts calls them.

-- The same normalisation as subjectKeyOf() in src/lib/server/knowledge.ts.
create function entity_name_key(name text) returns text language sql immutable as $$
  select btrim(regexp_replace(lower(coalesce(name, '')), '[^a-z0-9]+', ' ', 'g'))
$$;

-- Moves everything of entity p_from onto p_into (same account, same kind) and deletes p_from:
-- its aliases (their source set to p_source), item links and memories. The person
-- themselves is never merged away. False when either entity is missing, foreign or of another kind.
create function merge_entities(p_user uuid, p_from bigint, p_into bigint, p_source text default 'merge') returns boolean
language plpgsql as $$
declare
  v_from entities;
  v_into entities;
begin
  select * into v_from from entities where id = p_from and user_id = p_user;
  select * into v_into from entities where id = p_into and user_id = p_user;
  if v_from.id is null or v_into.id is null or v_from.id = v_into.id or v_from.is_self or v_from.kind <> v_into.kind then
    return false;
  end if;
  update entity_aliases set entity_id = p_into, source = p_source
    where user_id = p_user and entity_id = p_from;
  insert into item_entities (context_item_id, entity_id, user_id, role)
    select context_item_id, p_into, user_id, role from item_entities where entity_id = p_from
    on conflict do nothing;
  update memories set entity_id = p_into where user_id = p_user and entity_id = p_from;
  update entities set first_seen_at = least(first_seen_at, v_from.first_seen_at), last_seen_at = greatest(last_seen_at, v_from.last_seen_at)
    where id = p_into;
  delete from entities where id = p_from;
  return true;
end $$;

-- One alias moves to entity p_into, with the items it is on; how the person confirms their own
-- WhatsApp name. The entity that held it keeps its other aliases, and when it has none left it was
-- only this alias, so what it still holds (memories) is merged into p_into.
create function move_alias(p_user uuid, p_alias text, p_into bigint, p_source text) returns boolean
language plpgsql as $$
declare
  v_old bigint;
begin
  perform 1 from entities where id = p_into and user_id = p_user;
  if not found then
    return false;
  end if;
  select entity_id into v_old from entity_aliases where user_id = p_user and alias = p_alias;
  insert into entity_aliases (user_id, entity_id, alias, source) values (p_user, p_into, p_alias, p_source)
    on conflict (user_id, alias) do update set entity_id = excluded.entity_id, source = excluded.source;
  insert into item_entities (context_item_id, entity_id, user_id, role)
    select ci.id, p_into, p_user,
           coalesce((select ie.role from item_entities ie where ie.context_item_id = ci.id and ie.entity_id = v_old and ie.role in ('from', 'to') limit 1), 'from')
    from context_items ci where ci.user_id = p_user and ci.participants @> array[p_alias]
    on conflict do nothing;
  if v_old is not null and v_old <> p_into then
    delete from item_entities ie using context_items ci
      where ie.entity_id = v_old and ie.context_item_id = ci.id and ie.role in ('from', 'to')
        and ci.participants @> array[p_alias]
        and not exists (select 1 from entity_aliases a where a.entity_id = v_old and ci.participants @> array[a.alias]);
    if not exists (select 1 from entity_aliases where entity_id = v_old) then
      perform merge_entities(p_user, v_old, p_into, p_source);
    end if;
  end if;
  return true;
end $$;

-- The person themselves: one person row per account, with their sign-in email and every account
-- they connected as aliases. An entity that already holds one of those addresses is the person (an
-- exact address), so it is merged in. Named after their sign-in name, else "You".
create function ensure_self_entity(p_user uuid) returns bigint language plpgsql as $$
declare
  v_self bigint;
  v_name text;
  r record;
begin
  select id into v_self from entities where user_id = p_user and is_self;
  if v_self is null then
    select nullif(btrim(au.name), '') into v_name from users u join "user" au on au.id = u.auth_user_id where u.id = p_user;
    insert into entities (user_id, kind, name, name_key, is_self)
      values (p_user, 'person', coalesce(v_name, 'You'), entity_name_key(coalesce(v_name, 'You')), true)
      on conflict do nothing returning id into v_self;
    if v_self is null then
      select id into v_self from entities where user_id = p_user and is_self;
    end if;
  end if;
  for r in
    select distinct lower(btrim(addr)) as alias from (
      select au.email as addr from users u join "user" au on au.id = u.auth_user_id where u.id = p_user
      union all
      select account_label from connections where user_id = p_user and account_label is not null
    ) a where addr like '%_@_%'
  loop
    insert into entity_aliases (user_id, entity_id, alias) values (p_user, v_self, r.alias) on conflict do nothing;
    if not found then
      perform merge_entities(p_user, a.entity_id, v_self, 'participant') from entity_aliases a
        where a.user_id = p_user and a.alias = r.alias and a.entity_id <> v_self;
    end if;
  end loop;
  return v_self;
end $$;

-- Links items to the people on them. Parallel arrays, one entry per (item, participant): the item
-- id, the participant key (participantsOf()), the display name seen with it ('' when none) and the
-- role (`from` or `to`). A key with no alias yet joins an entity by decision D6 or gets a new
-- person of its own:
--   - a WhatsApp contact joins the one entity whose mail display name is exactly its name;
--   - an address whose display name is exactly a WhatsApp contact's name joins that contact.
-- Returns the number of item links made.
create function link_participants(p_user uuid, p_items bigint[], p_keys text[], p_names text[], p_roles text[]) returns integer
language plpgsql as $$
declare
  v_self bigint;
  v_entity bigint;
  v_label text;
  v_matches bigint[];
  v_source text;
  v_linked integer;
  r record;
begin
  if coalesce(cardinality(p_keys), 0) = 0 then
    return 0;
  end if;
  v_self := ensure_self_entity(p_user);

  -- An address seen before without a display name gets the one seen now, for D6 later.
  update entity_aliases a set label = x.label
  from (
    select distinct on (key) key, lower(btrim(name)) as label
    from unnest(p_keys, p_names) as k(key, name)
    where btrim(coalesce(name, '')) <> '' and key like '%@%'
    order by key
  ) x
  where a.user_id = p_user and a.alias = x.key and a.label = '';

  for r in
    select distinct on (k.key) k.key, btrim(coalesce(k.name, '')) as name
    from unnest(p_keys, p_names) with ordinality as k(key, name, ord)
    where coalesce(k.key, '') <> ''
      and not exists (select 1 from entity_aliases a where a.user_id = p_user and a.alias = k.key)
    order by k.key, btrim(coalesce(k.name, '')) = '', k.ord
  loop
    v_label := lower(r.name);
    v_entity := null;
    v_source := 'participant';
    if r.key like 'whatsapp:%' then
      select array_agg(distinct a.entity_id) into v_matches from entity_aliases a
        where a.user_id = p_user and a.label = substring(r.key from 10) and a.alias like '%@%';
      if cardinality(v_matches) = 1 then
        v_entity := v_matches[1];
        v_source := 'name';
      end if;
    elsif r.key like '%@%' and v_label <> '' then
      select a.entity_id into v_entity from entity_aliases a where a.user_id = p_user and a.alias = 'whatsapp:' || v_label;
      if v_entity is not null then
        v_source := 'name';
      end if;
    end if;

    if v_entity is null then
      insert into entities (user_id, kind, name, name_key)
        values (p_user, 'person',
                coalesce(nullif(r.name, ''), case when r.key like 'whatsapp:%' then substring(r.key from 10) else r.key end),
                entity_name_key(coalesce(nullif(r.name, ''), case when r.key like 'whatsapp:%' then substring(r.key from 10) else split_part(r.key, '@', 1) end)))
        returning id into v_entity;
      insert into entity_aliases (user_id, entity_id, alias, label) values (p_user, v_entity, r.key, case when r.key like '%@%' then v_label else '' end)
        on conflict do nothing;
      -- Another request stored this alias first: the new row is not needed.
      if not found then
        delete from entities where id = v_entity;
      end if;
    else
      insert into entity_aliases (user_id, entity_id, alias, label, source)
        values (p_user, v_entity, r.key, case when r.key like '%@%' then v_label else '' end, v_source)
        on conflict do nothing;
    end if;
  end loop;

  insert into item_entities (context_item_id, entity_id, user_id, role)
    select distinct x.item, a.entity_id, p_user, x.role
    from unnest(p_items, p_keys, p_roles) as x(item, key, role)
    join entity_aliases a on a.user_id = p_user and a.alias = x.key
    join context_items ci on ci.id = x.item and ci.user_id = p_user
    on conflict do nothing;
  get diagnostics v_linked = row_count;

  update entities e set last_seen_at = greatest(e.last_seen_at, t.ts)
  from (
    select a.entity_id, max(ci.ts) as ts
    from unnest(p_items, p_keys) as x(item, key)
    join entity_aliases a on a.user_id = p_user and a.alias = x.key
    join context_items ci on ci.id = x.item
    group by a.entity_id
  ) t
  where e.id = t.entity_id and e.id <> v_self;

  return v_linked;
end $$;

-- Links memories to what they are about. Parallel arrays: the memory id, the entity kind and the
-- name distill (or the chat) gave. A project, idea, org, place or topic is found by kind and name
-- or created (projects and ideas as `active`). A person is the one linked to an item the memory was
-- drawn from whose name (or its first name) matches, else the only person of that name, else a new
-- one; two people of that name and no item to tell them apart leaves the memory unlinked. The items
-- the memory was drawn from are linked to the entity as `mention` (a person) or `topic`. Returns
-- the number of memories linked.
create function link_memory_entities(p_user uuid, p_memories bigint[], p_kinds text[], p_names text[]) returns integer
language plpgsql as $$
declare
  v_key text;
  v_name text;
  v_entity bigint;
  v_ids bigint[];
  v_linked integer := 0;
  i integer;
begin
  for i in 1 .. coalesce(cardinality(p_memories), 0) loop
    v_name := btrim(coalesce(p_names[i], ''));
    v_key := entity_name_key(v_name);
    continue when v_key = '' or p_kinds[i] not in ('person', 'project', 'idea', 'org', 'place', 'topic');
    perform 1 from memories where id = p_memories[i] and user_id = p_user;
    continue when not found;
    v_entity := null;
    if p_kinds[i] = 'person' then
      select e.id into v_entity
      from memory_sources s
      join item_entities ie on ie.context_item_id = s.context_item_id
      join entities e on e.id = ie.entity_id and e.kind = 'person'
      where s.memory_id = p_memories[i] and e.user_id = p_user
        and (e.name_key = v_key or e.name_key like v_key || ' %'
             or exists (select 1 from entity_aliases a where a.entity_id = e.id and (a.label = lower(v_name) or a.alias = 'whatsapp:' || lower(v_name))))
      order by e.is_self, e.id
      limit 1;
      if v_entity is null then
        select array_agg(id) into v_ids from entities where user_id = p_user and kind = 'person' and name_key = v_key;
        if v_ids is null then
          insert into entities (user_id, kind, name, name_key) values (p_user, 'person', v_name, v_key) returning id into v_entity;
        elsif cardinality(v_ids) = 1 then
          v_entity := v_ids[1];
        end if;
      end if;
    else
      insert into entities (user_id, kind, name, name_key, status)
        values (p_user, p_kinds[i], v_name, v_key, case when p_kinds[i] in ('project', 'idea') then 'active' end)
        on conflict (user_id, kind, name_key) where kind <> 'person' do update set last_seen_at = now()
        returning id into v_entity;
    end if;
    continue when v_entity is null;
    update memories set entity_id = v_entity where id = p_memories[i] and user_id = p_user;
    insert into item_entities (context_item_id, entity_id, user_id, role)
      select s.context_item_id, v_entity, p_user, case when p_kinds[i] = 'person' then 'mention' else 'topic' end
      from memory_sources s where s.memory_id = p_memories[i]
      on conflict do nothing;
    update entities set last_seen_at = now() where id = v_entity and not is_self;
    v_linked := v_linked + 1;
  end loop;
  return v_linked;
end $$;

-- ---------- person_activity ----------
-- Per person: items in the last 90 days, the last item from them, the last one the person sent
-- them (a sent email with them as a recipient), the last contact either way, the median gap in days between days in contact, and the three
-- topics (projects, ideas, …) most often on items with them. A view rather than counters: one
-- person's rows are few, and a view cannot drift. Callers filter by user_id and entity_id.
create view person_activity as
select e.user_id, e.id as entity_id,
       count(distinct ie.context_item_id) filter (where ci.ts > now() - interval '90 days')::int as items_90d,
       count(distinct ie.context_item_id)::int as items,
       max(ci.ts) filter (where ie.role = 'from' and ci.meta->>'sent' is distinct from 'true') as last_inbound,
       max(ci.ts) filter (where ie.role = 'to' and ci.meta->>'sent' = 'true') as last_outbound,
       max(ci.ts) as last_contact,
       (
         select percentile_cont(0.5) within group (order by g.gap)
         from (
           select extract(epoch from d.day - lag(d.day) over (order by d.day)) / 86400 as gap
           from (
             select distinct date_trunc('day', c2.ts) as day
             from item_entities i2 join context_items c2 on c2.id = i2.context_item_id
             where i2.entity_id = e.id and i2.role in ('from', 'to')
           ) d
         ) g
         where g.gap is not null
       ) as median_gap_days,
       (
         select coalesce(array_agg(t.name order by t.n desc, t.name), '{}')
         from (
           select te.name, count(*) as n
           from item_entities pi
           join item_entities ti on ti.context_item_id = pi.context_item_id and ti.role = 'topic'
           join entities te on te.id = ti.entity_id
           where pi.entity_id = e.id and pi.role in ('from', 'to')
           group by te.name
           order by n desc, te.name
           limit 3
         ) t
       ) as top_topics
from entities e
left join item_entities ie on ie.entity_id = e.id and ie.role in ('from', 'to')
left join context_items ci on ci.id = ie.context_item_id
where e.kind = 'person'
group by e.user_id, e.id;

-- ---------- backfill ----------

-- Participants of the items already stored, as insertContextItems() links new ones: the keys from
-- `participants` (migration 020), display names parsed from the mail headers and the WhatsApp
-- names in meta, `from` for the sender of an email, a chat's speakers and a Slack message's author,
-- `to` for everyone else.
do $$
declare
  u record;
begin
  for u in select id from users loop
    perform link_participants(u.id, coalesce(array_agg(x.item), '{}'), coalesce(array_agg(x.key), '{}'),
                              coalesce(array_agg(x.name), '{}'), coalesce(array_agg(x.role), '{}'))
    from (
      select ci.id as item, p.key,
             coalesce(
               case when ci.kind in ('email', 'event') then (
                 select btrim(btrim(m[1]), '"')
                 from regexp_matches(concat_ws(', ', ci.meta->>'from', ci.meta->>'to', ci.meta->>'cc',
                                               case when jsonb_typeof(ci.meta->'attendees') = 'array'
                                                    then (select string_agg(a, ', ') from jsonb_array_elements_text(ci.meta->'attendees') a) end),
                                     '("[^"]*"|[^,<>"]*)\s*<([^>]+)>', 'g') as m
                 where lower(btrim(m[2])) = p.key and btrim(btrim(m[1]), '"') <> ''
                 limit 1
               ) end,
               case when ci.kind = 'chat' and jsonb_typeof(ci.meta->'participants') = 'array' then (
                 select btrim(n) from jsonb_array_elements_text(ci.meta->'participants') n
                 where 'whatsapp:' || lower(btrim(n)) = p.key
                 limit 1
               ) end,
               ''
             ) as name,
             case
               when ci.kind = 'email' and p.key = lower(btrim(coalesce(substring(ci.meta->>'from' from '<([^>]+)>'), ci.meta->>'from'))) then 'from'
               when ci.kind in ('email', 'event') then 'to'
               else 'from'
             end as role
      from context_items ci, unnest(ci.participants) as p(key)
      where ci.user_id = u.id
      order by ci.id
    ) x;
  end loop;
end $$;

-- Person and project memories, by subject_key. A project is one entity per name. A person memory
-- joins the only person of that name (usually one just made from their mail or chats), or a new
-- person when there is none; two people of that name leave it unlinked, for the person to sort out.
insert into entities (user_id, kind, name, name_key, status, first_seen_at, last_seen_at)
select distinct on (user_id, subject_key) user_id, 'project', subject, subject_key, 'active', first_seen_at, last_seen_at
from memories
where kind = 'project' and subject_key <> '' and forgotten_reason is distinct from 'user'
order by user_id, subject_key, last_seen_at desc
on conflict do nothing;

insert into entities (user_id, kind, name, name_key, first_seen_at, last_seen_at)
select distinct on (m.user_id, m.subject_key) m.user_id, 'person', m.subject, m.subject_key, m.first_seen_at, m.last_seen_at
from memories m
where m.kind = 'person' and m.subject_key <> '' and m.forgotten_reason is distinct from 'user'
  and not exists (select 1 from entities e where e.user_id = m.user_id and e.kind = 'person' and e.name_key = m.subject_key)
order by m.user_id, m.subject_key, m.last_seen_at desc;

update memories m set entity_id = e.id
from entities e
where m.kind = 'project' and e.user_id = m.user_id and e.kind = 'project' and e.name_key = m.subject_key
  and m.forgotten_reason is distinct from 'user';

update memories m set entity_id = one.id
from (
  select user_id, name_key, min(id) as id from entities where kind = 'person' group by user_id, name_key having count(*) = 1
) one
where m.kind = 'person' and one.user_id = m.user_id and one.name_key = m.subject_key and m.subject_key <> ''
  and m.forgotten_reason is distinct from 'user';
