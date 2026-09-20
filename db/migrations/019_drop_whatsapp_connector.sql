-- The WAHA WhatsApp connector is gone: no Cloudflare product can host a stateful WhatsApp Web
-- session, and Meta's Cloud API cannot read a personal account's chats, so the connector was
-- removed rather than rehosted. Every row here was written by a link attempt against a base URL
-- that was never a real host, so none of them carry a working session.
--
-- `context_items` is deliberately left alone. Rows with provider = 'whatsapp' also come from the
-- chat-export (.txt) importer, which stays, and even the ones the deleted backfill wrote are the
-- user's own data.
delete from connections where provider = 'whatsapp';

-- Added by 012_unlimited.sql purely so api/connect/whatsapp-webhook could resolve the owning user
-- from the WAHA session name. That route no longer exists.
drop index if exists connections_whatsapp_session;
