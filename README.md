# earcue

Ambient teleprompter and personal knowledge base — listens to your day, drafts what to say next, and builds a
searchable memory of what you've heard, read, and imported.

## What it is

A Next.js (App Router) app in strict TypeScript with shadcn/ui on Tailwind CSS v4, deployed on Cloudflare
Workers (via `@opennextjs/cloudflare`). Audio and screen frames are captured in the browser but transcribed
and analyzed server-side (`/api/ingest/audio`, `/api/ingest/frames`) — API keys live only in the server
environment and never reach the browser. Transcription, vision, reasoning, and memory
embeddings all run on Azure OpenAI (OpenAI-compatible `v1` API). WAHA
(WhatsApp) runs always-on as a container on Azure App Service.

Auth is Google OAuth and email/password (better-auth; anyone can create an account), billing is Polar
(subscriptions gate analysis features), and all state lives in Postgres (Neon) with `pgvector` for memory
search. Optional Google and Slack connectors (`src/lib/server/connectors.ts`) backfill Gmail/Calendar/Slack
history into the knowledge base, and a companion browser extension (`extension/`) feeds browsing history,
bookmarks, and the text of pages you read (after an 8-second visible-and-focused dwell, with
nav/script/sensitive-field content stripped and tracking params removed) into the same pipeline. Page
capture is on by default and switched off per account (`users.capture_pages`) from the knowledge settings,
with a per-domain skip list the extension enforces before anything leaves the browser.

## Project layout

```text
src/
  app/                     pages (/, /signin, /app, /account, /privacy, /terms) and api/**/route.ts handlers
  components/ui/           shadcn/ui components
  components/{app,auth,account,marketing}/
  hooks/                   React hooks (earcue:* event subscription, capture UI state)
  lib/shared/              pure, isomorphic logic and payload types (no server, client, React or browser imports)
  lib/server/              server-only modules: env, db, auth, quota, LLM (Azure OpenAI), knowledge base, connectors
  lib/client/              client-only modules: capture, frame worker, IndexedDB, pipeline, transport
tests/unit/                Vitest, mirroring src/lib (tests/e2e is reserved for Playwright)
extension/                 Manifest V3 browser extension (independent of src/)
db/migrations/             the schema, source of truth
scripts/                   migrate.mjs, seed-admin.ts, load-env.mjs, dev-doctor.mjs, dev-seed.mjs, dev-token.mjs
```

The API keeps its URLs: single routes (`watch`, `factcheck`, `traces`, `review`, `health`, `ingest/*`,
`cron/review-sweep`), better-auth at `auth/[...all]`, and three `[action]` dispatchers (`account`, `connect`,
`assist`) — kept as a convention from the app's earlier Vercel Hobby-plan function cap; a related endpoint
is still a new action on an existing dispatcher, not a new route.

## Config

Every required and optional environment variable is listed in `.env.example`. `src/lib/server/env.ts` validates
required vars on first access and fails fast with a clear error; `missingEnv()` reports what's absent without
throwing, which is what powers `/api/health`.

`.env.local` is hand-authored from `.env.example` — there is no Vercel project to pull from anymore.

## Local dev

```
npm install
npm run dev:doctor      # names-only env + migration check; explains what's safe to skip (never prints values)
npm run dev:seed you@example.com [password]
                        # creates/resets the login, comped to plan=pro/unlimited; prints the password once
npm run dev:up          # doctor, then `next dev` on http://localhost:3000
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run build        # next build
```

Then open `http://localhost:3000/signin?email=you@example.com` — the email is prefilled, the
session is long-lived (`rememberMe`), and an already-signed-in browser skips `/signin` straight to
`/app`. Use the seeded account: entitlement never depends on `BILLING_ENABLED`. An account is
entitled when Polar says so (`plan = pro`) or when it is comped (`users.unlimited`, which
`npm run dev:seed` and `npm run seed:admin` both set) — anyone else, signed in or not, gets 402.
Sign-up is public and inference is billed to our Azure account, so billing being off cannot mean
entitlement is on.

Extension on localhost: `npm run dev:token [email] [label]` prints a one-time ingest token plus the
base URL to paste into the extension's Options page, so history/bookmarks sync without the cookie
session. (The extension's `optional_host_permissions` already allow `http://localhost/*`.)

What stays production-only by design (not broken local setup): Google/Slack OAuth need prod redirect
URIs registered in their consoles, so their buttons stay hidden on localhost — use email/password.
WhatsApp/WAHA can't reach `localhost` from a remote container unless `WAHA_WEBHOOK_BASE_URL` is set to
something it can reach. Still missing `AZURE_OPENAI_API_KEY`/`AZURE_OPENAI_BASE_URL` in Development:
transcription/vision/reasoning calls fail until those are added to `.env.local` by hand, but sign-in,
ingest, traces, reviews-of-stored-data, imports, and memory recall all work without them.

The nightly sweep runs from a Cloudflare Cron Trigger (`infra/sweep-cron`) in production; locally, call it directly:

```
curl -s localhost:3000/api/cron/review-sweep -H "Authorization: Bearer $CRON_SECRET"
```

## Deploy

```
npm run preview   # opennextjs-cloudflare build + local workerd preview on http://localhost:8787
npm run deploy    # opennextjs-cloudflare build + deploy, injecting COMMIT_SHA from `git rev-parse HEAD`
```

`wrangler.jsonc` is the app Worker `earcue` (custom-domain route, `nodejs_compat`, `cpu_ms: 300000`,
smart placement, an `earcue-media` R2 bucket and the `earcue-ingest` queue producer);
`infra/sweep-cron/wrangler.jsonc` is the `earcue-sweep-cron` Worker holding the hourly trigger; and
`infra/task-consumer/wrangler.jsonc` is `earcue-task-consumer`, which drains both work queues back
into the app over HTTP. `COMMIT_SHA` is what `/api/health` reports as `release`.

Production runs on `earcue.lol` (Cloudflare zone in the same account), which is what
`BETTER_AUTH_URL`, the cron Worker's `SWEEP_URL` and the consumer's `PROCESS_URL` /
`SWEEP_RUN_URL` all point at. **Workers Paid is a hard prerequisite** — the app Worker sets
`limits.cpu_ms`, and the Free plan rejects the deploy outright (`code: 100328`) on top of being
unservable at 10 ms CPU per request.

Provision once, before the first deploy (the app degrades to the old synchronous behaviour while
they are missing, so order does not matter):

```
wrangler r2 bucket create earcue-media
wrangler r2 bucket lifecycle add earcue-media expire-7d --expire-days 7 --abort-multipart-days 1
wrangler queues create earcue-ingest
wrangler queues create earcue-ingest-dlq
wrangler queues create earcue-sweep
wrangler queues create earcue-sweep-dlq
```

Secrets are uploaded separately from `vars`, from an untracked `.env.production` holding
`DATABASE_URL`, `BETTER_AUTH_SECRET`, `CRON_SECRET`, `AZURE_OPENAI_API_KEY`, `CONNECTOR_ENC_KEY`
and the two `TURNSTILE_*` keys:

```
wrangler secret bulk .env.production
wrangler secret put CRON_SECRET -c infra/sweep-cron/wrangler.jsonc
wrangler secret put CRON_SECRET -c infra/task-consumer/wrangler.jsonc
wrangler deploy -c infra/sweep-cron/wrangler.jsonc
wrangler deploy -c infra/task-consumer/wrangler.jsonc
```

Audio ingest is asynchronous when the bucket and queue exist: `/api/ingest/audio` stores the chunk,
enqueues a pointer and answers `202`, `earcue-task-consumer` calls `/api/ingest/audio/process`, and
the trace rows are written server-side under the client's own chunk id — so a queue redelivery
inserts nothing twice. The Day view refreshes for two minutes after a flush to pick them up.

Inference runs on the Azure OpenAI resource `earcue-aoai` (`eastus2`, resource group
`earcue-prod-rg`) with four deployments: `earcue-reason` and `earcue-vision` on `gpt-4.1-mini`,
`earcue-transcribe` on `gpt-4o-transcribe`, `earcue-embed` on `text-embedding-3-small`. The
subscription has no `gpt-4.1` GlobalStandard quota in that region, so `earcue-reason` runs the mini
model until a quota increase lands; only the deployment's model changes, never its name.

WhatsApp is not provisioned: no WAHA host exists, so `WAHA_BASE_URL` is deliberately absent from
`wrangler.jsonc` and `connectorsEnabled()` keeps the connector hidden.

## Spend and abuse controls

Sign-up is public and every signed-in session can spend Azure OpenAI tokens, so three things stand
between a stranger and the bill:

1. **Entitlement.** An account is entitled only when Polar says `plan = pro` or when it is comped
   (`users.unlimited`). This holds with `BILLING_ENABLED=0` too — billing off is not billing-free.
   Comp an account with `npm run seed:admin <email>`.
2. **Per-account quotas.** `PLANS` in `src/lib/server/plans.ts` caps each metric per day and
   `consume()` enforces it (429). These are per account, so they bound one user, not a crowd.
3. **Deployment-wide ceiling.** `DAILY_TOKEN_CEILING` (unset/0 = off) caps a day's total Azure
   OpenAI tokens across every user and model. Past it, inference answers `503 spend_ceiling` while
   sign-in and stored-data reads keep working. `/api/health` (authorized) reports today's spend per
   model and the five accounts that spent the most.

Two more live in the Cloudflare dashboard rather than in this repo:

- **Turnstile on sign-up.** Set `TURNSTILE_SECRET_KEY` and `TURNSTILE_SITE_KEY` (both, or neither)
  from a Turnstile widget for the production hostname. The widget then renders on the sign-up form
  only, and better-auth verifies it on `/sign-up/email`; sign-in is deliberately never gated, so a
  failed widget load cannot lock out an existing account.
- **WAF rate limiting.** Add rate-limiting rules for `/api/auth/sign-up/*` and `/api/ingest/*` per
  IP. Nothing in the app depends on them, so they are safe to tune from the dashboard.

## Database

Migrations live in `db/migrations/` and are the single source of schema truth, applied in filename order and
tracked in a `schema_migrations` table.

```
npm run migrate                        # apply any pending migrations
npm run migrate:baseline               # mark all current migrations as applied without running them,
                                       # for a database that already has the schema
npm run seed:admin <email> [password]  # create/reset the owner's admin login, comped to plan=pro
npm run reembed                        # re-embed memories left on a previous embedding model
npm run reembed -- --dry-run           # count what is pending without spending
```

`reembed` exists because `memories.embed_model` (migration `017`) scopes every similarity query to one
embedding space: rows embedded by an earlier model stay invisible to recall and dedup until it rewrites
them. It is resumable and safe to re-run.

## Health

```
curl -s localhost:3000/api/health
```

Returns `{ ok, release, missingCount, features }` and never touches the database, so an uptime poller can hit it
every minute. `release` is the deployed commit SHA (`dev` locally). `missingCount` is the number of required env
vars that are unset. Send `Authorization: Bearer <CRON_SECRET>` to also get `missing` (which vars are absent),
`stale`: every ingestion source that has gone quiet — extension history/bookmark sync, captured page text,
WhatsApp session and last message, a distill backlog nothing is draining, an import stuck in `running`, a
connector `last_error`. Any stale source sets `ok` to false and the status to 503, so point the poller at the authorized URL to be alerted. Thresholds
are the `HEALTH_STALE_*` env knobs. You also get `llm`: today's Azure OpenAI request and token totals per model,
from the `llm_usage_daily` table — informational spend visibility, never a factor in `ok`.
