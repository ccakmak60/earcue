-- Gate and group (memory architecture plan, Phase 2). Distill stops walking context_items in id
-- order behind user_profile.distill_cursor: it reads annotated items by triage and salience,
-- grouped by conversation, and that order breaks id order. So each item records when it was
-- distilled, and "not yet distilled" is `distilled_at is null`.

alter table context_items add column distilled_at timestamptz;

-- Everything the old cursor had passed was distilled (or skipped as part of a distilled batch). The
-- time it happened is not recorded anywhere, so the backfill uses the migration's.
update context_items ci set distilled_at = now()
from user_profile p
where p.user_id = ci.user_id and ci.id <= p.distill_cursor;

-- The distill work queue, as context_items_unannotated is the annotate one.
create index context_items_undistilled on context_items (user_id, id) where distilled_at is null;

-- user_profile.distill_cursor is no longer read or written. It stays for one release, so code
-- deployed before this migration keeps working until the new code is live; a later migration can
-- drop it.
