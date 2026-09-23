-- Forgetting that sticks. Until now "forget" hard-deleted the memory, and the next distill pass could
-- learn the same fact again from a new email. A memory the person forgets is now kept as a tombstone:
-- `forgotten_reason = 'user'`, text, subject and evidence blanked, sources and edges deleted, but
-- kind, subject_key and embedding kept. upsertMemories() checks new distilled and derived memories
-- against those tombstones and drops a match; a memory the person states themselves (manual, and
-- later chat) lifts the tombstone instead. The embedding still encodes the forgotten fact roughly,
-- which /privacy says. Account deletion removes tombstones with the rest (memories cascade).
--
-- `decay` marks what forgetStaleMemories() sets: expired and faded episodes. It is the only writer
-- of forgotten_at before this migration, so every row it already set is backfilled as `decay`.
alter table memories add column forgotten_reason text
  check (forgotten_reason in ('decay', 'user'));

update memories set forgotten_reason = 'decay' where forgotten_at is not null;

alter table memories add constraint memories_forgotten_pair
  check ((forgotten_at is null) = (forgotten_reason is null));

-- The tombstone lookup in upsertMemories(): one user's tombstones for one subject.
create index memories_tombstones on memories (user_id, subject_key) where forgotten_reason = 'user';
