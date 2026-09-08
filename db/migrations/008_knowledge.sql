create extension if not exists vector;

create table imports (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  source text not null,
  label text not null default '',
  status text not null default 'running',
  items_ingested integer not null default 0,
  items_skipped integer not null default 0,
  cursor text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index imports_user_created on imports (user_id, created_at desc);

alter table context_items add column import_id bigint references imports(id) on delete cascade;
create index context_items_import on context_items (import_id);

create table memories (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,
  subject text not null default '',
  subject_key text not null default '',
  text text not null,
  importance real not null default 0.5,
  confidence real not null default 0.5,
  evidence jsonb not null default '[]'::jsonb,
  origin text not null,
  embedding vector(768),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  hit_count integer not null default 0,
  expires_at timestamptz,
  superseded_by bigint references memories(id) on delete set null,
  created_at timestamptz not null default now()
);
create index memories_user_live on memories (user_id) where superseded_by is null;
create index memories_user_subject on memories (user_id, kind, subject_key);
create index memories_embedding on memories using hnsw (embedding vector_cosine_ops);

create table user_profile (
  user_id uuid primary key references users(id) on delete cascade,
  summary text not null default '',
  sections jsonb not null default '{}'::jsonb,
  distill_cursor bigint not null default 0,
  built_at timestamptz,
  updated_at timestamptz not null default now()
);

create table ingest_tokens (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  label text not null default '',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index ingest_tokens_user on ingest_tokens (user_id);

alter table users add column excluded_domains text[] not null default '{}';

alter table usage_daily add column import_items integer not null default 0;
alter table usage_daily add column distills integer not null default 0;
