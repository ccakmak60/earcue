# earcue

Ambient teleprompter and personal knowledge base — listens to your day, drafts what to say next, and builds a
searchable memory of what you've heard, read, and imported.

## What it is

A Next.js (App Router) app in strict TypeScript with shadcn/ui on Tailwind CSS v4, deployed on Cloudflare
Workers (via `@opennextjs/cloudflare`). Audio and screen frames are captured in the browser but transcribed
and analyzed server-side (`/api/ingest/audio`, `/api/ingest/frames`) — API keys live only in the server
environment and never reach the browser. Transcription, vision, and reasoning run on Azure OpenAI
(OpenAI-compatible `v1` API); Gemini's `batchEmbedContents` is used only for memory embeddings. WAHA
(WhatsApp) runs always-on as a container on Azure App Service.

Auth is Google OAuth and email/password (better-auth; anyone can create an account), billing is Polar
(subscriptions gate analysis features), and all state lives in Postgres (Neon) with `pgvector` for memory
search. Optional Google and Slack connectors (`src/lib/server/connectors.ts`) backfill Gmail/Calendar/Slack
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
`/app`. One seeded account is enough: with `BILLING_ENABLED=0` (the local default) every signed-in
user gets Pro caps and passes entitlement, and the seeded account is additionally unlimited/comped
so it stays entitled even with billing on.

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
`stale`: every ingestion source that has gone quiet — extension history/bookmark sync, WhatsApp session and last
message, a distill backlog nothing is draining, an import stuck in `running`, a connector `last_error`. Any stale
source sets `ok` to false and the status to 503, so point the poller at the authorized URL to be alerted. Thresholds
are the `HEALTH_STALE_*` env knobs. You also get `llm`: today's Azure OpenAI request and token totals per model,
from the `llm_usage_daily` table — informational spend visibility, never a factor in `ok`.
