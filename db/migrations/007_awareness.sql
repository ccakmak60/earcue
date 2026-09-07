create table connections (
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  account_label text,
  access_token_enc text not null,
  refresh_token_enc text,
  expires_at timestamptz,
  scope text,
  cursor text,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  primary key (user_id, provider)
);

create table context_items (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  external_id text not null,
  ts timestamptz not null,
  kind text not null,
  title text not null default '',
  body text not null default '',
  url text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  body_tsv tsvector generated always as (to_tsvector('english', title || ' ' || body)) stored,
  unique (user_id, provider, external_id)
);
create index context_items_user_ts on context_items (user_id, ts desc);
create index context_items_tsv on context_items using gin (body_tsv);

create table meetings (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  client_id text not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  local_day date not null,
  source text not null,
  title text,
  notes jsonb,
  notes_status text not null default 'none',
  notes_interaction_id text,
  error text,
  updated_at timestamptz not null default now(),
  unique (user_id, client_id)
);
create index meetings_user_started on meetings (user_id, started_at desc);

create table suggestions (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  client_id text not null,
  ts timestamptz not null default now(),
  local_day date not null,
  kind text not null,
  title text not null,
  detail text not null default '',
  draft_text text,
  evidence jsonb not null default '[]'::jsonb,
  urgency text not null,
  confidence real,
  status text not null default 'new',
  dedup_key text not null,
  unique (user_id, client_id)
);
create index suggestions_user_ts on suggestions (user_id, ts desc);
create unique index suggestions_dedup on suggestions (user_id, dedup_key, local_day);

alter table usage_daily add column assist_calls integer not null default 0;
alter table usage_daily add column connector_syncs integer not null default 0;
