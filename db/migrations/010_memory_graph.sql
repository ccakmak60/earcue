alter table memories add column container text not null default 'self';
alter table memories add column forgotten_at timestamptz;
alter table memories add column text_tsv tsvector generated always as (to_tsvector('english', subject || ' ' || text)) stored;

create index memories_text_tsv on memories using gin (text_tsv);
create index memories_user_container on memories (user_id, container)
  where superseded_by is null and forgotten_at is null;

create table memory_edges (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  src_id bigint not null references memories(id) on delete cascade,
  dst_id bigint not null references memories(id) on delete cascade,
  relation text not null,
  created_at timestamptz not null default now(),
  unique (src_id, dst_id, relation)
);
create index memory_edges_user_src on memory_edges (user_id, src_id);
create index memory_edges_user_dst on memory_edges (user_id, dst_id);

alter table user_profile rename column sections to buckets;
alter table user_profile add column static_facts jsonb not null default '[]'::jsonb;
alter table user_profile add column dynamic_facts jsonb not null default '[]'::jsonb;
alter table user_profile add column trace_cursor bigint not null default 0;

alter table usage_daily add column recalls integer not null default 0;

create or replace function memory_strength(importance real, kind text, last_seen timestamptz)
returns real language sql stable as $$
  select greatest(0.0, least(1.0, importance * exp(
    -ln(2.0) * (extract(epoch from (now() - last_seen)) / 86400.0)
    / case kind
        when 'episode' then 14.0
        when 'project' then 90.0
        when 'goal' then 120.0
        when 'fact' then 180.0
        when 'routine' then 180.0
        else 365.0
      end
  )))::real
$$;
