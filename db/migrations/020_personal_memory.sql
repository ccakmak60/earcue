-- The memory layer now holds mail, chat, calendar and documents, not only browsing. Four changes:

-- 1. Provenance. A memory records the context_items it was distilled from, so removing an import
--    (or excluding a domain) can also remove the memories that only that data supported, and a
--    recommendation can cite where a memory came from. Both sides cascade: forgetting a memory or
--    deleting an item drops the link, never the other row.
create table memory_sources (
  memory_id bigint not null references memories(id) on delete cascade,
  context_item_id bigint not null references context_items(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  primary key (memory_id, context_item_id)
);
create index memory_sources_item on memory_sources (context_item_id);

-- 2. Sensitivity. Health, money, legal and intimate facts are kept and recallable on request, but
--    never fed to proactive suggestions or the standing profile, which appear on screen unasked.
alter table memories add column sensitive boolean not null default false;

-- 3. People. Normalised addresses of everyone on an item: lowercase email for mail and calendar,
--    `slack:<user id>`, `whatsapp:<name>`. Derived at write time by participantsOf() in
--    src/lib/shared/participants.ts; the backfill below mirrors it for rows already stored.
alter table context_items add column participants text[] not null default '{}';

update context_items ci set participants = coalesce((
  select array_agg(distinct p) from (
    select lower(trim(coalesce(substring(ci.meta->>'from' from '<([^>]+)>'), ci.meta->>'from'))) as p
    where ci.kind = 'email'
    union all
    select lower(trim(a)) from jsonb_array_elements_text(
      case when jsonb_typeof(ci.meta->'attendees') = 'array' then ci.meta->'attendees' else '[]'::jsonb end
    ) as a
    where ci.kind = 'event'
  ) s where p like '%_@_%'
), '{}')
where ci.kind in ('email', 'event');

update context_items set participants = array['slack:' || (meta->>'user')]
where provider = 'slack' and kind = 'message' and coalesce(meta->>'user', '') <> '';

update context_items ci set participants = coalesce((
  select array_agg(distinct 'whatsapp:' || lower(trim(p)))
  from jsonb_array_elements_text(ci.meta->'participants') as p
  where trim(p) <> ''
), '{}')
where ci.kind = 'chat' and jsonb_typeof(ci.meta->'participants') = 'array';

create index context_items_participants on context_items using gin (participants);

-- 4. Document embeddings. Text-bearing items (not bare history/bookmark titles) get a vector so
--    recall can find the email or chat behind a question by meaning, not just by shared words.
--    Filled by the distill pass and by `npm run reembed`; the partial index is their work queue,
--    and its kind list must match EMBED_KINDS in src/lib/server/knowledge.ts.
alter table context_items add column embedding vector(768);
create index context_items_unembedded on context_items (user_id, id)
  where embedding is null and kind in ('email', 'message', 'chat', 'doc', 'page_text', 'event', 'episode');

-- No approximate index on either vector column. 008's global HNSW index on memories answered a
-- per-user query by scanning ~40 neighbours across every account, then discarding the other
-- accounts' rows: with 20 users of 500 memories each, one user's top-30 came back with 2 rows.
-- Recall now does an exact scan over the user's own rows (memories_user_live / the user_id btree
-- on context_items), which is correct at any tenant count and cheap at per-person row counts.
drop index if exists memories_embedding;
