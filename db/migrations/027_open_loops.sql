-- Open loops (memory architecture plan, Phase 4). Something still open for the person: a reply they
-- owe, a promise they made, an answer they are waiting on, someone they have gone quiet on, a
-- project or idea with no activity for weeks. Detected and resolved in SQL from the item signals
-- (024) and entities (026), by refresh_open_loops() below, which the catch-up runs; the briefing
-- reads the open ones as its candidates. Stored rather than computed per briefing, so a dismissal
-- sticks and a loop is not detected again every three hours.

-- 1. The loops. `context_item_id` is the item the loop rests on: the email or chat that asked, the
--    one that promised, the last contact before a silence, the latest item about a stale project.
--    A new item is a new loop, so a dismissed one never comes back, and a new silence after a
--    reply is a new reconnect loop. A loop with no item (a project nothing was ever linked to) is
--    unique by its entity instead. `memory_id` is a memory drawn from the item (for a note, the one
--    the chat remembered). `follow_up` is reserved: nothing detects it yet.
--      status  open       waiting for the person
--              done       resolved: a reply landed, a contact happened, the project moved, or the
--                         person accepted a recommendation made from it
--              dismissed  the person dismissed a recommendation made from it; never reopened
--              expired    too old, superseded by a newer loop on the same thread, or its project
--                         is no longer active
create table open_loops (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('reply_owed', 'commitment', 'waiting_on', 'follow_up', 'reconnect', 'stale_project', 'parked_idea')),
  entity_id bigint references entities(id) on delete cascade,
  context_item_id bigint references context_items(id) on delete cascade,
  memory_id bigint references memories(id) on delete set null,
  due_at timestamptz,
  score real not null default 0,
  status text not null default 'open' check (status in ('open', 'done', 'dismissed', 'expired')),
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  check ((status = 'open') = (resolved_at is null)),
  check (context_item_id is not null or entity_id is not null)
);
create unique index open_loops_item on open_loops (user_id, kind, context_item_id) where context_item_id is not null;
create unique index open_loops_entity on open_loops (user_id, kind, entity_id) where context_item_id is null;
create index open_loops_open on open_loops (user_id, score desc) where status = 'open';

-- 2. The loop a recommendation was made from, so feedback reaches it: accepted marks it done,
--    dismissed marks it dismissed (and the title joins the month of `not_useful` titles as before).
alter table suggestions add column loop_id bigint references open_loops(id) on delete set null;
create index suggestions_loop on suggestions (loop_id) where loop_id is not null;

-- ---------- detection and resolution ----------
-- One call per catch-up (GET /api/assist/catchup), so one subrequest. The thresholds come from
-- src/lib/server/open-loops.ts:
--   p_reply        needs_reply at or above it, on an item the person did not write: reply_owed
--   p_commitment   commitment at or above it, on a chat, message, note or an email the person sent
--   p_min_contacts the contact floor: days in contact with a person before a silence counts
--   p_quiet_days   the shortest silence that counts, however often they usually talk
--   p_stale_days   days without an item before an active project or idea is stale
--   p_max_age_days an item older than this opens no loop, and its open loop expires
--   p_open_days    an open loop nobody acted on expires after this
-- An item the person wrote: an email with meta.sent, or a chat block they spoke in (their own
-- entity is on it as `from`). Returns {opened, done, expired}.
create function refresh_open_loops(
  p_user uuid, p_reply real, p_commitment real, p_min_contacts integer, p_quiet_days integer,
  p_stale_days integer, p_max_age_days integer, p_open_days integer
) returns jsonb language plpgsql as $$
declare
  v_self bigint;
  v_n integer;
  v_opened integer := 0;
  v_done integer := 0;
  v_expired integer := 0;
begin
  select id into v_self from entities where user_id = p_user and is_self;

  -- Resolution first, so a loop answered since the last catch-up is not offered again.
  -- reply_owed: a later item by the person on the same thread.
  update open_loops l set status = 'done', resolved_at = now()
  from context_items ci
  where l.user_id = p_user and l.status = 'open' and l.kind = 'reply_owed' and ci.id = l.context_item_id
    and ci.thread_key is not null
    and exists (
      select 1 from context_items r
      where r.user_id = p_user and r.thread_key = ci.thread_key and r.ts > ci.ts and r.id <> ci.id
        and (r.meta->>'sent' = 'true'
             or (r.kind = 'chat' and exists (select 1 from item_entities ie where ie.context_item_id = r.id and ie.entity_id = v_self)))
    );
  get diagnostics v_n = row_count;
  v_done := v_done + v_n;

  -- waiting_on: a later item on the thread that the person did not write.
  update open_loops l set status = 'done', resolved_at = now()
  from context_items ci
  where l.user_id = p_user and l.status = 'open' and l.kind = 'waiting_on' and ci.id = l.context_item_id
    and exists (
      select 1 from context_items r
      where r.user_id = p_user and r.thread_key = ci.thread_key and r.ts > ci.ts and r.id <> ci.id
        and r.meta->>'sent' is distinct from 'true'
    );
  get diagnostics v_n = row_count;
  v_done := v_done + v_n;

  -- reconnect: any contact with them after the one the silence started from.
  update open_loops l set status = 'done', resolved_at = now()
  from context_items ci
  where l.user_id = p_user and l.status = 'open' and l.kind = 'reconnect' and ci.id = l.context_item_id
    and exists (
      select 1 from item_entities ie join context_items c on c.id = ie.context_item_id
      where ie.entity_id = l.entity_id and ie.role in ('from', 'to') and c.kind <> 'event' and c.ts > ci.ts and c.ts <= now()
    );
  get diagnostics v_n = row_count;
  v_done := v_done + v_n;

  -- stale_project, parked_idea: a newer item about it is activity; a status other than active
  -- (the person parked or finished it) ends the loop without it.
  update open_loops l set status = case when e.status = 'active' then 'done' else 'expired' end, resolved_at = now()
  from entities e
  where l.user_id = p_user and l.status = 'open' and l.kind in ('stale_project', 'parked_idea') and e.id = l.entity_id
    and (e.status is distinct from 'active'
         or exists (
           select 1 from item_entities ie join context_items c on c.id = ie.context_item_id
           where ie.entity_id = e.id and c.ts > coalesce((select ts from context_items where id = l.context_item_id), l.detected_at)
         ));
  get diagnostics v_n = row_count;
  v_done := v_done + v_n;

  -- Expiry: an item past the age limit, or a loop open for too long.
  update open_loops l set status = 'expired', resolved_at = now()
  where l.user_id = p_user and l.status = 'open'
    and (l.detected_at < now() - make_interval(days => p_open_days)
         or (l.kind in ('reply_owed', 'commitment', 'waiting_on')
             and exists (select 1 from context_items ci where ci.id = l.context_item_id and ci.ts < now() - make_interval(days => p_max_age_days))));
  get diagnostics v_n = row_count;
  v_expired := v_expired + v_n;

  -- reply_owed: the latest item per thread that asks the person something, that they did not write,
  -- that is not automated (triage drop), and that nothing of theirs answers later on the thread.
  insert into open_loops (user_id, kind, context_item_id, entity_id, memory_id, score)
  select distinct on (coalesce(ci.thread_key, ci.id::text))
         p_user, 'reply_owed', ci.id,
         (select ie.entity_id from item_entities ie join entities e on e.id = ie.entity_id
          where ie.context_item_id = ci.id and ie.role = 'from' and e.kind = 'person' and not e.is_self order by ie.entity_id limit 1),
         null,
         ci.needs_reply * (0.5 + 0.5 * coalesce(ci.salience, 0.5))
  from context_items ci
  where ci.user_id = p_user and ci.kind in ('email', 'message', 'chat') and ci.needs_reply >= p_reply
    and ci.triage is distinct from 'drop' and ci.meta->>'sent' is distinct from 'true'
    and ci.ts > now() - make_interval(days => p_max_age_days)
    and not exists (
      select 1 from context_items r
      where r.user_id = p_user and ci.thread_key is not null and r.thread_key = ci.thread_key and r.ts > ci.ts and r.id <> ci.id
        and (r.meta->>'sent' = 'true'
             or (r.kind = 'chat' and exists (select 1 from item_entities ie where ie.context_item_id = r.id and ie.entity_id = v_self)))
    )
  order by coalesce(ci.thread_key, ci.id::text), ci.ts desc
  on conflict (user_id, kind, context_item_id) where context_item_id is not null do nothing;
  get diagnostics v_n = row_count;
  v_opened := v_opened + v_n;

  -- A newer reply_owed on the same thread replaces an older open one.
  update open_loops l set status = 'expired', resolved_at = now()
  from context_items ci
  where l.user_id = p_user and l.status = 'open' and l.kind = 'reply_owed' and ci.id = l.context_item_id and ci.thread_key is not null
    and exists (
      select 1 from open_loops l2 join context_items c2 on c2.id = l2.context_item_id
      where l2.user_id = p_user and l2.kind = 'reply_owed' and l2.status = 'open' and c2.thread_key = ci.thread_key and c2.ts > ci.ts
    );
  get diagnostics v_n = row_count;
  v_expired := v_expired + v_n;

  -- commitment: a promise by the person, in a chat, a message, a note they wrote (a task they told
  -- earcue about) or an email they sent. The person's promise is theirs whoever reads it, so a
  -- received email does not count.
  insert into open_loops (user_id, kind, context_item_id, entity_id, memory_id, score)
  select p_user, 'commitment', ci.id,
         coalesce(
           (select m.entity_id from memory_sources s join memories m on m.id = s.memory_id
            where s.context_item_id = ci.id and m.entity_id is not null and m.forgotten_at is null order by m.importance desc, m.id limit 1),
           (select ie.entity_id from item_entities ie join entities e on e.id = ie.entity_id
            where ie.context_item_id = ci.id and e.kind = 'person' and not e.is_self order by ie.role = 'to' desc, ie.entity_id limit 1)),
         (select m.id from memory_sources s join memories m on m.id = s.memory_id
          where s.context_item_id = ci.id and m.forgotten_at is null and m.superseded_by is null order by m.importance desc, m.id limit 1),
         ci.commitment * (0.5 + 0.5 * coalesce(ci.salience, 0.5))
  from context_items ci
  where ci.user_id = p_user and ci.commitment >= p_commitment and ci.triage is distinct from 'drop'
    and (ci.kind in ('chat', 'message', 'note') or (ci.kind = 'email' and ci.meta->>'sent' = 'true'))
    and ci.ts > now() - make_interval(days => p_max_age_days)
  on conflict (user_id, kind, context_item_id) where context_item_id is not null do nothing;
  get diagnostics v_n = row_count;
  v_opened := v_opened + v_n;

  -- waiting_on: an email the person sent, still the last on its thread after three days, that asks
  -- something (a question mark ending a sentence; gmailItem() has stripped the quoted reply).
  insert into open_loops (user_id, kind, context_item_id, entity_id, score)
  select p_user, 'waiting_on', ci.id,
         (select ie.entity_id from item_entities ie join entities e on e.id = ie.entity_id
          where ie.context_item_id = ci.id and ie.role = 'to' and e.kind = 'person' and not e.is_self order by ie.entity_id limit 1),
         0.4 * (0.5 + 0.5 * coalesce(ci.salience, 0.5))
  from context_items ci
  where ci.user_id = p_user and ci.kind = 'email' and ci.meta->>'sent' = 'true' and ci.thread_key is not null
    and ci.body ~ '\?(\s|$)'
    and ci.ts < now() - interval '3 days' and ci.ts > now() - make_interval(days => p_max_age_days)
    and not exists (select 1 from context_items r where r.user_id = p_user and r.thread_key = ci.thread_key and r.ts > ci.ts and r.id <> ci.id)
  on conflict (user_id, kind, context_item_id) where context_item_id is not null do nothing;
  get diagnostics v_n = row_count;
  v_opened := v_opened + v_n;

  -- reconnect: someone the person is in touch with both ways (they wrote to them, or a chat or Slack
  -- contact), in contact on at least p_min_contacts days, now silent for more than twice their
  -- usual gap and at least p_quiet_days, but within the last year. The loop rests on the last
  -- contact, so a new contact ends it and a later silence is a new loop.
  insert into open_loops (user_id, kind, context_item_id, entity_id, score)
  select p_user, 'reconnect', g.last_item, g.entity_id, 0.3
  from (
    select d.entity_id, count(*) as days, max(d.day) as last_day,
           percentile_cont(0.5) within group (order by d.gap) as median_gap,
           (select c.id from item_entities ie join context_items c on c.id = ie.context_item_id
            where ie.entity_id = d.entity_id and ie.role in ('from', 'to') and c.kind <> 'event' and c.ts <= now()
            order by c.ts desc, c.id desc limit 1) as last_item
    from (
      select x.entity_id, x.day, extract(epoch from x.day - lag(x.day) over (partition by x.entity_id order by x.day)) / 86400 as gap
      from (
        select ie.entity_id, date_trunc('day', c.ts) as day
        from item_entities ie
        join context_items c on c.id = ie.context_item_id
        join entities e on e.id = ie.entity_id
        where ie.user_id = p_user and ie.role in ('from', 'to') and c.kind <> 'event' and c.ts <= now()
          and e.kind = 'person' and not e.is_self
          and (exists (select 1 from entity_aliases a where a.entity_id = e.id and (a.alias like 'whatsapp:%' or a.alias like 'slack:%'))
               or exists (select 1 from item_entities o join context_items oc on oc.id = o.context_item_id
                          where o.entity_id = e.id and o.role = 'to' and oc.meta->>'sent' = 'true'))
        group by 1, 2
      ) x
    ) d
    group by d.entity_id
  ) g
  where g.days >= p_min_contacts and g.last_item is not null
    and g.last_day > now() - interval '365 days'
    and now() - g.last_day > make_interval(days => p_quiet_days)
    and extract(epoch from now() - g.last_day) / 86400 > 2 * g.median_gap
  on conflict (user_id, kind, context_item_id) where context_item_id is not null do nothing;
  get diagnostics v_n = row_count;
  v_opened := v_opened + v_n;

  -- stale_project, parked_idea: an active project or idea with a live memory about it whose latest
  -- item is older than p_stale_days. Item times, not entity times: an import made today of a
  -- project last discussed in June is stale today.
  insert into open_loops (user_id, kind, context_item_id, entity_id, memory_id, score)
  select p_user, case when e.kind = 'project' then 'stale_project' else 'parked_idea' end, t.last_item, e.id,
         (select m.id from memories m where m.entity_id = e.id and m.forgotten_at is null and m.superseded_by is null and not m.sensitive
          order by m.importance desc, m.id limit 1),
         0.25
  from entities e
  cross join lateral (
    select c.id as last_item, c.ts from item_entities ie join context_items c on c.id = ie.context_item_id
    where ie.entity_id = e.id and c.ts <= now() order by c.ts desc, c.id desc limit 1
  ) t
  where e.user_id = p_user and e.kind in ('project', 'idea') and e.status = 'active'
    and t.ts < now() - make_interval(days => p_stale_days)
    and exists (select 1 from memories m where m.entity_id = e.id and m.forgotten_at is null and m.superseded_by is null)
  on conflict (user_id, kind, context_item_id) where context_item_id is not null do nothing;
  get diagnostics v_n = row_count;
  v_opened := v_opened + v_n;

  return jsonb_build_object('opened', v_opened, 'done', v_done, 'expired', v_expired);
end $$;
