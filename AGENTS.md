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

**Current product focus is ingestion and recommendations.** `CAPTURE_ENABLED = false` in
`src/lib/shared/features.ts` hides every capture surface (All day, Day, Live views, capture settings,
flag toasts, the capture pill). The shipped `/app` is **For you** (`home-view.tsx`), **Sources**
(`sources-view.tsx`) and **Memory** (`memory-view.tsx`). Capture code, endpoints and tests stay intact
and compile; flipping the constant brings the views back beside the core three.

## Architecture & Data Flow

**Recommendations (the shipped path, capture off)**:

```
Sources view → lib/client/knowledge.ts importFile()   (auto-detects .zip/.txt/.html/.json/.md/.csv;
  │   zips via shared/importers/zip.ts; docs split by shared/importers/document.ts into `doc` imports)
  │   → begin / items|browser / finish → distillLoop()
  │ or connect.startOAuth() → /app?connected=google → shell runs Gmail backfill
  ▼
lib/client/recommend.ts refreshRecommendations()   (single-flight; app open ≤ every 3 h, Refresh, after an import)
  ├─ connect.syncConnections() → POST /api/connect/sync   (the only client caller of sync)
  ├─ runCatchup()             → distill / reviews when due
  └─ assist.suggestNow("briefing") → POST /api/assist/suggest → "earcue:recommendstatus" + For you feed
```

Briefing mode (`BRIEFING_PROMPT` in `src/lib/server/assist/suggest.ts`) recommends from the
archive alone: 24 h of calendar ahead, 72 h of inbox, a week of `already` titles and a month of
dismissed ones as `not_useful`. `GET /api/assist/suggestions?day=&days=N` reads a trailing window (the
For you feed asks for 7).

**Client capture → server ingest → knowledge base** (on hold behind `CAPTURE_ENABLED`), roughly:

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
  │    (a flag's "Check" action → POST /api/factcheck, model-only verdict, no web access)
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
  exported `.txt` chat (or the iOS `.zip` around it), parsed client-side by
  `src/lib/shared/importers/whatsapp.ts`. Uploaded documents take the same protocol as `doc` imports
  (not `/api/connect/upload`, which needs connectors configured), so they get provenance and removal.
  `src/lib/server/knowledge.ts` distills imported items into `memories` rows (Azure OpenAI embeddings, pgvector)
  and answers recall queries via hybrid **vector + full-text search fused with Reciprocal Rank Fusion**,
  re-ranked by a Postgres `memory_strength()` decay function. `GET /api/assist/catchup` plans this
  distillation per user, action-triggered rather than scheduled (`distillDue`, and `profileDue` once
  a forget or a correction has cleared `user_profile.built_at`); the client then runs it as an
  ordinary `POST /api/assist/distill`, which rebuilds a stale profile even with nothing new to read. The two cosine cut-offs on that path
  (`MEMORY_DEDUP_SIM`, `RECALL_MIN_SIM`) are fitted to `MODEL_EMBED` — `earcue-embed`'s bands are
  0.72 and 0.15, far below the pre-017 Gemini ones — so a change of embedding model means refitting
  them on labelled pairs, not just re-embedding (migration 017).
- Memory layer shape (migration 020), for mail, chat, calendar and documents as well as browsing:
  - **Provenance**: `memory_sources` links each distilled memory to the `context_items` it came from.
    `removeImport()` and `purgeHost()` (import removal, domain exclusion) delete the memories only
    that data supported, in the same statement. Manual and derived memories have no sources and
    are never pruned.
  - **Forgetting sticks** (migration 022): `POST /api/assist/forget` (`forgetMemory()`) leaves a
    tombstone, `forgotten_reason = 'user'`: text, subject and evidence blanked, sources and edges
    deleted, `kind`, `subject_key` and `embedding` kept. The versions it superseded and derived
    memories resting on it are deleted outright. `upsertMemories()` looks for a tombstone with the
    same `subject_key` (any kind) at `MEMORY_DEDUP_SIM` or above: a distilled (`import`) or
    `derived` memory that matches is dropped with no row and no sources; a `manual` or `chat`
    one deletes the tombstone and is stored, because the person said it. `forgetStaleMemories()`
    marks what it forgets `decay`. Every reader already filters `forgotten_at is null`, and
    tombstones have no sources, so import removal and domain exclusion never touch them. Account
    deletion removes them by cascade; `/privacy` says what they keep.
  - **Correct**: `POST /api/assist/correct {id, text}` (`correctMemory()`) runs the text through
    `MANUAL_PROMPT` as task `correct`, stores a `manual` memory in the old one's container (still
    sensitive if the old one was) and supersedes the old one with an `updates` edge
    (`supersedeMemory()`, shared with the chat). Forget and correct both mark the profile stale
    (`built_at = null`). Gate: entitlement, then the id's owner and the text (3–1000 chars), then
    `assist_calls`.
  - **Standing or once**: the manual schema and the chat's `remember` carry `durability`.
    `applyDurability()` makes a `once` memory an `episode` that expires (`expires_in_days`, 14 by
    default, `ONCE_EXPIRES_DAYS`), so it decays on the existing curve; a `standing` one never
    expires.
  - **Ask earcue**: `POST /api/assist/chat {messages: [{role, text}]}` (`assist/chat.ts`) is a
    `runLoop()` over the five read tools plus three write tools that exist only here: `remember`,
    `forget`, `correct`. The client keeps the conversation and sends its last 12 turns, the last
    one the person's; nothing of it is stored server-side (decision D2). Gate: entitlement, the
    conversation's shape (400), then one `assist_calls` unit per call however many steps it takes
    (D5). Sensitive memories are in scope (`userAsked`). The write guards, each a `ToolRefused`
    code in the run's `tool_calls` and counted as `output.refused`: a write runs only on a turn
    the person typed (`not_user_turn`); `forget` and `correct` take only a memory ref an earlier
    step's tool result returned (`ctx.returned`, a snapshot from before the step, so neither the
    prompt, an item's text nor a call running beside it can supply one: `unseen_ref`); one change
    per memory per turn; at most three `remember`s per turn (`remember_cap`). Remembered and
    corrected memories are origin `chat` (so they lift a tombstone) and carry `memories.run_id`
    (migration 023), as a `correct` run's memory does. The answer is `{reply, changes: [{op,
    memory, replaced?}]}`; the Memory view shows each change as a chip with Undo: `forget` for a
    remember, `POST remember {memory}` (the exact copy, no model call, which lifts the tombstone)
    for a forget, `correct` with the old text for a correction.
  - **Export**: `GET /api/account/export` includes every memory that still has text (live,
    superseded and decayed, flagged as such, with the `run_id` that wrote it), the profile as `memoryProfile`, and the account's
    `agent_runs` rows as stored; row ids are exported so the run log's refs resolve. Tombstones
    are left out.
  - **Sensitivity**: `memories.sensitive` is set by the distiller for health, money, legal and
    intimate facts. `recall()` leaves those memories out unless it gets `includeSensitive`, which
    only the user-initiated `GET /api/assist/recall` passes. `rebuildProfile()` never reads them.
    Proactive surfaces (suggestions, the profile) therefore never show them.
  - **People**: `context_items.participants` holds normalised addresses (email, `slack:<id>`,
    `whatsapp:<name>`) from `participantsOf()` in `src/lib/shared/participants.ts`, with a GIN
    index. `peopleSummary()` turns it into the distiller's `people` list.
  - **Documents**: text-bearing items (`EMBED_KINDS`) get `context_items.embedding`. The distill pass
    embeds up to `EMBED_ITEMS_PER_PASS` per call, newest first, and `npm run reembed` clears a
    backlog. `recall()` fuses vector and full-text results for documents just as it does for memories.
  - **No ANN index** on either vector column. A shared HNSW index filters `user_id` after its
    neighbour scan and loses most of a user's rows, so both vector branches are exact per-user scans.
  - **Gmail** is stored as readable body text through `gmailItem()` in `src/lib/shared/gmail.ts`
    (quoted replies stripped, 4000 chars, promotions/social excluded), with From/To/Cc and a `sent`
    flag so distillation can tell what the person wrote from what they received.
- Auth: better-auth (`src/lib/server/auth-server.ts`, built lazily by `getAuth()`) backs email/password +
  Google OAuth sessions at `/api/auth/[...all]`. `src/lib/server/auth.ts` — a distinct file, easy to confuse
  with `auth-server.ts` — is what every other endpoint imports; it wraps `getSession({ headers })` plus
  ingest bearer tokens, funneled through `requireUser(headers)`, `requireIngestUser(headers)` and the
  dispatcher helper `requireAuthed()`.
  Protected pages (`/app`, `/account`) gate in the server component with `requirePageSession()`.
- Billing: Polar. `users.plan`/`plan_status` are cached columns written only by the Polar webhook
  (`syncEntitlement`, never trusted from client input); `assertEntitled` is a synchronous check against
  that cache — no live Polar call on the request path. With `BILLING_ENABLED=0`, `effectivePlan`
  maps a stored `none` to `free`: entitled, with small caps and zero capture caps (`PLANS.free`).
  Sign-up is public and inference is billed to our Azure account, so those caps, Turnstile and
  `DAILY_TOKEN_CEILING` (set in `wrangler.jsonc` vars) bound the spend. Nothing stores `free`, so
  with billing on a stored `none` is the paywall again. `users.unlimited` lifts the caps entirely.
- Spend: `chat` and `transcribe` take a `userId` and meter into `llm_usage_daily` (per day, per model,
  per user — migration `018`; embeddings meter into the same table as system spend). Pass `userId`
  on every call made for an account, including the distill, profile and consolidation passes a
  user's catch-up triggers; omitting it books the tokens as system spend and hides them from the
  authorized `/api/health` `topUsers`. Both share one retry policy (`postWithRetry` in `llm.ts`):
  429/5xx retry with backoff inside `deadlineMs`, and every answered attempt is metered. All three refuse
  past `DAILY_TOKEN_CEILING` with `SpendCeilingReached` → 503. That ceiling is a deployment-wide backstop
  read once per isolate, not a per-user quota; `consume()` is still what caps one account.
- Run log (`src/lib/server/harness/`, migration `021`): every briefing, live suggestion, distill,
  consolidate, profile, correct and chat call is one `Run` and one `agent_runs` row: task, the prompt's `version`,
  model, duration, model calls (`steps`), tokens, `input_refs`, `output` and an `outcome` of `ok`,
  `empty`, `invalid` (the output check removed everything, or the answer failed the schema),
  `error` or `ceiling`. The row is inserted as `error`/`unfinished` before the model call and
  completed after, so a killed Worker still leaves one. It stores **ids only, never text**: refs
  shown, ids produced, counts, and a coarse error code (`llm_503`, `invalid_output`), never an
  error message, which can quote the model's answer. The distill pass deletes every account's rows
  older than 30 days (`pruneRuns`); account deletion cascades; `suggestions.run_id` and
  `memories.run_id` (023, set by the chat and by corrections) point back.
  - **Refs and the output check**: a task builds its payload through `run.refs`, which replaces
    each row id with a short ref (`i<id>` context item, `m<id>` memory, `t<id>` trace) and records
    the set sent. Whatever the model cites is kept only if this run sent it (`resolve`, `ids`,
    `keepCited` in `harness/check.ts`). A suggestion whose evidence names no sent ref is dropped;
    distill drops bad source and relation refs but keeps the memory; consolidation needs two sent
    memory refs. `suggestions.evidence` is `[{ref, quote}]` since 021 (plain strings before);
    the API still sends the client the quotes.
  - **Prompt versions**: each wired task's instruction is a `Prompt` (`{ version, text }`) beside
    the task (`BRIEFING_PROMPT`, `SUGGEST_PROMPT` in `assist/suggest.ts`; `DISTILL_PROMPT`,
    `DERIVE_PROMPT`, `PROFILE_PROMPT`, `MANUAL_PROMPT` in `knowledge.ts`; `CHAT_PROMPT` in
    `assist/chat.ts`). Bump `version` whenever `text` changes. `MANUAL_PROMPT` is logged for `correct` only; manual remember shares it but
    records no run yet. The unwired `*_INSTRUCTION` constants (rerank, meeting notes and the
    capture routes) get one when they get a run.
  - **Untrusted content**: every email, chat, invite, page and document was written by someone
    else, and some of it addresses the model. `contextMessages()` in `harness/context.ts` builds a
    task's message: the instruction, then earcue's own state as JSON (titles already made or
    dismissed, the profile, the container list), then everything read from the archive (items,
    traces, memories, people, reviews) inside one `<untrusted_XXXX>` block whose tag is random per
    call, so text inside cannot close it. Every
    instruction that reads such a block ends with `UNTRUSTED_RULE` (briefing, live, distill,
    consolidate, profile; the loop, and so the chat, sends it as a system message and wraps each
    tool result the same way). The rule alone did not stop gpt-4.1-mini obeying the eval's injection emails, so
    `redactInjection()` also takes out any bracketed passage or line that addresses the model
    ("note for any AI assistant", "[Assistant instructions: ...]", "ignore previous instructions")
    and leaves `REDACTED` in its place; runs log the count as `output.redacted`. It catches only an
    attack that says who it is talking to. Put any new imported content inside the block.
  - **Context budgets**: `buildContext()` takes sections in priority order, each with a token budget
    (four characters a token); an array loses entries from its end, a string is truncated, and when
    the whole is over its total the lowest-priority section is cut first. A row's ref is recorded as
    sent only if the row survives, so the output check never accepts a row the model was not shown.
    The briefing uses it (`suggestSections` in `assist/suggest.ts`, 12,000 tokens, inbox bodies
    clipped to 1,500 characters) and logs `context_tokens` and any `context_cut` in `output`.
  - **Tools and the loop** (the chat is the one user so far):
    `harness/tools.ts` is the registry. A tool has a name, a description, a `JsonSchema` for its
    arguments (sent as a strict OpenAI function), `writes`, `sensitive` (`never` | `if_user_asked`,
    and sensitive memories come back only when `ctx.userAsked`) and `subrequests`, the most one
    call makes. The five read tools use existing tables only: `recall`, `search_items`, `thread`
    (resolves only an item ref the run has already seen), `calendar`, `person`. Results carry refs
    through `ctx.refs`, which joins them to the run's sent set, so a tool result can be cited like
    the prompt. `runLoop()` in `harness/loop.ts` calls `chatTools()` per step, runs at most three
    calls at once, answers every call id (unknown tool, bad arguments, over budget and a thrown
    handler get an error code; a handler that throws `ToolRefused` gets its own code and note, and
    nothing is logged as a failure), and stops on an answer, at `LOOP_MAX_STEPS` (the last step answers
    with `tool_choice: "none"`), at the deadline, or when its subrequest estimate
    (`LOOP_SUBREQUEST_BUDGET`) would not leave room for the answer. It writes `agent_runs.tool_calls`
    as `{step, name, args, returned: {items, memories}, error?}`: the checked arguments (strings
    clipped to 200 characters, so a query the model wrote is kept) and the ids returned, never
    the result's text. The briefing stays a pipeline (decision H1).
  - **Subrequests** (Workers Free allows 50 per request): a model or embedding call is one fetch plus
    one `llm_usage_daily` write, and every `sql` call opens its own Hyperdrive connection. Whether
    those connections count against the 50 is not documented, so the loop's estimate counts them.
    `tests/unit/server/harness/subrequests.test.ts` measures the tools, a loop run, chat turns and a
    distill pass, and checks each tool against its declared `subrequests`. The chat starts its
    estimate at `CHAT_PRELUDE_SUBREQUESTS` (5: the session, the users row, `consume`, the profile);
    a four-step turn measured 29 counted calls before the session.
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
| `src/components/{app,auth,account,marketing}/` | Feature components. `app/` is the `/app` shell, views (`home-view`, `sources-view`, `memory-view`, plus the capture views) and settings sheet. |
| `src/hooks/` | `use-earcue-event.ts` (subscribe to `earcue:*`), `use-ambient-capture.ts` (All day UI state). |
| `src/lib/shared/` | Pure, isomorphic logic and payload types (`types.ts`), importable from server, client and tests. `features.ts` holds compile-time product switches (`CAPTURE_ENABLED`). |
| `src/lib/server/` | Server-only modules: `env`, `db`, `request-scope`, `bindings` (R2/queue accessors off the request scope), `auth`, `auth-server`, `page-session`, `errors`, `respond`, `llm`, `embed`, `knowledge`, `review`, `entitlement`, `quota`, `plans`, `connectors`, `connect`, `account`, `secretbox`, `log`, `assist/*` (dispatcher actions by area, including `catchup`), and `harness/*` (the model-run layer: `schema` validator, `context` refs, budgets and the untrusted block, `check`, `runs` log writer, `tools` registry and read tools, `loop` runner). |
| `src/lib/client/` | Client-only modules: `api`, `events`, `auth-client`, `localstore`, `capture`, `frame-worker`, `vad-gate`, `pipeline`, `budget`, `catchup`, `meetings`, `assist`, `chat` (the Ask earcue conversation, module-scoped), `connect`, `knowledge`, `recommend`, `day`. |
| `tests/unit/` | Vitest suites mirroring `src/lib`: `shared/`, `server/` (`embed`, `llm-chat`, `llm-transcribe`, `knowledge-distill`, `knowledge-dedup`, `knowledge-pipeline`, `chat`, `migration-020`, `migration-021`, `migration-022`, `migration-023`, `request-scope`, `suggest`, `plans`, `harness/` (`schema`, `check`, `runs`, `context`, `tools`, `loop`, `subrequests`), plus the `_pglite.ts` migrated-Postgres harness and `_context.ts`, which reads a task message back into its trusted and untrusted parts), `client/` (`pipeline`, `chat`) and `api/` (`ingest-audio`, `gate`, plus the `_harness.ts` SQL/auth mocks). `tests/e2e/` is reserved for Playwright. |
| `tests/evals/` | Offline evals of the model's output, run by `npm run eval` only (`vitest.eval.config.ts`): `archive.ts` (the synthetic person and the Gmail/WhatsApp builders), `fixtures.ts` (seven fixtures and their checks), `checks.ts` (rule helpers and the grader), `report.ts`, `pipeline.eval.ts` (the runner), and `results/<date>.json`, one committed file per run. |
| `extension/` | Manifest V3 browser extension (independent of `src/`); syncs history/bookmarks straight to the API via bearer token. |
| `db/migrations/` | Append-only SQL schema history, `NNN_description.sql`, tracked in a `schema_migrations` table. Source of truth for the schema — see table below. |
| `scripts/` | CLI scripts. Plain Node: `migrate.mjs`, `load-env.mjs`, and the `dev:*` helpers `dev-doctor.mjs`, `dev-seed.mjs`, `dev-token.mjs`. Through `tsx --conditions=react-server`: `seed-admin.ts`, `reembed-memories.ts`. |
| `docs/architecture/` | Archify diagram of the capture → ingest → knowledge flow: `earcue.architecture.json` is the source, `earcue-architecture.html` the rendered page. Change both together. |
| `docs/plans/` | Dated plans for past migrations (Next.js port, Cloudflare move, NIM removal). Historical record; not updated after the work lands. |
| `docs/solutions/` | Documented solutions to past problems (bugs, best practices, workflow patterns), organized by category with YAML frontmatter (module, tags, problem_type); check when implementing or debugging in a documented area. |
| `infra/task-consumer/` | Cloudflare Worker (`earcue-task-consumer`) consuming `earcue-ingest` → `/api/ingest/audio/process` with `Bearer CRON_SECRET`. Per-message `ack()`/`retry()`, with a DLQ. Holds no business logic — it is a transport. |

**Current migrations** (next one is `024_description.sql`; the harness plan's `023_item_signals` becomes `024`, and its later numbers shift by one):

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
| 020 | `020_personal_memory.sql` | `memory_sources` provenance, `memories.sensitive`, `context_items.participants` (+ backfill, GIN) and `context_items.embedding`; drops 008's shared HNSW index on `memories` |
| 021 | `021_agent_runs.sql` | `agent_runs` run log (ids only, 30-day retention, cascades with the account) and `suggestions.run_id` |
| 022 | `022_memory_tombstones.sql` | `memories.forgotten_reason` (`decay` \| `user`, backfilled `decay`, paired with `forgotten_at`) and the `memories_tombstones` index for forget tombstones |
| 023 | `023_memory_run_id.sql` | `memories.run_id` → `agent_runs` (set null when the run is pruned): the chat or correction run that wrote a memory |

## Development Commands

```bash
npm install
npm run dev:doctor                          # names-only env + migration check, never prints values; `AZURE_OPENAI_API_KEY`/`AZURE_OPENAI_BASE_URL` missing = the only required gap in Development
npm run dev:seed <email> [password]         # thin wrapper over seed:admin (no duplicated auth logic); comped to plan=pro/unlimited
npm run dev:up                              # doctor, then next dev on :3000 (pages + API routes on one origin)
npm run dev:token [email] [label]           # mint an extension ingest token without logging in
npm run dev                                # next dev on :3000 (pages + API routes on one origin)
npm run typecheck                          # tsc --noEmit (strict)
npm run lint                               # oxlint, default rule set (no .oxlintrc.json yet)
npm test                                   # vitest run
npm run eval                               # offline evals against the real Azure deployment (costs money; never in npm test or CI)
npm run build                              # next build (also type-checks)
npm run preview                            # opennextjs-cloudflare build + preview on http://localhost:8787 (workerd runtime)
npm run deploy                              # opennextjs-cloudflare build + deploy to Cloudflare Workers
npm run cf-typegen                          # regenerate cloudflare-env.d.ts from wrangler.jsonc bindings
npm run migrate                            # apply pending db/migrations/*.sql (tracked in schema_migrations)
npm run migrate:baseline                   # mark all migrations applied without running them (adopt an existing DB)
npm run seed:admin <email> [password]      # create/reset the owner's admin login, comped to plan=pro
npm run reembed                            # regenerate memories.embedding after an embedding-model change, then backfill context_items.embedding
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
  `account/[action]` keys by action only and each action returns 405 on a wrong method. Add a
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
  — no ORM, no query builder, no string-concatenated SQL, no interpolated identifiers (`quota.ts`
  shows how to pick a column by value instead). In production every `sql` call opens its own `pg`
  `Client` over the Cloudflare Hyperdrive binding and closes it after that one query; holding one
  client for a whole request hung under concurrent load, and Hyperdrive pools the connections
  underneath. `withTransaction()` is the only thing that pins one client across queries. The binding
  comes from OpenNext's shared `globalThis[Symbol.for("__cloudflare-context__")]`, read in
  `request-scope.ts`, not from a private `AsyncLocalStorage` (see
  `docs/solutions/integration-issues/worker-request-scope-duplicated-across-bundles.md`). Inside
  workerd a missing `HYPERDRIVE` throws rather than falling back to `DATABASE_URL`. Outside the Worker
  (`next dev`, `tsx scripts/*.ts`, vitest) it is one process-wide `pg.Pool` against `DATABASE_URL`.
  Batch independent reads with `Promise.all`, as `recall`, `handleSuggest` and `runDistillPass` do,
  but keep a batch to six queries or fewer: a Worker invocation holds at most six open connections
  and queues the rest.
  Bulk inserts use `insert into ... select * from unnest($1::type[], ...)`. `auth-server.ts` opens its
  own `pg` pool the same way, because better-auth's adapter needs a real pool — two independent Postgres
  access paths exist by design, don't unify them. Neither may connect at import time: `next build` loads
  route modules.
- **LLM JSON**: `chatJson<T>()` sends the schema as Azure structured output (`response_format:
  json_schema`, `strict: true`, via `strictSchema()`; verified on `earcue-reason`, gpt-4.1-mini
  2025-04-14) and keeps the prompt-side example as the fallback (`LLM_JSON_SCHEMA=0` sends only
  the example). The answer is then checked by `conform()` in `harness/schema.ts`, which covers the
  subset the schemas use (`type`, `properties`, `required`, `enum`, `items`): array items that fail
  are dropped, never repaired; a null optional property counts as absent; a top-level failure,
  after one nudge, is `InvalidOutput`. Pass `meter: run.meter` so the run counts calls, tokens
  and drops.
- **LLM tools**: `chatTools()` is `chat()` with `tools` in the body (`parallel_tool_calls`,
  `tool_choice` `auto` or `none`) and the answer read as text or `tool_calls`, over the same
  `postWithRetry`, metering and ceiling. Native tool calling with strict function schemas was
  verified on `earcue-reason` (gpt-4.1-mini 2025-04-14), so there is no JSON `{tool, args}`
  fallback. Call it through `runLoop()`, which checks arguments with `conform()`.
- **Logging**: `log(event, fields)` / `logError(event, err, fields)` from `log.ts` emit one JSON line per
  call with snake_case `event` names — used sparingly, mainly for background and catch-up failures.

**Client (`src/lib/client`, `src/components`, `src/hooks`)**
- **No global store.** Capture, pipeline and budget state are module-scoped in `src/lib/client` so capture
  keeps running while React views change; `startAmbient`/`startBudgetLoop` are idempotent (React
  StrictMode runs effects twice in dev). Cross-module signaling uses the typed `earcue:*` events in
  `events.ts` (`earcue:signedout`, `paymentrequired`, `quotaexceeded`, `budget`, `chunk`, `synced`,
  `pending`, `queued`, `flag`, `suggestion`, `suggestionsupdated`, `recommendstatus`, `reviewed`,
  `screenended`, `chat`);
  components subscribe with `useEarcueEvent`.
- `src/lib/client` modules do no DOM lookups; they return data or emit events and components render.
- The `/app` shell keeps every view mounted and toggles `hidden`. The knowledge and connection hooks
  (`useKnowledgeSettings`, `useConnectionSettings`) are called once in the shell and passed to the views
  and the settings sheet, so in-progress state (imports, OAuth return, minted token) survives view
  switches and the (unmounting) sheet content. Don't `forceMount` Radix dialogs/sheets: their scroll lock
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
| `src/lib/server/harness/runs.ts` | `Run` (refs, meter, `track()` writing the `agent_runs` row whatever the outcome), `Prompt`, `errorCode`, `pruneRuns` |
| `src/lib/server/harness/context.ts`, `check.ts`, `schema.ts` | Short refs and the sent set, `buildContext()` budgets, `contextMessage()`/`untrusted()` and `UNTRUSTED_RULE`; the evidence check; the `chatJson` schema validator and strict-schema conversion |
| `src/lib/server/harness/tools.ts`, `loop.ts` | The tool registry and the five read tools (`recall`, `search_items`, `thread`, `calendar`, `person`); `runLoop()`, the model-driven loop with its step, deadline and subrequest stops |
| `src/lib/server/llm.ts` | Azure OpenAI `chat`/`chatJson`/`chatTools`/`transcribe` calls over one shared `postWithRetry` (retry/deadline/metering), JSON-mode handling, per-user metering and the `DAILY_TOKEN_CEILING` backstop; `transcribeUrl()` is the one caller that leaves the `v1` base URL |
| `src/lib/server/embed.ts` | Azure OpenAI `/embeddings` call + pgvector literal helpers |
| `src/lib/server/entitlement.ts`, `quota.ts`, `plans.ts` | Polar plan cache check, per-metric daily caps, plan definitions |
| `src/app/api/traces/route.ts` | Timeline read/write API — not a debug/tracing tool (see Architecture) |
| `next.config.ts` | Redirects from the old `*.html` URLs |
| `worker.ts` | Worker entry: re-exports the OpenNext build output (`.open-next/worker.js`) and adds nothing |
| `wrangler.jsonc` | Cloudflare Worker config — the `earcue.lol/*` zone route, the R2 bucket and ingest queue producer, vars, and the OpenNext build entrypoint. The Hyperdrive binding carries a placeholder `localConnectionString` because `opennextjs-cloudflare deploy` refuses to run without one; `npm run preview` overrides it with `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`. No `limits.cpu_ms`: the account is on Workers Free, which rejects the field (API 100328) and caps CPU at 10 ms per request |
| `.env.example` | Canonical list of every env var, required and optional-with-default |
| `DESIGN.md` | Design-system authority (tokens, type, layout, components, motion) — read before any UI work |

## Runtime/Tooling Preferences

- Node **22.x** (`package.json` `engines`) — the local dev/CI pin; Workers run under `nodejs_compat`, not Node itself.
- TypeScript `strict`, native ESM (`"type": "module"`), `@/*` → `src/*`. Next.js 16 with Turbopack.
- No ESLint config yet (`next lint` no longer exists in Next.js 16); don't add lint/format tooling without a
  request.
- `npm` is the package manager (`package-lock.json` is committed).
- `.env.local` is hand-authored from `.env.example`.

## Testing & QA

- **Vitest** (`vitest.config.ts`): tests live in `tests/unit/**`, mirroring `src/lib`. Node environment by
  default; a file that needs the DOM opts in with `// @vitest-environment jsdom` (see
  `tests/unit/shared/bookmarks.test.ts`). `server-only` and `client-only` are aliased so tests can import
  either layer.
  The suite started as the port of the old `?selfcheck` assertions; **add a test next to the
  module when adding pure logic**.
- Route handlers take a plain `Request`, so API tests import `src/app/api/**/route.ts` and call `GET`/`POST`
  directly (mock `@/lib/server/db` or point at an Azure Postgres test database).
- When a test needs to prove SQL actually runs, mock `@/lib/server/db` with `sql` from
  `tests/unit/server/_pglite.ts`. That is an in-process Postgres (PGlite, with pgvector and pgcrypto)
  migrated from `db/migrations`. `migratedDb({ before })` plus `applyMigrations(db, { from })` let
  a test seed old-shape rows and then run one migration's backfill over them
  (`migration-020.test.ts`). `knowledge-pipeline.test.ts` covers ingest → embed → distill → recall
  → delete this way, with only Azure faked.
- **Evals** (`tests/evals/`, `npm run eval`, config `vitest.eval.config.ts`) measure the model's
  output, not the code around it. They call the real Azure deployment (`AZURE_OPENAI_API_KEY` and
  `AZURE_OPENAI_BASE_URL` from the shell or `.env.local`), so `npm test` and CI never include them.
  Each fixture is the same synthetic person (`.example` addresses, no real data) plus the few items
  that set up one expectation: an owed reply, a three-week-old WhatsApp promise, a newsletter-heavy
  inbox, sensitive facts, titles in `already`/`not_useful`, and two prompt-injection emails. It is
  imported into `_pglite.ts` through the real path (the Gmail backfill against a fake Gmail API,
  WhatsApp exports through `begin`/`items`/`finish`), then the real `distill` and `suggest`
  (briefing) handlers run. The `chat` fixture runs no briefing: after distill it sends three Ask
  earcue conversations through the real `chat` handler (a standing preference, a one-off fact,
  and a question whose answer is an email asking for a memory to be deleted). Only the database, session and quota are stand-ins. Checks are rules
  first (refs valid, expected ref cited, forbidden ref or words absent); the grader
  (`GRADER_PROMPT`, `MODEL_REASON`, temperature 0) is asked only what a rule cannot decide, such as
  a paraphrase, or a warning that names the attacker. A run prints a table per fixture and check,
  with the previous results file beside it, and writes `tests/evals/results/<date>.json` with each
  task's `prompt_version`, every repeat's suggestions and memories, and the calls and tokens used.
  The first file is the baseline. A PR that changes a prompt or the pipeline runs `npm run eval`,
  commits its results file and reports the numbers against the baseline. Knobs: `EVAL_REPEATS`
  (3), `EVAL_CONCURRENCY` (2), `EVAL_MAX_CALLS` (400, no new repeat starts past it) and
  `EVAL_FIXTURES` (comma-separated names). One full run is about 200 model calls.
- `tests/e2e/` is reserved for Playwright; nothing is installed yet.
- **Lint**: after making changes, run `npm run lint` and fix all errors and warnings. It is plain
  `oxlint` with its default rules; there is no `.oxlintrc.json`. `@shadcn/lint` is installed but not
  wired: turning on its six design-system rules (`no-restyle`, `no-raw-colors`,
  `no-arbitrary-values`, `no-inline-styles`, `no-unknown-classes`, `require-static-classes`)
  flags ~180 existing violations, most of them the DESIGN.md-sanctioned arbitrary sizes. Adopting it
  means an allowlist that encodes those sizes first. Until then DESIGN.md is enforced by review, not
  by the linter.
- **CI/CD** (`.github/workflows/ci.yml`) runs on pull requests and pushes to `main` (not on other
  branch pushes, which the PR run already covers); a newer commit on a PR cancels the older run.
  The `check` job runs `lint`, `typecheck`, `test` and `build`, cheapest first, with `.next/cache`
  cached between runs. On `main`, a `deploy` job then runs `npm run migrate` against production Postgres,
  `npm run deploy`, deploys `infra/task-consumer`, and polls `https://earcue.lol/api/health` until it
  reports `ok` with `release` equal to the pushed SHA. `deploy` is skipped until the repository
  variable `CLOUDFLARE_ACCOUNT_ID` exists; it also needs the secrets `CLOUDFLARE_API_TOKEN` and
  `DATABASE_URL`. The production Postgres firewall admits only Cloudflare's IP ranges and the operator
  VM, so the migrate step also needs the runner's IP opened first. Worker runtime secrets stay in Cloudflare (`wrangler secret bulk`), preserved by
  `--keep-vars`.
- `/api/health` is the one health surface: `GET`-only, returns `{ ok, release, missingCount, features }`
  (200/503 by whether any required env var is unset) and never queries the database, so an uptime
  poller can hit it every minute. Send `Authorization: Bearer <CRON_SECRET>` to also get `missing` (which
  vars) and `stale` — per-source freshness (extension history/bookmark imports, page capture,
  stuck imports, connector `last_error`), which flips `ok` to false and the status
  to 503. Thresholds are the `HEALTH_STALE_*` knobs; the rules are the pure `staleSources()` in
  `src/lib/shared/freshness.ts`, covered by `tests/unit/shared/freshness.test.ts`. The same authorized
  branch also returns `llm`: today's Azure OpenAI request/token totals from `llm_usage_daily`
  (migration 015), broken out per model plus the five accounts that spent the most (`topUsers`) —
  informational only, never a gate on `ok` — and `runs`: today's `agent_runs` count per task and
  outcome (`{ briefing: { ok: 3, invalid: 1 }, ... }`, migration 021), equally informational.
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

**Services.** Infrastructure is GitHub (code, issues, PRs, Actions), Azure (OpenAI inference, and
the production Postgres: `earcue-pg`, Azure Database for PostgreSQL) and Cloudflare (Workers, R2,
Queues, and the Hyperdrive binding in front of that Postgres). Neon and Vercel are retired; the
`.wayfinder/` research that mentions them predates the move.
Work is tracked in GitHub issues and PRs; when a PR resolves an issue, say so with `Fixes #N` in its
description.

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
