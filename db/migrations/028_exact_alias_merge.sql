-- Aliases merge on an exact address only (owner decision, harness step 11, revising D6).
--
-- Migration 026's link_participants also merged a WhatsApp contact and a mail display name with
-- exactly the same name (alias source `name`). A name is not an identity: two people can share one,
-- and a wrong merge mixes their memories. From here a new participant key joins an existing entity
-- only when it is that entity's exact address; everything else gets its own person, and the person
-- merges two people by hand (POST /api/assist/entity-merge, source `merge`) or confirms their own
-- WhatsApp name (source `confirmed`).

-- 1. link_participants without the name rule. Same signature, so insertContextItems() is unchanged.
create or replace function link_participants(p_user uuid, p_items bigint[], p_keys text[], p_names text[], p_roles text[]) returns integer
language plpgsql as $$
declare
  v_self bigint;
  v_entity bigint;
  v_label text;
  v_linked integer;
  r record;
begin
  if coalesce(cardinality(p_keys), 0) = 0 then
    return 0;
  end if;
  v_self := ensure_self_entity(p_user);

  -- An address seen before without a display name gets the one seen now.
  update entity_aliases a set label = x.label
  from (
    select distinct on (key) key, lower(btrim(name)) as label
    from unnest(p_keys, p_names) as k(key, name)
    where btrim(coalesce(name, '')) <> '' and key like '%@%'
    order by key
  ) x
  where a.user_id = p_user and a.alias = x.key and a.label = '';

  -- The person themselves is "You" until an address of theirs is seen with a display name.
  update entities e set name = x.name, name_key = entity_name_key(x.name)
  from (
    select btrim(k.name) as name
    from unnest(p_keys, p_names) as k(key, name)
    join entity_aliases a on a.user_id = p_user and a.alias = k.key and a.entity_id = v_self
    where btrim(coalesce(k.name, '')) <> ''
    limit 1
  ) x
  where e.id = v_self and e.name = 'You';

  -- A key with no alias yet is a new person. (An exact address already held by an entity has an
  -- alias, so it is linked below without passing through here.)
  for r in
    select distinct on (k.key) k.key, btrim(coalesce(k.name, '')) as name
    from unnest(p_keys, p_names) with ordinality as k(key, name, ord)
    where coalesce(k.key, '') <> ''
      and not exists (select 1 from entity_aliases a where a.user_id = p_user and a.alias = k.key)
    order by k.key, btrim(coalesce(k.name, '')) = '', k.ord
  loop
    v_label := lower(r.name);
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

-- 2. Undo the name merges 026 made (none in production, which never ran 026 before this): each
--    `name` alias moves to a person of its own, with the items that carry it, as move_alias moves a
--    confirmed WhatsApp name. Memories stay with the entity they were linked to.
--    The new person is named as link_participants would have named it: a WhatsApp contact by the
--    name as the chat export wrote it, an address by its display name, else the address.
do $$
declare
  r record;
  v_name text;
  v_entity bigint;
begin
  for r in select user_id, alias, label from entity_aliases where source = 'name' order by user_id, alias loop
    if r.alias like 'whatsapp:%' then
      select btrim(n) into v_name
      from context_items ci, jsonb_array_elements_text(case when jsonb_typeof(ci.meta->'participants') = 'array' then ci.meta->'participants' else '[]'::jsonb end) n
      where ci.user_id = r.user_id and ci.participants @> array[r.alias] and 'whatsapp:' || lower(btrim(n)) = r.alias
      order by ci.id limit 1;
      v_name := coalesce(v_name, substring(r.alias from 10));
    else
      select btrim(btrim(m[1]), '"') into v_name
      from context_items ci,
           regexp_matches(concat_ws(', ', ci.meta->>'from', ci.meta->>'to', ci.meta->>'cc'), '("[^"]*"|[^,<>"]*)\s*<([^>]+)>', 'g') as m
      where ci.user_id = r.user_id and ci.participants @> array[r.alias] and lower(btrim(m[2])) = r.alias and btrim(btrim(m[1]), '"') <> ''
      order by ci.id limit 1;
      v_name := coalesce(v_name, nullif(r.label, ''), r.alias);
    end if;
    insert into entities (user_id, kind, name, name_key)
      values (r.user_id, 'person', v_name, entity_name_key(case when r.alias like '%@%' and r.label = '' then split_part(r.alias, '@', 1) else v_name end))
      returning id into v_entity;
    perform move_alias(r.user_id, r.alias, v_entity, 'participant');
  end loop;
end $$;

-- 3. `name` is no longer a reason an alias belongs to its entity.
alter table entity_aliases drop constraint entity_aliases_source_check;
alter table entity_aliases add constraint entity_aliases_source_check check (source in ('participant', 'confirmed', 'merge'));
