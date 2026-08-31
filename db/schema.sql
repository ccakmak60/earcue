create extension if not exists pgcrypto;

create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create index "session_userId_idx" on "session" ("userId");

create index "account_userId_idx" on "account" ("userId");

create index "verification_identifier_idx" on "verification" ("identifier");

create table users (
  id uuid primary key default gen_random_uuid(),
  device_key_hash text unique,
  tz text not null default 'UTC',
  created_at timestamptz not null default now(),
  auth_user_id text unique references "user"(id) on delete cascade,
  plan text not null default 'none',
  plan_status text,
  current_period_end timestamptz
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

create table usage_daily (
  user_id uuid not null references users(id) on delete cascade,
  day date not null,
  audio_seconds integer not null default 0,
  frames integer not null default 0,
  watch_calls integer not null default 0,
  reviews integer not null default 0,
  live_seconds integer not null default 0,
  primary key (user_id, day)
);
