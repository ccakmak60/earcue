alter table users add column auth_user_id text unique references "user"(id) on delete cascade;
alter table users alter column device_key_hash drop not null;
