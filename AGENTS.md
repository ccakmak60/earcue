# Repository Guidelines

## Project Overview

earcue is an ambient teleprompter and personal knowledge base: it listens to your day via browser
mic/screen capture, transcribes and analyzes that stream server-side, surfaces live drafting
suggestions and end-of-day reviews, and builds a searchable long-term memory (pgvector-backed) from
what you've heard, read, and imported (WhatsApp exports, browser history/bookmarks, Gmail/Calendar/Slack
backfill). It is a Next.js App Router app in strict TypeScript with shadcn/ui on Tailwind CSS v4, deployed
on Cloudflare Workers (via `@opennextjs/cloudflare`), with a Vitest unit suite. All AI inference
(transcription, vision, reasoning, memory embeddings) goes through Azure OpenAI. Chat and embeddings use
the OpenAI-compatible `v1` API; **transcription does not**, because Azure's `v1` surface does not route
`/audio/transcriptions` (404 `DeploymentNotFound`), so `transcribe()` alone falls back to the legacy
`/openai/deployments/<name>/audio/transcriptions?api-version=…` path with `api-key` auth.

## Architecture & Data Flow

**Client capture → server ingest → knowledge base**, roughly:

```
lib/client/capture.ts (getUserMedia/getDisplayMedia, MediaRecorder, frame-worker.ts Worker)
  │ putChunk() → localstore.ts IndexedDB          pushFrame() → in-memory queue
  ▼
lib/client/pipeline.ts flush()  (promise-chained so flushes never overlap)
  ├─ ingestAudioChunks() → POST /api/ingest/audio
  │    with R2+queue bound: chunk → R2, pointer → earcue-ingest, 202 queued, client drops the chunk
  │      → earcue-task-consumer → POST /api/ingest/audio/process → Azure transcription → trace rows
  │      (client_id `<chunkId>#<i>`, so a queue redelivery inserts nothing; Day view polls 2 min)
  │    without them: transcribes inline and returns turns, as before
  ├─ ingestFrames()      → POST /api/ingest/frames → Azure OpenAI vision caption → trace row
  ├─ POST /api/traces (new + previously-failed "pending" rows; failure re-buffers, never drops)
  ├─ applyMeetingTransition() → POST /api/assist/meeting-open|close
  ├─ watchRows() → POST /api/watch → flag detection → trace rows → "earcue:flag" event
  └─ maybeSuggest() → lib/client/assist.ts → "earcue:suggestion" toasts + Assist view
```

- Every client→server data call goes through `src/lib/client/api.ts` (`get`/`post`/`postBinary`). It
  centralizes auth-failure handling by dispatching `window` `CustomEvent`s (`earcue:signedout` on 401,
  `earcue:paymentrequired` on 402, `earcue:quotaexceeded` on 429) and still throws, instead of returning
  error objects — the app shell and `lib/client/budget.ts` listen for these.
- Server-side, every authenticated endpoint follows the same gate: **`requireUser` (401) →
  `assertEntitled` (402, Polar plan check) → `consume` quota (429) → business logic**. I/O-free
  input-shape validation runs before `consume` so a malformed request cannot burn a quota unit; auth
  and entitlement stay ahead of everything.
  The helpers throw typed errors; `withErrors()` in `src/lib/server/respond.ts` maps them to responses.
  See `src/app/api/watch/route.ts` for the canonical shape.
- `/api/traces` is the write/read path for the raw transcript timeline — **not** a debug/observability
  endpoint despite the name. `POST` batches captured rows in; `GET` serves the day view, `?q=` full-text
  search, `?from=&to=` a calendar heatmap. `/api/review` reads the same table to generate the day review
  (`runReview` in `src/lib/server/review.ts`, shared with the nightly cron).
- Knowledge base: `/api/assist/[action]` handles imports (`begin`/`browser`/`items`/`finish` chunked-upload
  protocol, chunk size 300 — reused identically by `lib/client/knowledge.ts` for file-based imports and by
  `extension/background.js` for live history/bookmark sync) and Gmail backfill. WhatsApp arrives only as an
  exported `.txt` chat, parsed client-side by `src/lib/shared/importers/whatsapp.ts`.
  `src/lib/server/knowledge.ts` distills imported items into `memories` rows (Azure OpenAI embeddings, pgvector)
  and answers recall queries via hybrid **vector + full-text search fused with Reciprocal Rank Fusion**,
  re-ranked by a Postgres `memory_strength()` decay function. `GET /api/assist/catchup` plans this
  distillation per user, action-triggered rather than scheduled; the client then runs it as an
  ordinary `POST /api/assist/distill`. The two cosine cut-offs on that path
  (`MEMORY_DEDUP_SIM`, `RECALL_MIN_SIM`) are fitted to `MODEL_EMBED` — `earcue-embed`'s bands are
  0.72 and 0.15, far below the pre-017 Gemini ones — so a change of embedding model means refitting
  them on labelled pairs, not just re-embedding (migration 017).
- Auth: better-auth (`src/lib/server/auth-server.ts`, built lazily by `getAuth()`) backs email/password +
  Google OAuth sessions at `/api/auth/[...all]`. `src/lib/server/auth.ts` — a distinct file, easy to confuse
  with `auth-server.ts` — is what every other endpoint imports; it wraps `getSession({ headers })` plus
  ingest bearer tokens, funneled through `requireUser(headers)`, `requireIngestUser(headers)` and the
  dispatcher helper `requireAuthed()`.
  Protected pages (`/app`, `/account`) gate in the server component with `requirePageSession()`.
- Billing: Polar. `users.plan`/`plan_status` are cached columns written only by the Polar webhook
  (`syncEntitlement`, never trusted from client input); `assertEntitled` is a synchronous check against
  that cache — no live Polar call on the request path. `effectivePlan` does **not** grant access when
  `BILLING_ENABLED=0`: sign-up is public and inference is billed to our Azure account, so an
  un-comped account is `plan = none` either way. Access without Polar means `users.unlimited`.
- Spend: `chat` and `transcribe` take a `userId` and meter into `llm_usage_daily` (per day, per model,
  per user — migration `018`; embeddings meter into the same table as system spend). All three refuse
  past `DAILY_TOKEN_CEILING` with `SpendCeilingReached` → 503. That ceiling is a deployment-wide backstop
  read once per isolate, not a per-user quota; `consume()` is still what caps one account.
- Sign-up abuse: Turnstile guards `/sign-up/email` only (better-auth's `captcha` plugin, wired in
  `auth-server.ts`), and only when both `TURNSTILE_SECRET_KEY` and `TURNSTILE_SITE_KEY` are set.
- Connectors (`/api/connect/[action]`, `src/lib/server/connect.ts`, `connectors.ts`): optional
  Google/Slack OAuth backfill, disabled with `501 connectors_disabled` when no
  connector is configured. OAuth tokens are AES-256-GCM encrypted at rest (`secretbox.ts`) via
  `CONNECTOR_ENC_KEY`.
- Browser extension (`extension/`) is a fully independent codebase — it imports nothing from `src/`. It
  talks directly to the server with a manually-issued bearer token (not the cookie session), using the
  same begin/chunked-rows/finish protocol; `begin`/`browser`/`finish` answer CORS preflight for it.

## Key Directories

| Path | Contents |
|---|---|
| `src/app/` | Pages (`/`, `/signin`, `/app`, `/account`, `/privacy`, `/terms`), `layout.tsx`, `globals.css` (earcue tokens mapped onto shadcn variables), and `api/**/route.ts` handlers. |
| `src/components/ui/` | shadcn/ui components (`npx shadcn add <name>`; the CLI may rewrite the `cn` import path — keep `@/lib/utils`). |
| `src/components/{app,auth,account,marketing}/` | Feature components. `app/` is the `/app` shell, views and settings sheet. |
| `src/hooks/` | `use-earcue-event.ts` (subscribe to `earcue:*`), `use-ambient-capture.ts` (All day UI state). |
| `src/lib/shared/` | Pure, isomorphic logic and payload types (`types.ts`), importable from server, client and tests. |
| `src/lib/server/` | Server-only modules: `env`, `db`, `request-scope`, `bindings` (R2/queue accessors off the request scope), `auth`, `auth-server`, `page-session`, `errors`, `respond`, `llm`, `embed`, `knowledge`, `review`, `entitlement`, `quota`, `plans`, `connectors`, `connect`, `account`, `secretbox`, `log`, and `assist/*` (dispatcher actions by area, including `catchup`). |
| `src/lib/client/` | Client-only modules: `api`, `events`, `auth-client`, `localstore`, `capture`, `frame-worker`, `vad-gate`, `pipeline`, `budget`, `catchup`, `meetings`, `assist`, `connect`, `knowledge`, `day`. |
| `tests/unit/` | Vitest suites mirroring `src/lib`: `shared/`, `server/` (`embed.test.ts`, `llm-transcribe.test.ts`, `knowledge-distill.test.ts`, `knowledge-dedup.test.ts`), `client/` and `api/` (`ingest-audio.test.ts`, `gate.test.ts`, `_harness.ts`). `tests/e2e/` is reserved for Playwright. |
| `extension/` | Manifest V3 browser extension (independent of `src/`); syncs history/bookmarks straight to the API via bearer token. |
| `db/migrations/` | Append-only SQL schema history, `NNN_description.sql`, tracked in a `schema_migrations` table. Source of truth for the schema — see table below. |
| `scripts/` | CLI scripts: `migrate.mjs` and `load-env.mjs` (plain Node), `seed-admin.ts` (run through `tsx --conditions=react-server`). |
| `docs/solutions/` | Documented solutions to past problems (bugs, best practices, workflow patterns), organized by category with YAML frontmatter (module, tags, problem_type); check when implementing or debugging in a documented area. |
| `infra/task-consumer/` | Cloudflare Worker (`earcue-task-consumer`) consuming `earcue-ingest` → `/api/ingest/audio/process` with `Bearer CRON_SECRET`. Per-message `ack()`/`retry()`, with a DLQ. Holds no business logic — it is a transport. |

**Current migrations** (next one is `020_description.sql`):

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
| 013 | `013_nim_usage.sql` | `nim_usage_daily` — per-day, per-model request and token counters for LLM spend, written by `chat()` on every HTTP attempt (renamed by 015) |
| 014 | `014_drop_device_key.sql` | Drops `users.device_key_hash` — the dead device-key auth path was removed |
| 015 | `015_llm_usage_rename.sql` | Renames `nim_usage_daily` → `llm_usage_daily` (NVIDIA NIM replaced by Azure OpenAI) |
| 016 | `016_page_capture.sql` | `users.capture_pages`; partial index on `context_items` for `kind = 'page_text'` |
| 017 | `017_reembed_memories.sql` | Nulls `memories.embedding` after the Gemini → Azure OpenAI embedding move; `scripts/reembed-memories.ts` regenerates it |
| 018 | `018_llm_usage_user.sql` | `llm_usage_daily.user_id` — attributes Azure OpenAI spend to an account (null = system work) |
| 019 | `019_drop_whatsapp_connector.sql` | Deletes `connections` rows for the removed WAHA connector and drops the `connections_whatsapp_session` index 012 added for its webhook |

## Development Commands

```bash
npm install
npm run dev:doctor                          # names-only env + migration check, never prints values; `AZURE_OPENAI_API_KEY`/`AZURE_OPENAI_BASE_URL` missing = the only required gap in Development
npm run dev:seed <email> [password]         # thin wrapper over seed:admin (no duplicated auth logic); comped to plan=pro/unlimited
npm run dev:up                              # doctor, then next dev on :3000 (pages + API routes on one origin)
npm run dev:token [email] [label]           # mint an extension ingest token without logging in
npm run dev                                # next dev on :3000 (pages + API routes on one origin)
npm run typecheck                          # tsc --noEmit (strict)
npm run lint                               # oxlint + @shadcn/lint (design-system rules per DESIGN.md — see .oxlintrc.json)
npm test                                   # vitest run
npm run build                              # next build (also type-checks)
npm run preview                            # opennextjs-cloudflare build + preview on http://localhost:8787 (workerd runtime)
npm run deploy                              # opennextjs-cloudflare build + deploy to Cloudflare Workers
npm run cf-typegen                          # regenerate cloudflare-env.d.ts from wrangler.jsonc bindings
npm run migrate                            # apply pending db/migrations/*.sql (tracked in schema_migrations)
npm run migrate:baseline                   # mark all migrations applied without running them (adopt an existing DB)
npm run seed:admin <email> [password]      # create/reset the owner's admin login, comped to plan=pro
npm run reembed                            # regenerate memories.embedding after an embedding-model change
curl -s localhost:3000/api/health          # readiness check — {ok, release, missingCount, features}, no DB query
curl -s localhost:3000/api/health -H "Authorization: Bearer $CRON_SECRET"   # + missing, stale, llm (today's Azure OpenAI spend)
curl -s localhost:3000/api/assist/catchup -b "<session-cookie>"   # what's outstanding for the signed-in user
```

- Local sign-in friction is handled in code, not docs: `/signin` redirects an already-signed-in
  browser straight to `/app`, accepts `?email=` to prefill the form, and sign-in uses a long-lived
  `rememberMe` session. Launch URL: `http://localhost:3000/signin?email=<seeded>`. Sign-up deliberately
  skips `rememberMe` — the better-auth client type doesn't accept it there.

- `next dev` rewrites the Next.js block at the end of this file; commit it rather than deleting it.

## Code Conventions & Common Patterns

**Layers**
- `src/lib/shared` is pure: no imports from `@/lib/server`, `@/lib/client`, `react` or `next`, and no
  browser globals at module load. `src/lib/server/*` imports `server-only` and `src/lib/client/*` imports
  `client-only`, so a wrong-direction import fails the build. Server code may use `shared`; client code
  may use `shared`; neither imports the other.
- When logic must run in both places (e.g. `groupTurns`, `staleSources`, the meeting reducer), put the pure
  part in `src/lib/shared` and keep the stateful part in its layer. `src/lib/shared/budget.ts` hardcodes a
  metric→cap-key map that mirrors `src/lib/server/quota.ts` rather than importing it for the same reason.

**Server (`src/app/api`, `src/lib/server`)**
- **Route handlers** use Web `Request`/`Response` only (no `next/headers` in API code), so a test can import a
  route module and call its exported method. Export only the methods the endpoint accepts; Next.js answers
  others with 405 and an empty body.
- **Dispatcher pattern**: `src/app/api/{assist,connect}/[action]/route.ts` look handlers up in a
  `Map` keyed by `"METHOD action"` and answer any miss with `404 {error:"not found"}`;
  `account/[action]` keys by action only and each action returns 405 on a wrong method. This convention
  predates the Cloudflare move (it kept the app within Vercel Hobby's 12-function cap) but stays: add a
  related endpoint as a new action on an existing dispatcher (its handler in
  `src/lib/server/{account,connect}.ts` or `assist/*.ts`), not a new route.
- **Auth/entitlement/quota gate**:
  ```ts
  export const POST = withErrors(async (request: Request) => {
    const user = await requireUser(request.headers);   // Unauthorized → 401 {error:"unauthorized"}
    assertEntitled(user);                              // PaymentRequired → 402 {error:"payment_required"}
    await consume(user, "watch_calls", 1);             // QuotaExceeded → 429 {error:"quota", metric}
    const body = await readJson(request);              // then validate input
    ...
  });
  ```
  Follow this order for any new authenticated endpoint. Dispatcher actions are wrapped by the route, so
  they just throw. When an action needs a side effect on quota failure, catch, do it, and rethrow.
- **Errors**: typed classes in `errors.ts` (`Unauthorized`, `PaymentRequired`, `QuotaExceeded`,
  `PayloadTooLarge`). JSON error shape is always `{ error: "snake_or_lower_string" }`, occasionally with one
  extra field. Unhandled errors propagate to a platform 500 by design — don't add a catch-all.
- **Env vars**: only via `import { env } from "@/lib/server/env"` then `env.SOME_VAR` — never `process.env`
  directly outside `env.ts`, except `src/app/api/health/route.ts` (release SHA and the `CRON_SECRET` compare).
  Required vars throw `missing required env: X` lazily, on first property access, not at import time.
- **Database**: always `` sql`select ... where id = ${x}` `` tagged templates from `src/lib/server/db.ts`
  — no ORM, no query builder, no string-concatenated SQL. In production the client is `pg` over a
  Cloudflare Hyperdrive binding, memoised per request on `src/lib/server/request-scope.ts`'s
  `AsyncLocalStorage` (a socket opened in one Worker request cannot be reused by another); outside the
  Worker (`next dev`, `tsx scripts/*.ts`, vitest) it is one process-wide `pg.Pool` against `DATABASE_URL`.
  Bulk inserts use `insert into ... select * from unnest($1::type[], ...)`. `auth-server.ts` opens its
  own `pg` pool the same way, because better-auth's adapter needs a real pool — two independent Postgres
  access paths exist by design, don't unify them. Neither may connect at import time: `next build` loads
  route modules.
- **LLM JSON**: `chatJson<T>()` asks for a schema but does not validate; read fields defensively.
- **Logging**: `log(event, fields)` / `logError(event, err, fields)` from `log.ts` emit one JSON line per
  call with snake_case `event` names — used sparingly, mainly for background/cron failures.

**Client (`src/lib/client`, `src/components`, `src/hooks`)**
- **No global store.** Capture, pipeline and budget state are module-scoped in `src/lib/client` so capture
  keeps running while React views change; `startAmbient`/`startBudgetLoop` are idempotent (React
  StrictMode runs effects twice in dev). Cross-module signaling uses the typed `earcue:*` events in
  `events.ts` (`earcue:signedout`, `paymentrequired`, `quotaexceeded`, `budget`, `chunk`, `synced`,
  `pending`, `flag`, `suggestion`, `suggestionsupdated`); components subscribe with `useEarcueEvent`.
- `src/lib/client` modules do no DOM lookups; they return data or emit events and components render.
- The `/app` shell keeps all three views mounted and toggles `hidden`, and the settings sheet keeps its
  section state in hooks called outside the (unmounting) sheet content, so in-progress state (counters,
  imports, minted token) survives navigation. Don't `forceMount` Radix dialogs/sheets: their scroll lock
  and `aria-hidden` apply whenever the content is mounted, not only while open. Read
  `localStorage` (`earcue.view`, `earcue.onboarded`) only after mount.
- **Errors**: `try { await x() } catch (err) { console.error("<action> failed", err); <local fallback> }`.
  Failures don't throw to the UI; the pipeline re-buffers (`addPending`, `returnPendingFrames`) so the next
  flush retries.
- The frame worker is loaded with `new Worker(new URL("./frame-worker.ts", import.meta.url), { type: "module" })`
  and imports its signature math from `src/lib/shared/frames.ts`.
- UI: shadcn/ui components themed through `globals.css` (`--ec-*` brand tokens → shadcn variables; extras
  like `bg-brand`, `font-display`, `max-w-content`). There is one light theme. `DESIGN.md` is the authority
  for any UI work — tokens, type, layout, components, motion, and the Vercel-restraint rules adapted to this stack.

## Important Files

| File | Role |
|---|---|
| `src/components/app/app-shell.tsx` | `/app` boot (entitlement, budget loop, view restore) and view routing |
| `src/lib/client/api.ts` | The data fetch boundary; central 401/402/429 handling |
| `src/lib/client/pipeline.ts` | Orchestrates ingest/trace-sync/meeting/watch/suggest flushes |
| `src/lib/server/env.ts` | Declares + lazily validates every env var; `missingEnv()` and the `HEALTH_STALE_*` knobs power `/api/health` |
| `src/lib/server/respond.ts` | `withErrors`, `json`, `empty`, `readJson`, `query` |
| `src/lib/server/auth.ts` | `requireUser`/`requireIngestUser`/`requireAuthed` — what endpoints import |
| `src/lib/server/auth-server.ts` | The `betterAuth({...})` instance (`getAuth()`) + Polar plugin wiring |
| `src/lib/server/llm.ts` | Azure OpenAI `chat`/`chatJson`/`transcribe` calls (retry/deadline/JSON-mode handling), per-user metering and the `DAILY_TOKEN_CEILING` backstop; `transcribeUrl()` is the one caller that leaves the `v1` base URL |
| `src/lib/server/embed.ts` | Azure OpenAI `/embeddings` call + pgvector literal helpers |
| `src/lib/server/entitlement.ts`, `quota.ts`, `plans.ts` | Polar plan cache check, per-metric daily caps, plan definitions |
| `src/app/api/traces/route.ts` | Timeline read/write API — not a debug/tracing tool (see Architecture) |
| `next.config.ts` | Redirects from the old `*.html` URLs |
| `wrangler.jsonc` | Cloudflare Worker config — the `earcue.lol/*` zone route, the R2 bucket and ingest queue producer, vars, and the OpenNext build entrypoint. No `limits.cpu_ms`: the account is on Workers Free, which rejects the field (API 100328) and caps CPU at 10 ms per request |
| `.env.example` | Canonical list of every env var, required and optional-with-default |
| `DESIGN.md` | Design-system authority (tokens, type, layout, components, motion) — read before any UI work |

## Runtime/Tooling Preferences

- Node **22.x** (`package.json` `engines`) — the local dev/CI pin; Workers run under `nodejs_compat`, not Node itself.
- TypeScript `strict`, native ESM (`"type": "module"`), `@/*` → `src/*`. Next.js 16 with Turbopack.
- No ESLint config yet (`next lint` no longer exists in Next.js 16); don't add lint/format tooling without a
  request.
- `npm` is the package manager (`package-lock.json` is committed).
- `.env.local` is hand-authored from `.env.example` — there is no Vercel project to pull from anymore.

## Testing & QA

- **Vitest** (`vitest.config.ts`): tests live in `tests/unit/**`, mirroring `src/lib`. Node environment by
  default; a file that needs the DOM opts in with `// @vitest-environment jsdom` (see
  `tests/unit/shared/bookmarks.test.ts`). `server-only` and `client-only` are aliased so tests can import
  either layer.
  The suite started as the port of the old `?selfcheck` assertions; **add a test next to the
  module when adding pure logic**.
- Route handlers take a plain `Request`, so API tests import `src/app/api/**/route.ts` and call `GET`/`POST`
  directly (mock `@/lib/server/db` or point at an Azure Postgres test database).
- `tests/e2e/` is reserved for Playwright; nothing is installed yet.
- **Lint** (`.oxlintrc.json`): after making changes, run `npm run lint` and fix all errors.
  The `shadcn/*` rules enforce DESIGN.md (Vercel restraint on earcue tokens): `no-restyle`
  (variants own appearance, `className` for layout plus per-component contracts), `no-raw-colors`
  (theme tokens only), `no-arbitrary-values` (scale only, plus the allowlisted DESIGN.md sizes),
  `no-inline-styles`, `no-unknown-classes`, `require-static-classes`. Approved exceptions live in
  `.oxlintrc.json`; a one-off needs `eslint-disable-next-line shadcn/<rule> -- <reason>` next to the code.
- `/api/health` is the one health surface: `GET`-only, returns `{ ok, release, missingCount, features }`
  (200/503 by whether any required env var is unset) and never queries the database, so an uptime
  poller can hit it every minute. Send `Authorization: Bearer <CRON_SECRET>` to also get `missing` (which
  vars) and `stale` — per-source freshness (extension history/bookmark imports, page capture,
  stuck imports, connector `last_error`), which flips `ok` to false and the status
  to 503. Thresholds are the `HEALTH_STALE_*` knobs; the rules are the pure `staleSources()` in
  `src/lib/shared/freshness.ts`, covered by `tests/unit/shared/freshness.test.ts`. The same authorized
  branch also returns `llm`: today's Azure OpenAI request/token totals from `llm_usage_daily`
  (migration 015), broken out per model — informational only, never a gate on `ok`.
- Server-side, the closest thing to a runtime regression signal is `log.ts` output (`log`/`logError`) — wired
  mainly into background/catch-up failures — plus the browser devtools console, where every client `catch` block logs
  `console.error("<action> failed", err)`.
- Required env vars to boot cleanly (verify with `/api/health`): `DATABASE_URL`, `BETTER_AUTH_SECRET`,
  `BETTER_AUTH_URL`, `CRON_SECRET`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_BASE_URL`. With `BILLING_ENABLED=1`, also
  `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_PRODUCT_ID_PRO`. Everything else (connector OAuth
  creds, model names, tuning knobs) has a coded default in `env.ts`'s `ENV_DEFAULTS` and degrades gracefully
  when absent (e.g. connectors respond `501 connectors_disabled` without `GOOGLE_CLIENT_ID`/`SLACK_CLIENT_ID`).
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
`DESIGN.md` (design-system authority for any UI work), and `.omp/AGENTS.md` (OMP-session addenda,
gitignored/local-only) describe the same system from four angles and drift independently if only one
gets touched. Update whichever one(s) a change affects **in the same commit**, not as a follow-up:
- New migration → add a row to the migrations table above and bump the "next one is `0NN_...`" note.
- New or changed env var → `.env.example` first, then the required-vars list under Testing & QA.
- New API route, dispatcher action, or convention → the Architecture, Key Directories, or Code
  Conventions sections above, whichever it changes.
- New or changed UI (component, token, motion value, layout pattern) → `DESIGN.md` first, then the
  Client UI bullet under Code Conventions if the convention changed.
Stale documentation is a bug here, same as stale code.

After a solved, verified problem, automatically invoke the `ce-compound` skill with `mode:non-interactive` at the completion checkpoint only when the work produced durable project reasoning that is not readily recoverable from the final code, tests, types, comments, or existing documentation, and losing it would plausibly cause recurrence, material risk, or substantial rediscovery. Apply this counterfactual: if the learning document disappeared, would a future engineer reading the final implementation still be likely to repeat the mistake or redo substantial investigation? If not, do not invoke it. Completion, effort, and diff size alone are not enough. Capture at the checkpoint so a qualifying learning can ship in the PR that produced it, and only where the repository treats captured learnings as tracked, committed knowledge.

Write every report, summary, or handoff to the user through the `ce-noslop` skill. This applies when you are the top-level agent writing to the user, not when you are a subagent reporting to its caller. Do not apply it to code, config, verbatim quotes, or text the user asked to post as written.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
