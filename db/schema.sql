create extension if not exists pgcrypto;

create table users (
  id uuid primary key default gen_random_uuid(),
  device_key_hash text not null unique,
  tz text not null default 'UTC',
  created_at timestamptz not null default now()
);

create table traces (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  ts timestamptz not null,
  local_day date not null,
  kind text not null,            -- 'speech' | 'screen' | 'flag' | 'marker'
  source text,                   -- speech: 'mic' | 'system'; screen: 'display'
  speaker text,                  -- diarization label, chunk-local (e.g. 'spk_1')
  text text not null,
  meta jsonb not null default '{}'::jsonb,
  client_id text not null,       -- idempotency key minted by the browser
  created_at timestamptz not null default now(),
  unique (user_id, client_id)
);
create index traces_user_day_ts on traces (user_id, local_day, ts);

create table day_reviews (
  user_id uuid not null references users(id) on delete cascade,
  day date not null,
  status text not null,          -- 'in_progress' | 'completed' | 'failed'
  interaction_id text,
  payload jsonb,
  error text,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);
