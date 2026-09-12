# earcue

Ambient teleprompter and personal knowledge base — listens to your day, drafts what to say next, and builds a
searchable memory of what you've heard, read, and imported.

## What it is

A static frontend (`index.html`, `app.html`, `account.html`, `signin.html`) backed by Vercel Node serverless
functions. Audio and screen frames are captured in the browser but transcribed and analyzed server-side
(`api/ingest/audio.js`, `api/ingest/frames.js`) — API keys live only in the server environment and never reach
the browser. Transcription, vision, and reasoning run on NVIDIA NIM (OpenAI-compatible `chat/completions`);
Gemini's `batchEmbedContents` is used only for memory embeddings.

Auth is Google OAuth and email/password (better-auth; anyone can create an account), billing is Polar
(subscriptions gate analysis features), and all state lives in Postgres (Neon) with `pgvector` for memory
search. Optional Google and Slack connectors (`api/_lib/connectors.js`) backfill Gmail/Calendar/Slack
history into the knowledge base, and a companion browser extension (`extension/`) feeds browsing history
and bookmarks into the same pipeline.

## Architecture

- `api/` — Vercel serverless functions: `ingest/audio.js` and `ingest/frames.js` (transcription/vision),
  `watch.js` (flag detection), `review.js` (end-of-day review), `factcheck.js`, `assist/[action].js` (meeting
  notes/suggestions, and the knowledge base: imports, memory search, distillation, Gmail backfill — merged in
  since the Vercel Hobby plan caps a deployment at 12 Serverless Functions), `connect/[action].js`
  (Google/Slack OAuth connectors), `account/[action].js` (billing/account), `auth/[...all].js` (better-auth),
  `cron/review-sweep.js` (nightly day review generation plus knowledge distillation), `health.js` (release +
  config health), and `_lib/` (shared: `db.js`, `env.js`, `nim.js`, `embed.js`, `knowledge.js`,
  `connectors.js`, `secretbox.js`, `log.js`, `entitlement.js`, `quota.js`, `plans.js`, `auth.js`,
  `auth-server.js`).
- `src/` — browser modules: `capture.js`/`frame-worker.js`/`vad.js` (mic/screen capture), `pipeline.js`
  (ingest orchestration), `meetings.js` (meeting-boundary detection), `day.js` (day view), `knowledge.js`
  (memory/search UI), `connect.js` (connector UI), `importers/` (WhatsApp/history/bookmarks import parsing),
  `localstore.js` (client-side cache), `api.js` (fetch wrapper), `wav.js`, `budget.js`, `turns.js`.
- `extension/` — Manifest V3 browser extension that feeds history and bookmarks into the knowledge base.
- `db/migrations/` — the schema, source of truth, applied in order and tracked in `schema_migrations`.
- `assets/` — stylesheets.

## Config

Every required and optional environment variable is listed in `.env.example`. `api/_lib/env.js` validates
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
npx vercel dev
```

`vercel dev` serves the static files and the `api/` functions on one origin, matching production routing
(including `cleanUrls`). It cannot be wrapped in a `package.json` `dev` script — the Vercel CLI refuses to
start if it finds itself named as the project's own `dev` script, since Project Settings' Development Command
can default to `npm run dev`, which would recurse. Run it directly. Opening `index.html` directly from the
filesystem does not work either way — every call in `src/api.js` is a same-origin `/api/...` request that
needs a server behind it.

## Database

Migrations live in `db/migrations/` and are the single source of schema truth, applied in filename order and
tracked in a `schema_migrations` table.

```
npm run migrate            # apply any pending migrations
npm run migrate:baseline   # mark all current migrations as applied without running them,
                            # for a database that already has the schema
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
