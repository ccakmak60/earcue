-- One row per model run (briefing, distill, consolidate, profile): which prompt version, which
-- model, which inputs, what came out, how long it took, what it cost and how it ended. Written by
-- src/lib/server/harness/runs.ts. llm_usage_daily stays the spend meter; this answers "why did it
-- say that" for a single run.
--
-- Ids only, never text: input_refs is {items: [...], memories: [...], traces: [...]} of the rows the
-- model was shown, tool_calls holds tool names, arguments and returned ids, and output holds the ids
-- and counts a run produced. The content stays in the tables that already handle provenance,
-- removal and export. Rows older than 30 days are deleted by the distill pass.
--
-- A row is inserted as `error`/`unfinished` just before the model call and updated when the run
-- ends, so a Worker killed mid-run still leaves a row.
create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  task text not null,
  prompt_version text not null,
  model text not null,
  started_at timestamptz not null default now(),
  ms integer,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  steps integer not null default 0,
  tool_calls jsonb not null default '[]'::jsonb,
  input_refs jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  outcome text not null check (outcome in ('ok', 'empty', 'invalid', 'error', 'ceiling')),
  error text
);
create index agent_runs_user_started on agent_runs (user_id, started_at desc);
-- The 30-day prune and the authorized /api/health `runs` count both read across users by time.
create index agent_runs_started on agent_runs (started_at);

-- The run that produced a suggestion. Pruning a run keeps the suggestion.
alter table suggestions add column run_id uuid references agent_runs(id) on delete set null;
create index suggestions_run on suggestions (run_id) where run_id is not null;
