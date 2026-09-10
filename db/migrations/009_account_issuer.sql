-- better-auth 1.7.2 requires account.issuer (@better-auth/core get-tables.mjs: account
-- field `issuer` is required, plus a unique index on (issuer, accountId)). Migration 002
-- was generated before that field existed, so every account insert -- the Google OAuth
-- callback and any credential account -- failed on the missing column, which is why
-- production has OAuth state rows in "verification" but no users.
alter table "account" add column if not exists "issuer" text;

update "account"
set "issuer" = case
  when "providerId" = 'credential' then 'local:credential'
  else 'local:oauth:' || "providerId"
end
where "issuer" is null;

alter table "account" alter column "issuer" set not null;

create unique index if not exists "account_issuer_accountId_key" on "account" ("issuer", "accountId");
