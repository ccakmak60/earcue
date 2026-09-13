# earcue

Ambient teleprompter and personal knowledge base — listens to your day, drafts what to say next, and builds a
searchable memory of what you've heard, read, and imported.

## What it is

A Next.js (App Router) app in strict TypeScript with shadcn/ui on Tailwind CSS v4, deployed on Vercel. Audio and
screen frames are captured in the browser but transcribed and analyzed server-side (`/api/ingest/audio`,
`/api/ingest/frames`) — API keys live only in the server environment and never reach the browser. Transcription,
vision, and reasoning run on NVIDIA NIM (OpenAI-compatible `chat/completions`); Gemini's `batchEmbedContents` is
used only for memory embeddings.

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
  lib/server/              server-only modules: env, db, auth, quota, NIM, knowledge base, connectors
  lib/client/              client-only modules: capture, frame worker, IndexedDB, pipeline, transport
tests/unit/                Vitest, mirroring src/lib (tests/e2e is reserved for Playwright)
extension/                 Manifest V3 browser extension (independent of src/)
db/migrations/             the schema, source of truth
scripts/                   migrate.mjs, seed-admin.ts, load-env.mjs
```

The API keeps its URLs: single routes (`watch`, `factcheck`, `traces`, `review`, `health`, `ingest/*`,
`cron/review-sweep`), better-auth at `auth/[...all]`, and three `[action]` dispatchers (`account`, `connect`,
`assist`) that keep the deployment within Vercel Hobby's 12-function cap.

## Config

Every required and optional environment variable is listed in `.env.example`. `src/lib/server/env.ts` validates
required vars on first access and fails fast with a clear error; `missingEnv()` reports what's absent without
throwing, which is what powers `/api/health`.

To populate `.env.local` from the linked Vercel project:

```
npm run env:pull
```

## Local dev

```
npm install
npm run env:pull
npm run dev          # next dev on http://localhost:3000
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run build        # next build
```

The nightly sweep runs from Vercel cron in production; locally, call it directly:

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
vars that are unset. Send `Authorization: Bearer <CRON_SECRET>` to also get `missing` (which vars are absent) and
`stale`: every ingestion source that has gone quiet — extension history/bookmark sync, WhatsApp session and last
message, a distill backlog nothing is draining, an import stuck in `running`, a connector `last_error`. Any stale
source sets `ok` to false and the status to 503, so point the poller at the authorized URL to be alerted. Thresholds
are the `HEALTH_STALE_*` env knobs.
