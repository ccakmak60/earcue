# earcue

Real-time teleprompter — listens to a conversation and drafts your next line with the Gemini Live API.

## What it is

A static frontend (`index.html`, `app.html`, `account.html`, `signin.html`) backed by Vercel Node serverless
functions. Audio and screen frames are captured in the browser but transcribed and analyzed server-side
(`api/ingest/audio.js`, `api/ingest/frames.js`) — the Gemini API key lives only in the server environment and
never reaches the browser. The one exception is the Live "Coach" session: the browser opens a WebSocket
directly to Gemini's bidirectional Live API, authenticated with a short-lived token minted server-side
(the `live-token` action in `api/assist/[action].js`) rather than a real API key.

Auth is magic-link (better-auth), billing is Polar (subscriptions gate the Live/analysis features), email is
Resend, and all state lives in Postgres (Neon).

## Architecture

- `api/` — Vercel serverless functions: `ingest/audio.js` and `ingest/frames.js` (transcription/vision),
  `watch.js` (flag detection), `review.js` (end-of-day review), `factcheck.js`, `live/token.js` (Live session
  token minting), `checkout.js` and `account/[action].js` (billing/account), `auth/[...all].js` (better-auth),
  `cron/review-sweep.js` (nightly/weekly digest sweep), `health.js` (release + config health), and `_lib/`
  (shared: `db.js`, `email.js`, `env.js`, `gemini.js`, `log.js`, `entitlement.js`, `quota.js`, `auth.js`,
  `auth-server.js`).
- `src/` — browser modules: `capture.js`/`frame-worker.js` (mic/screen capture), `pipeline.js` (ingest
  orchestration), `live.js` (Coach WebSocket session), `day.js` (day view), `localstore.js` (client-side
  cache), `api.js` (fetch wrapper), `turns.js`.
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

Returns `{ ok, release, missingCount }`. `release` is the deployed commit SHA (`dev` locally). `missingCount`
is the number of required env vars that are unset. Send `Authorization: Bearer <CRON_SECRET>` to also get a
`missing` array naming which vars are absent — useful for diagnosing a broken deploy without exposing that
information publicly.
