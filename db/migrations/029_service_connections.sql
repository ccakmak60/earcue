-- Connected services: hosted MCP servers (Streamable HTTP) the person connects from the Sources
-- view, picked from the integrations.sh directory (public/mcp-catalog.json) or by URL. Ask earcue
-- calls their tools live, during a chat turn (the `use_service` tool, src/lib/server/services.ts);
-- nothing they return is stored. One row per server per account.
--   auth        none     the server answered without credentials
--               api_key  a key the person pasted, sent in `header_name` (null: Authorization: Bearer)
--               oauth    MCP authorization: the server's protected-resource metadata, then its
--                        authorization server, a registered or metadata-document client, PKCE
--   status      pending    an OAuth round trip that has not come back yet; never shown, and
--                          deleted after a day by the next connect
--               connected  usable
--               needs_auth the token was refused and could not be refreshed: reconnect
--   oauth       {client_id, client_secret_enc?, auth_method, token_endpoint, resource, scope?} of
--               the client the tokens belong to
--   pending     {state_hash, verifier_enc, oauth} while a (re)connect is at the service's consent
--               page, so a connected row keeps working until the new tokens arrive
--   tools       the server's tools as last listed: [{name, description, schema, read}], `read`
--               from the tool's annotations (or its name when it has none)
--   allow_actions  false: only read tools are offered to the chat; true: action tools too, each
--                  run only when the person's own message asks for it
-- Secrets are AES-256-GCM (secretbox.ts, CONNECTOR_ENC_KEY), as in `connections`.
create table service_connections (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  url text not null,
  name text not null,
  slug text not null,
  catalog_slug text,
  auth text not null check (auth in ('none', 'api_key', 'oauth')),
  status text not null default 'pending' check (status in ('pending', 'connected', 'needs_auth')),
  header_name text,
  access_token_enc text,
  refresh_token_enc text,
  expires_at timestamptz,
  oauth jsonb,
  pending jsonb,
  tools jsonb not null default '[]',
  tools_at timestamptz,
  allow_actions boolean not null default false,
  last_error text,
  created_at timestamptz not null default now(),
  connected_at timestamptz,
  unique (user_id, url),
  unique (user_id, slug)
);
