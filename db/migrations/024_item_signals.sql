-- Item signals, in shadow (memory architecture plan, Phase 1). A cheap pass (task `annotate`,
-- src/lib/server/annotate.ts) answers fixed questions about every text-bearing item: is it worth
-- keeping, how much does it matter, does the person owe a reply, did they promise something. This
-- migration only stores the answers. Nothing reads them to decide anything yet: distill, embedding,
-- recall and the briefing work exactly as before.

-- 1. The conversation an item belongs to, one key across providers: `gm:<Gmail threadId>`,
--    `wa:<first 32 hex of sha256(chat name)>` for an exported WhatsApp chat, `slack:<channel>:<thread
--    ts>` (a top-level Slack message uses its own ts, which is the thread_ts its replies carry).
--    threadKeyOf() in src/lib/server/knowledge.ts sets it on insert; the backfill mirrors it.
alter table context_items add column thread_key text;

update context_items set thread_key = case
  when provider = 'google' and coalesce(meta->>'threadId', '') <> '' then 'gm:' || (meta->>'threadId')
  when provider = 'whatsapp' and coalesce(meta->>'chat', '') <> ''
    then 'wa:' || left(encode(sha256(convert_to(meta->>'chat', 'UTF8')), 'hex'), 32)
  when provider = 'slack' and coalesce(meta->>'channelId', '') <> ''
    then 'slack:' || (meta->>'channelId') || ':' || coalesce(nullif(meta->>'threadTs', ''), split_part(external_id, ':', 2))
end
where provider in ('google', 'whatsapp', 'slack');

create index context_items_thread on context_items (user_id, thread_key, ts) where thread_key is not null;

-- 2. The answers. The ones later phases query are columns; the rest (sensitive, and later topic and
--    entity choices) stay in `signals`. An item is pending while signals_at is null: a new item, or
--    one whose title or body changed. While pending, `signals` holds only {"attempts": n}, the
--    answered calls that left this item out, so one item the model keeps skipping cannot hold the
--    head of the queue (annotate gives up at 3). `signals_model` is the deployment that answered.
alter table context_items
  add column triage text check (triage in ('drop', 'keep', 'key')),
  add column salience real,
  add column needs_reply real,
  add column commitment real,
  add column signals jsonb,
  add column signals_model text,
  add column signals_at timestamptz;

-- The annotate work queue, as context_items_unembedded is the embedding one. Its kind list must
-- match ANNOTATE_KINDS in src/lib/server/annotate.ts, or the pending lookup stops using it.
create index context_items_unannotated on context_items (user_id, id)
  where signals_at is null and kind in ('email', 'message', 'chat', 'doc', 'page_text', 'event');

-- 3. Quota (decision D5): annotated items per day, its own metric so a large import cannot use up
--    the distill or assist budgets.
alter table usage_daily add column annotations integer not null default 0;
