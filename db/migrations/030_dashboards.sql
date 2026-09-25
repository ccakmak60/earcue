-- The Dashboard view (docs/plans/2026-09-25-feat-generative-dashboard-plan.md): a page of panels
-- earcue chooses for each person from a fixed catalog (src/lib/shared/dashboard.ts). One row per
-- account, so the view reads it with one query.
--   spec         {panels: [key], by: decide | fallback | none, filled}: the chosen panels in order.
--                A key is a panel type (`replies_owed`) or a type with its entity (`entity:412`).
--                The model chose them (`decide`), or its call failed and the fixed order stood
--                (`fallback`), or there was nothing to ask about (`none`); `filled` counts panels
--                added from that order when too few passed.
--   fingerprint  a hash of the candidate panels and their banded counts when the spec was built:
--                the same fingerprint within a day means no rebuild and no model call
--   pinned       keys the person pinned: always shown, first, in pin order
--   hidden       keys the person hid: never offered again until they reset them
--   run_id       the `dashboard` run that built the spec
create table dashboards (
  user_id uuid primary key references users(id) on delete cascade,
  spec jsonb not null default '{"panels": []}'::jsonb,
  fingerprint text,
  pinned text[] not null default '{}',
  hidden text[] not null default '{}',
  run_id uuid references agent_runs(id) on delete set null,
  built_at timestamptz,
  updated_at timestamptz not null default now()
);
