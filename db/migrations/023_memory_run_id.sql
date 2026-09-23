-- The run that wrote a memory. Ask earcue (POST /api/assist/chat) remembers and corrects memories
-- from inside a model run, and a correction from the Memory view is a run of its own (task
-- `correct`), so each such memory points at the agent_runs row that produced it: "why does earcue
-- think this" answers from the run's tool calls and refs. Distilled and derived memories keep
-- memory_sources as their provenance and leave this null. Pruning a run after 30 days keeps the
-- memory and clears the pointer.
alter table memories add column run_id uuid references agent_runs(id) on delete set null;
create index memories_run on memories (run_id) where run_id is not null;
