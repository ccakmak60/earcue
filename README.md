# earcue

Ambient teleprompter and personal knowledge base — listens to your day, drafts what to say next, and builds a
searchable memory of what you've heard, read, and imported.

## What it is

A Next.js (App Router) app in strict TypeScript with shadcn/ui on Tailwind CSS v4, deployed on Cloudflare
Workers (via `@opennextjs/cloudflare`). Audio and screen frames are captured in the browser but transcribed
and analyzed server-side (`/api/ingest/audio`, `/api/ingest/frames`) — API keys live only in the server
environment and never reach the browser. Transcription, vision, reasoning, and memory embeddings all run on
Azure OpenAI (OpenAI-compatible `v1` API).

Auth is Google OAuth and email/password (better-auth; anyone can create an account), billing is Polar
(subscriptions gate analysis features), and all state lives in Azure Database for PostgreSQL Flexible
Server with `pgvector` for memory search, reached from the Worker over a Cloudflare Hyperdrive binding.
Optional Google and Slack connectors (`src/lib/server/connectors.ts`) backfill Gmail/Calendar/Slack
history into the knowledge base, and a companion browser extension (`extension/`) feeds browsing history
and bookmarks into the same pipeline.

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
scripts/                   migrate.mjs, seed-admin.ts, load-env.mjs
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
`/app`. Use the seeded account: entitlement never depends on `BILLING_ENABLED`. An account is entitled
when Polar says so (`plan = pro`) or when it is comped (`users.unlimited`, which `npm run dev:seed` and
`npm run seed:admin` both set) — anyone else, signed in or not, gets 402. Sign-up is public and inference
is billed to our Azure account, so billing being off cannot mean entitlement is on.

Extension on localhost: `npm run dev:token [email] [label]` prints a one-time ingest token plus the
base URL to paste into the extension's Options page, so history/bookmarks sync without the cookie
session. (The extension's `optional_host_permissions` already allow `http://localhost/*`.)

What stays production-only by design (not broken local setup): Google/Slack OAuth need prod redirect
URIs registered in their consoles, so their buttons stay hidden on localhost — use email/password.
Still missing `AZURE_OPENAI_API_KEY`/`AZURE_OPENAI_BASE_URL` in Development:
transcription/vision/reasoning calls fail until those are added to `.env.local` by hand, but sign-in,
ingest, traces, reviews-of-stored-data, imports, and memory recall all work without them.

The review sweep runs hourly from a Cloudflare Cron Trigger (`infra/sweep-cron`) in production — it picks
the users whose own clock has passed `REVIEW_LOCAL_HOUR` and fans one `earcue-sweep` message out per user.
Locally, call it directly:

```
curl -s localhost:3000/api/cron/review-sweep -H "Authorization: Bearer $CRON_SECRET"
```

## Deploy

```
npm run preview   # opennextjs-cloudflare build + local workerd preview on http://localhost:8787
npm run deploy    # opennextjs-cloudflare build + deploy, injecting COMMIT_SHA from `git rev-parse HEAD`
```

Three Workers: `wrangler.jsonc` is the app Worker `earcue` (`nodejs_compat`, smart placement, the
Hyperdrive binding, an `earcue-media` R2 bucket and the `earcue-ingest` queue producer);
`infra/sweep-cron/wrangler.jsonc` is `earcue-sweep-cron`, which holds the hourly trigger; and
`infra/task-consumer/wrangler.jsonc` is `earcue-task-consumer`, which drains both work queues back into
the app over HTTP. `COMMIT_SHA` is what `/api/health` reports as `release`.

Production is `earcue.lol`, attached as a **zone route** rather than a custom domain: the apex already
carries externally managed proxied A records, and the custom-domain API refuses a hostname that has them
(`code: 100117`). The same host is what `BETTER_AUTH_URL`, the cron Worker's `SWEEP_URL` and the
consumer's `PROCESS_URL` / `SWEEP_RUN_URL` point at. The account is on **Workers Free**, which rejects
`limits.cpu_ms` outright (`code: 100328`) and caps CPU at 10 ms per request — which is why transcription
moved off the request path. Restore `"limits": { "cpu_ms": 300000 }` when the account moves to Paid.

Provision once. Audio ingest degrades to the old synchronous behaviour while these are missing, so
deploying before they exist is safe:

```
wrangler r2 bucket create earcue-media
wrangler r2 bucket lifecycle add earcue-media expire-7d --expire-days 7 --abort-multipart-days 1
wrangler queues create earcue-ingest
wrangler queues create earcue-ingest-dlq
wrangler queues create earcue-sweep
wrangler queues create earcue-sweep-dlq
```

Secrets upload separately from `vars`, from an untracked `.env.production` holding `DATABASE_URL`,
`BETTER_AUTH_SECRET`, `CRON_SECRET`, `AZURE_OPENAI_API_KEY`, `CONNECTOR_ENC_KEY` and the two
`TURNSTILE_*` keys:

```
wrangler secret bulk .env.production
wrangler secret put CRON_SECRET -c infra/sweep-cron/wrangler.jsonc
wrangler secret put CRON_SECRET -c infra/task-consumer/wrangler.jsonc
wrangler deploy -c infra/sweep-cron/wrangler.jsonc
wrangler deploy -c infra/task-consumer/wrangler.jsonc
```

Audio ingest is asynchronous once the bucket and queue exist: `/api/ingest/audio` stores the chunk,
enqueues a pointer and answers `202`, `earcue-task-consumer` calls `/api/ingest/audio/process`, and the
trace rows are written server-side under the client's own chunk id — so a queue redelivery inserts
nothing twice. The Day view refreshes for two minutes after a flush to pick them up.

## Spend and abuse controls

Sign-up is public and every signed-in session can spend Azure OpenAI tokens, so three things stand
between a stranger and the bill:

1. **Entitlement.** An account is entitled only when Polar says `plan = pro` or when it is comped
   (`users.unlimited`). This holds with `BILLING_ENABLED=0` too — billing off is not billing-free.
   Comp an account with `npm run seed:admin <email>`.
2. **Per-account quotas.** `PLANS` in `src/lib/server/plans.ts` caps each metric per day and `consume()`
   enforces it (429). These are per account, so they bound one user, not a crowd.
3. **Deployment-wide ceiling.** `DAILY_TOKEN_CEILING` (unset/0 = off) caps a day's total Azure OpenAI
   tokens across every user and model. Past it, inference answers `503 spend_ceiling` while sign-in and
   stored-data reads keep working. `/api/health` (authorized) reports today's spend per model and the
   five accounts that spent the most.

Two more live in the Cloudflare dashboard rather than in this repo:

- **Turnstile on sign-up.** Set `TURNSTILE_SECRET_KEY` and `TURNSTILE_SITE_KEY` (both, or neither) from a
  Turnstile widget for the production hostname. The widget then renders on the sign-up form only, and
  better-auth verifies it on `/sign-up/email`; sign-in is deliberately never gated, so a failed widget
  load cannot lock out an existing account.
- **WAF rate limiting.** Add rate-limiting rules for `/api/auth/sign-up/*` and `/api/ingest/*` per IP.
  Nothing in the app depends on them, so they are safe to tune from the dashboard.

## Database

Migrations live in `db/migrations/` and are the single source of schema truth, applied in filename order and
tracked in a `schema_migrations` table.

```
npm run migrate                        # apply any pending migrations
npm run migrate:baseline               # mark all current migrations as applied without running them,
                                       # for a database that already has the schema
npm run seed:admin <email> [password]  # create/reset the owner's admin login, comped to plan=pro
```

## Health

```
curl -s localhost:3000/api/health
```

Returns `{ ok, release, missingCount, features }` and never touches the database, so an uptime poller can hit it
every minute. `release` is the deployed commit SHA (`dev` locally). `missingCount` is the number of required env
vars that are unset. Send `Authorization: Bearer <CRON_SECRET>` to also get `missing` (which vars are absent),
`stale`: every ingestion source that has gone quiet — extension history/bookmark sync, page capture, a distill
backlog nothing is draining, an import stuck in `running`, a connector `last_error`. Any stale
source sets `ok` to false and the status to 503, so point the poller at the authorized URL to be alerted. Thresholds
are the `HEALTH_STALE_*` env knobs. You also get `llm`: today's Azure OpenAI request and token totals per model,
from the `llm_usage_daily` table — informational spend visibility, never a factor in `ok`.
