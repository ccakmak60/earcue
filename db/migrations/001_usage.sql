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
