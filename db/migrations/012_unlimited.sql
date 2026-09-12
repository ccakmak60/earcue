alter table users add column unlimited boolean not null default false;

-- Webhook lookup path for the WAHA connector: api/connect/whatsapp-webhook resolves the
-- owning user from the WAHA session name carried in the event body. Partial so it does not
-- collide with the OAuth `scope` strings google/slack rows store in the same column.
create unique index connections_whatsapp_session on connections (scope) where provider = 'whatsapp';
