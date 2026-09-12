# Repository Guidelines

## Project Overview

earcue is an ambient teleprompter and personal knowledge base: it listens to your day via browser
mic/screen capture, transcribes and analyzes that stream server-side, surfaces live drafting
suggestions and end-of-day reviews, and builds a searchable long-term memory (pgvector-backed) from
what you've heard, read, and imported (WhatsApp exports, browser history/bookmarks, Gmail/Calendar/Slack
backfill). It ships as a static frontend plus a set of Vercel Node serverless functions — no bundler, no
build step, no automated test suite. All AI inference (transcription, vision, reasoning) goes through
NVIDIA NIM's OpenAI-compatible `chat/completions`; Gemini's `batchEmbedContents` is used only to
generate memory embeddings.

## Architecture & Data Flow

**Client capture → server ingest → knowledge base**, roughly:

```
capture.js (getUserMedia/getDisplayMedia, MediaRecorder, frame-worker.js Worker)
  │ putChunk() → localstore.js IndexedDB          pushFrame() → in-memory queue
  ▼
pipeline.js flush()  (promise-chained so flushes never overlap)
  ├─ ingestAudioChunks() → POST /api/ingest/audio  → NIM transcription → turns → trace rows
  ├─ ingestFrames()      → POST /api/ingest/frames → NIM vision caption → trace row
  ├─ POST /api/traces (new + previously-failed "pending" rows; failure re-buffers, never drops)
  ├─ applyMeetingTransition() → POST /api/assist/meeting-open|close
  ├─ watchRows() → POST /api/watch → flag detection → trace rows → "earcue:flag" event
  └─ maybeSuggest() → src/assist.js → live suggestion cards
```

- Every client→server call goes through the single fetch wrapper `src/api.js`; no other module calls
  `fetch()` directly. It centralizes auth-failure handling by dispatching `window` `CustomEvent`s
  (`earcue:signedout` on 401, `earcue:paymentrequired` on 402, `earcue:quotaexceeded` on 429) instead of
  returning error objects — `app.js` and `src/budget.js` listen for these.
- Server-side, every authenticated endpoint follows the same three-step gate, each its own try/catch
  mapping a typed error to a status code: **`requireUser` (401) → `assertEntitled` (402, Polar plan
  check) → `consume` quota (429) → business logic**. See `api/watch.js` or `api/review.js` for the
  canonical shape.
- `api/traces.js` is the write/read path for the raw transcript timeline — **not** a debug/observability
  endpoint despite the name. `POST` batches captured rows in; `GET` serves the day view, `?q=` full-text
  search, `?from=/&to=` a calendar heatmap. `api/review.js` reads the same table to generate the nightly
  LLM summary. It's the 12th of Vercel Hobby's 12-function cap and isn't enumerated in `README.md`'s
  `api/` file list, but it's real and load-bearing.
- Knowledge base: `api/assist/[action].js` handles imports (`begin`/`browser`/`items`/`finish` chunked-
  upload protocol, chunk size 300 — reused identically by `src/knowledge.js` for file-based imports and
  by `extension/background.js` for live history/bookmark sync) and Gmail backfill. `api/_lib/knowledge.js`
  distills imported items into `memories` rows (Gemini embeddings, pgvector) and answers recall queries
  via hybrid **vector + full-text search fused with Reciprocal Rank Fusion**, re-ranked by a Postgres
  `memory_strength()` decay function. `api/cron/review-sweep.js` runs this distillation nightly alongside
  review generation.
- Auth: better-auth (`api/_lib/auth-server.js`) backs email/password + Google OAuth sessions at
  `api/auth/[...all].js`. `api/_lib/auth.js` — a distinct file, easy to confuse with `auth-server.js` — is
  what every other endpoint actually imports; it wraps `auth.api.getSession()` plus two more auth modes
  (device-key header `x-earcue-key`, ingest bearer tokens), all funneled through one `requireUser(req)`.
- Billing: Polar. `users.plan`/`plan_status` are cached columns written only by the Polar webhook
  (`syncEntitlement`, never trusted from client input); `assertEntitled` is a synchronous check against
  that cache — no live Polar call on the request path.
- Connectors (`api/connect/[action].js`, `api/_lib/connectors.js`): optional Google/Slack OAuth backfill,
  disabled with `501 connectors_disabled` if neither client ID is configured. OAuth tokens are
  AES-256-GCM encrypted at rest (`api/_lib/secretbox.js`) via `CONNECTOR_ENC_KEY`.
- Browser extension (`extension/`) is a fully independent codebase — it imports nothing from `src/`. It
  talks directly to the server with a manually-issued bearer token (not the cookie session `src/api.js`
  uses), reimplementing the same begin/chunked-rows/finish protocol server-side.

## Key Directories

| Path | Contents |
|---|---|
| `api/` | Vercel serverless functions. `_lib/` = shared server modules (`db`, `env`, `auth`, `auth-server`, `nim`, `embed`, `knowledge`, `entitlement`, `quota`, `plans`, `connectors`, `secretbox`, `log`). `ingest/`, `connect/`, `assist/`, `account/`, `auth/`, `cron/` = route groups. |
| `src/` | Browser ES modules — capture pipeline, per-tab UI controllers, `importers/` (pure parsers for WhatsApp/history/bookmarks). Loaded as raw `<script type="module">`, no bundler. |
| `extension/` | Manifest V3 browser extension (independent of `src/`); syncs history/bookmarks straight to the API via bearer token. |
| `db/migrations/` | Append-only SQL schema history, `NNN_description.sql`, tracked in a `schema_migrations` table. Source of truth for the schema — see table below. |
| `scripts/` | One-off `node` CLI scripts: `migrate.mjs`, `seed-admin.mjs`, `load-env.mjs` (a hand-rolled env loader the `.mjs` scripts need but `vercel dev` provides automatically). |
| `assets/` | Stylesheets only (`app.css`, `landing.css`, `earcue.css`). |
| root `*.html` | Static pages: `index.html` (marketing landing, no app logic), `app.html` (the actual SPA shell, loads `app.js`), `signin.html`, `account.html`, `terms.html`, `privacy.html`. |
| root `app.js` | The SPA's hand-written ESM entry point (**not** a bundle output) — boot sequencing, tab routing, DOM wiring, and `selfCheck()` (see Testing & QA). |

**Current migrations** (next one is `014_description.sql`):

| # | File | Adds |
|---|---|---|
| 000 | `000_init.sql` | `users`, `traces`, `day_reviews` |
| 001 | `001_usage.sql` | `usage_daily` counters |
| 002 | `002_better_auth.sql` | better-auth's own tables (`"user"`, `"session"`, `"account"`, `"verification"` — camelCase, not the project's snake_case) |
| 003 | `003_link_users.sql` | Links `users` → better-auth `"user"` via `auth_user_id` |
| 004 | `004_entitlement.sql` | `plan`, `plan_status`, `current_period_end` on `users` |
| 005 | `005_prefs.sql` | Email prefs on `users`/`day_reviews` |
| 006 | `006_search.sql` | Full-text search (`text_tsv` + GIN) on `traces` |
| 007 | `007_awareness.sql` | `connections`, `context_items`, `meetings`, `suggestions` |
| 008 | `008_knowledge.sql` | `vector` extension, `imports`, `memories` (pgvector, HNSW), `user_profile`, `ingest_tokens` |
| 009 | `009_account_issuer.sql` | Corrective patch — backfills `"account".issuer` required by better-auth ≥1.7.2 |
| 010 | `010_memory_graph.sql` | `memory_edges`, `memory_strength()` decay function, renames `user_profile.sections`→`buckets` |
| 011 | `011_drop_email_prefs.sql` | Drops the email-prefs columns added by `005_prefs.sql` (email delivery removed) |
| 012 | `012_unlimited.sql` | `users.unlimited`; partial unique index on `connections.scope` for the WhatsApp webhook lookup |
| 013 | `013_nim_usage.sql` | `nim_usage_daily` — per-day, per-model NIM requests and tokens, written by `chat()` on every HTTP attempt |

## Development Commands

```bash
npm install                                # 5 runtime deps, no devDependencies at all
npm run env:pull                           # vercel env pull .env.local — the only way env vars reach a dev machine
npx vercel dev                             # serves static files + api/ functions on one origin (matches prod routing/cleanUrls)
npm run migrate                            # apply pending db/migrations/*.sql (tracked in schema_migrations)
npm run migrate:baseline                   # mark all migrations applied without running them (adopt an existing DB)
npm run seed:admin <email> [password]      # create/reset the owner's admin login, comped to plan=pro
curl -s localhost:3000/api/health          # readiness check — {ok, release, missingCount, features}, no DB query
curl -s localhost:3000/api/health -H "Authorization: Bearer $CRON_SECRET"   # + missing, stale (per-source freshness; 503 when stale)
```

- `vercel dev` cannot be the `package.json` `dev` script — the Vercel CLI refuses to run if it detects
  itself as the project's own Development Command (avoids recursion) — so it's always invoked directly
  via `npx`.
- Opening any `.html` file directly from disk (`file://`) does not work — everything goes through
  same-origin `/api/...` fetches.

## Code Conventions & Common Patterns

**Server (`api/`)**
- **Dispatcher pattern**: `api/assist/[action].js`, `api/connect/[action].js`, `api/account/[action].js`
  read `req.query.action` (populated from the Vercel dynamic route segment, not a query string) and
  dispatch via a flat `if (action === "x" && method === "Y") return handleX(...)` chain, falling through
  to `404 {error:"not found"}`. This exists because **Vercel Hobby caps a deployment at 12 serverless
  functions** — add a related endpoint as a new `action` on an existing dispatcher, not a new top-level
  file, unless it genuinely needs its own `vercel.json` `functions` entry (different `maxDuration`, etc).
- **Auth/entitlement/quota gate**, repeated near-verbatim across every handler:
  ```js
  let user;
  try { user = await requireUser(req); }
  catch (e) { if (e instanceof Unauthorized) return res.status(401).json({ error: "unauthorized" }); throw e; }
  try { assertEntitled(user); }
  catch (e) { if (e instanceof PaymentRequired) return res.status(402).json({ error: "payment_required" }); throw e; }
  try { await consume(user, "watch_calls", 1); }
  catch (e) { if (e instanceof QuotaExceeded) return res.status(429).json({ error: "quota", metric: e.metric }); throw e; }
  ```
  Follow this exact order (auth → entitlement → quota → input validation → business logic) for any new
  authenticated endpoint.
- **Env vars**: only ever read via `import { env } from "./_lib/env.js"` then `env.SOME_VAR` — never
  `process.env` directly (the two documented exceptions are `api/health.js` and `api/_lib/auth-server.js`,
  which must read before `env`'s getters would throw). Required vars throw `missing required env: X`
  lazily, on first property access, not at import time.
- **Database**: always `` sql`select ... where id = ${x}` `` tagged templates from
  `@neondatabase/serverless`'s `neon()` client (`api/_lib/db.js`) — no ORM, no query builder, no
  string-concatenated SQL. Bulk inserts use `insert into ... select * from unnest($1::type[], ...)`. The
  one exception is `api/_lib/auth-server.js`, which opens its own `pg.Pool` because better-auth's adapter
  needs a real pool, not the neon HTTP driver — two independent Postgres access paths exist by design,
  don't try to unify them.
- **Errors**: typed classes carry a `.status` (`Unauthorized`=401, `PaymentRequired`=402,
  `QuotaExceeded`=429) but there's no central error middleware — every handler open-codes its own
  try/catch. JSON error shape is always `{ error: "snake_or_lower_string" }`, occasionally with one extra
  field. Wrong HTTP method → `res.status(405).end()` with no body. Unhandled errors propagate to a
  platform 500 by design — don't add a catch-all just to wrap them.
- **Logging**: `log(event, fields)` / `logError(event, err, fields)` from `api/_lib/log.js` emit one JSON
  line per call with snake_case `event` names — used sparingly, mainly for background/cron failures, not
  per-request 4xxs.

**Client (`src/`, `app.js`)**
- **No global store or event-bus library.** State is plain module-scoped `let` variables per file.
  Cross-module signaling uses native `CustomEvent`s dispatched on `window`: `earcue:signedout`,
  `earcue:paymentrequired`, `earcue:quotaexceeded`, `earcue:budget`, `earcue:chunk`, `earcue:synced`,
  `earcue:pending`, `earcue:flag`, `earcue:suggestion`. Reach for one of these before inventing a new
  cross-module coupling mechanism.
- **Shared pure logic lives in `src/`, not `api/_lib/`** — `src/turns.js` (ASR word→turn grouping) and
  `src/meetings.js`'s reducer are imported by both a serverless function and the browser, specifically
  because *Vercel does not serve `api/` as static assets*, so only `src/` files are loadable as raw
  browser ES modules. When logic needs to run in both places, put it in `src/`, not `api/_lib/`.
- **Pure/impure split for testability**: e.g. `src/frame-worker.js` exports plain functions
  (`shouldKeep`, `frameChanged`, `pickDistinct`, ...) alongside a `typeof window === "undefined"`-guarded
  Worker message loop, so the pure half can be exercised by `app.js`'s `selfCheck()` without spinning a
  real Worker. Follow this split for new capture/scoring logic.
- **Errors**: uniform `try { await x() } catch (err) { console.error("<action> failed", err); <local
  fallback> }`. Failures don't throw to the UI or show a generic error toast — `src/api.js` translates
  401/402/429 into the `CustomEvent`s above, and everything else falls back to buffering (`addPending`,
  `returnPendingFrames`) so the *next* flush retries, rather than retry-with-backoff.
- **No bundler**: `app.html` loads exactly one `<script type="module" src="app.js">`; every other file is
  reached via native relative ESM `import`. Named exports only — no default exports observed anywhere in
  `src/`.
- **Client must not import server code**: `src/budget.js` intentionally hardcodes a metric→cap-key map
  that mirrors `api/_lib/quota.js` instead of importing it, because that module ships to the browser.
  Server code may reuse `src/`, but `src/` must never import from `api/`.

## Important Files

| File | Role |
|---|---|
| `app.js` | SPA entry point + boot/routing/DOM wiring + `selfCheck()` |
| `src/api.js` | The only `fetch` boundary; central 401/402/429 handling |
| `src/pipeline.js` | Orchestrates ingest/trace-sync/meeting/watch/suggest flushes |
| `api/_lib/env.js` | Declares + lazily validates every env var; `missingEnv()` and the `HEALTH_STALE_*` knobs power `/api/health` |
| `api/_lib/db.js` | The `sql` tagged-template Postgres client (4 lines) |
| `api/_lib/auth.js` | `requireUser`/`requireDeviceUser`/`requireIngestUser` — what endpoints actually import |
| `api/_lib/auth-server.js` | The actual `betterAuth({...})` instance + Polar plugin wiring |
| `api/_lib/nim.js` | NVIDIA NIM `chat`/`chatJson` calls (retry/deadline/JSON-mode handling) |
| `api/_lib/embed.js` | Gemini `batchEmbedContents` + pgvector literal helpers |
| `api/_lib/entitlement.js`, `quota.js`, `plans.js` | Polar plan cache check, per-metric daily caps, plan definitions |
| `api/traces.js` | Timeline read/write API — not a debug/tracing tool (see Architecture) |
| `vercel.json` | Routing, `cleanUrls`, the one cron entry, per-function `maxDuration` overrides |
| `.env.example` | Canonical list of every env var, required and optional-with-default |

## Runtime/Tooling Preferences

- Node **22.x** (`package.json` `engines`) — the only runtime pin, enforced by Vercel's function runtime
  selection.
- Plain JavaScript, native ESM (`"type": "module"`). **No TypeScript, no bundler, no lint/format config
  exist in this repo** — don't introduce webpack/vite/esbuild, tsconfig, eslint, or prettier config
  without an explicit request; match the existing unbundled-ESM style instead.
- `npm` is the package manager (`package-lock.json` is committed); zero `devDependencies`.
- `.env.local` is generated by `npm run env:pull`, never hand-authored — to add a var, add it in the
  Vercel project's env settings and to `.env.example`, then re-pull.

## Testing & QA

- **No automated test framework, linter, or CI exists** (`.github/` is absent; no `*.test.js`/`*.spec.js`
  anywhere; no `devDependencies`). QA is manual: run `npx vercel dev` and exercise the affected
  page/endpoint directly, or check `curl -s localhost:3000/api/health`.
- `api/health.js` is the one health surface: `GET`-only, returns `{ ok, release, missingCount, features }`
  (200/503 by whether any required env var is unset) and never queries the database, so an uptime
  poller can hit it every minute. Send `Authorization: Bearer <CRON_SECRET>` to also get `missing` (which
  vars) and `stale` — per-source freshness (extension history/bookmark imports, WhatsApp session and last
  message, distill backlog, stuck imports, connector `last_error`), which flips `ok` to false and the status
  to 503. Thresholds are the `HEALTH_STALE_*` knobs; the rules are the pure `staleSources()` in
  `src/freshness.js`, so `selfCheck()` covers the same code the handler runs.
- `app.js` has a hand-rolled assertion suite, `selfCheck()`, exercising every pure function pulled out of
  `src/*` (`shouldKeep`, `groupTurns`, `frameChanged`, `meetingTransition`, `pickDistinct`, the three
  `src/importers/*` parsers, `staleSources`, the extension's history paging in `src/history-paging.js`, etc.) — triggered by visiting the app with `?selfcheck` in the URL instead of
  normal boot. **When adding new pure client-side logic, add a case here** rather than reaching for a
  test framework.
- Server-side, the closest thing to a regression signal is `api/_lib/log.js` output (`log`/`logError`,
  one JSON line per event) — wired mainly into `api/cron/review-sweep.js` and dispatcher catch-alls — plus
  the browser devtools console, where every client `catch` block logs `console.error("<action> failed",
  err)`.
- The 9 required env vars to boot cleanly (verify with `/api/health`): `DATABASE_URL`,
  `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `CRON_SECRET`, `NVIDIA_API_KEY`, `GEMINI_API_KEY`,
  `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_PRODUCT_ID_PRO`.
  Everything else (connector OAuth creds, model names, tuning knobs) has a coded default in
  `api/_lib/env.js`'s `ENV_DEFAULTS` and degrades gracefully when absent (e.g. connectors respond
  `501 connectors_disabled` without `GOOGLE_CLIENT_ID`/`SLACK_CLIENT_ID`).
- Database schema must be migrated (`npm run migrate`) against whatever `DATABASE_URL` points to before
  most endpoints will work.

## Project Management & Agent Tooling

**Linear** is the project tracker. Nothing in this codebase talks to its API (no key, no webhook) —
keep it in sync by convention:
- Before anything beyond a trivial fix, check Linear for an existing issue or create one describing
  the scope. With no other planning doc in this repo, the issue is the source of truth for *why* a
  change exists.
- Put the issue key in commit subjects and branch names (`<TEAM>-123: fix connector token refresh`,
  swapping `<TEAM>` for the workspace's actual team key) so Linear's GitHub integration auto-links
  the commit/PR to the issue.
- Move the issue through states as work lands (Todo → In Progress → In Review/Done) instead of
  leaving status stale once something's merged, and link it from the PR description rather than
  restating it there.
- An agent that needs to read or update issues directly, not just reference them, can connect
  Linear's official remote MCP server at `https://mcp.linear.app/mcp` (OAuth 2.1; a read-only
  variant is served at `/mcp/readonly`) instead of inferring scope from code alone.

**CodeGraph** (`@colbymchenry/codegraph`, MCP tool `codegraph_explore`) turns a grep → read → grep
exploration loop into one call that returns the relevant source plus call paths and blast radius —
use it for "how does X work" / "what calls X" / "what breaks if I change X" instead of re-reading
files from scratch every session. This repo has no index until someone opts in:
```bash
cd <repo root>
codegraph init      # one-time; writes .codegraph/ (gitignored — local SQLite, nothing to commit)
```
A file watcher keeps the graph current after that — no manual re-sync, and nothing to rebuild
between sessions. Treat `codegraph init` as a deliberate, one-time opt-in per checkout; don't run it
unprompted on a clone that hasn't asked for it.

**Documentation** — `README.md` (product-facing), this file (contributor/architecture reference),
and `.omp/AGENTS.md` (OMP-session addenda, gitignored/local-only) describe the same system from
three angles and drift independently if only one gets touched. Update whichever one(s) a change
affects **in the same commit**, not as a follow-up:
- New migration → add a row to the migrations table above and bump the "next one is `0NN_...`" note.
- New or changed env var → `.env.example` first, then the required-vars list under Testing & QA.
- New API route, dispatcher action, or convention → the Architecture, Key Directories, or Code
  Conventions sections above, whichever it changes.
Stale documentation is a bug here, same as stale code.
