-- Device-key auth is gone: nothing writes device_key_hash and no client sends x-earcue-key.
-- Rows keep every other column and their traces; only the unreachable lookup key is removed.
--
-- Before applying against a real database, verify no rows exist that were only ever reachable
-- through a device key (select count(*) from users where auth_user_id is null). A nonzero count
-- means those rows hold captured traces reachable only by a device key; do not drop the column
-- until they are migrated or explicitly written off.
alter table users drop column device_key_hash;
