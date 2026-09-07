create extension if not exists pgcrypto;

create table users (
  id uuid primary key default gen_random_uuid(),
  device_key_hash text unique not null,
  tz text not null default 'UTC',
  created_at timestamptz not null default now()
);

create table traces (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  ts timestamptz not null,
  local_day date not null,
  kind text not null,
  source text,
  speaker text,
  text text not null,
  meta jsonb not null default '{}'::jsonb,
  client_id text not null,
  created_at timestamptz not null default now(),
  unique (user_id, client_id)
);
create index traces_user_day_ts on traces (user_id, local_day, ts);

create table day_reviews (
  user_id uuid not null references users(id) on delete cascade,
  day date not null,
  status text not null,
  interaction_id text,
  payload jsonb,
  error text,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);
