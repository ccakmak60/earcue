-- Attributes Azure OpenAI spend to the account that caused it.
--
-- Until now llm_usage_daily was per-day, per-model only, so a runaway account was invisible: the
-- bill moved but nothing said whose traffic moved it. Sign-up is public, which makes that the
-- difference between noticing an abusive account in a day and noticing it on an invoice.
--
-- user_id is nullable on purpose: the nightly sweep, the re-embed backfill and any other system
-- work has no user to bill. `nulls not distinct` keeps one row per (day, model) for that work
-- instead of inserting a new unattributed row per call.
alter table llm_usage_daily add column user_id uuid references users(id) on delete set null;

-- `alter table ... rename to` leaves constraint names alone, so 015 left the primary key created by
-- 013 still called nim_usage_daily_pkey. Drop it under the name Postgres actually holds.
alter table llm_usage_daily drop constraint nim_usage_daily_pkey;
alter table llm_usage_daily add constraint llm_usage_daily_pkey
  unique nulls not distinct (day, model, user_id);

-- The spend ceiling sums a whole day across models and users on every cold isolate.
create index llm_usage_daily_day on llm_usage_daily (day);
