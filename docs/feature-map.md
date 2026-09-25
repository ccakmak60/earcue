# earcue feature map

This file lists every user-facing and operational feature and traces each one through the stack: the
UI surface, the client module, the API route, the server module, the tables it touches, the quota it
charges and the tests that cover it. [`AGENTS.md`](../AGENTS.md) explains how the system works.
Use this map to find where a feature lives and what a change to it will touch.

For the data flow as a diagram, see [`architecture/earcue-architecture.html`](architecture/earcue-architecture.html).

**Status**

- **Shipped**: visible in `/app` today.
- **On hold**: code, endpoints and tests are intact, but `CAPTURE_ENABLED = false` in
  [`src/lib/shared/features.ts`](../src/lib/shared/features.ts) hides the UI.
- **Optional**: works only when its env vars are set. Otherwise it degrades, for example to
  `501 connectors_disabled`.
- **Internal**: called by the platform or an operator, not by the app.
- **Planned**: designed but not built. The linked plan holds the design.

## At a glance

| Area | Feature | Status | Where you see it |
|---|---|---|---|
| Recommendations | Briefing feed (candidates, rank, write), refresh, feedback | Shipped | **For you** view |
| Recommendations | Open loops (replies owed, commitments, waiting on, reconnect, stale projects) | Shipped | Listed by the dashboard's loop panels; feeds the briefing |
| Recommendations | Dashboard built for each person (panels chosen by `decide()`, pin and hide) | Shipped | **Dashboard** view |
| Sources | File imports (WhatsApp, LinkedIn, bookmarks, Takeout history, documents) | Shipped | **Sources** view |
| Sources | WhatsApp "which one is you" | Shipped | **Sources** → WhatsApp card |
| Sources | Gmail + Calendar backfill | Optional (Google OAuth) | **Sources** → Gmail & Calendar |
| Sources | Slack backfill | Optional (Slack OAuth) | **Sources** → Slack |
| Sources | Connected services (hosted MCP servers from integrations.sh, called live by Ask earcue) | Optional (`CONNECTOR_ENC_KEY`) | **Sources** → Connect a service; chips under Ask earcue replies |
| Sources | Browser extension (history, bookmarks, page text) | Shipped (loaded unpacked until it has a store listing) | **Sources** → This browser → Connect this browser |
| Sources | Import removal, domain exclusions | Shipped | **Sources** list, Settings |
| Memory | Item signals (annotation) | Shipped | Not shown directly; gates distill, feeds loops and the briefing |
| Memory | Distillation into memories | Shipped | Runs after imports and on catch-up |
| Memory | Recall search, manual remember, spaces | Shipped | **Memory** view |
| Memory | Forget that sticks, correct, "What earcue knows about you" | Shipped | **Memory** view |
| Memory | Ask earcue (chat that learns, change chips with Undo) | Shipped | **Memory** view |
| Memory | People and entities, manual merge | Shipped | **Memory** view → People |
| Memory | Consolidation, decay | Shipped | Not shown directly; feeds prompts |
| Catch-up | Client-driven background work | Shipped | Runs when the app opens and after imports |
| Capture | Mic and screen capture, budget pacer | On hold | **All day** view, capture pill |
| Capture | Audio transcription (inline or queued) | On hold | none |
| Capture | Screen frame captions | On hold | none |
| Capture | Transcript timeline, search, heatmap | On hold | **Day** view |
| Capture | Day review | On hold | **Day** view |
| Capture | Meetings, live suggestions, flags, fact-check | On hold | **Live** view, toasts |
| Accounts | Email/password + Google sign-in, Turnstile | Shipped (Google, Turnstile optional) | `/signin` |
| Accounts | Plans, quotas, Polar checkout/portal | Shipped (billing optional) | Upgrade card, `/account` |
| Accounts | Data export, account deletion, usage | Shipped | `/account` |
| Platform | Health, spend metering, daily token ceiling | Internal | `/api/health` |
| Platform | Audio task consumer Worker | Internal | `infra/task-consumer/` |
| Platform | Migrations, seeding, re-embedding scripts | Internal | `scripts/` |
| Platform | Harness: run log, prompt versions, output checks, tool registry, loop runner | Internal | `/api/health` `runs`, `agent_runs` |
| Platform | Offline evals | Internal | `npm run eval` |
| Platform | `halfvec` storage tuning | Planned ([plan](plans/2026-09-23-feat-harness-plan.md) step 10) | none |

## Recommendations (For you)

The shipped product. It recommends what to do next using only the archive, with no live capture.

| Layer | Where |
|---|---|
| UI | [`home-view.tsx`](../src/components/app/home-view.tsx): feed, Refresh, "Not useful" / accept on each card |
| Client | [`recommend.ts`](../src/lib/client/recommend.ts) `refreshRecommendations()` (single-flight, auto at most every 3 h) → [`connect.ts`](../src/lib/client/connect.ts) `syncConnections()` → [`catchup.ts`](../src/lib/client/catchup.ts) `runCatchup()` → [`assist.ts`](../src/lib/client/assist.ts) `suggestNow("briefing")` |
| API | `POST /api/assist/suggest`, `GET /api/assist/suggestions?day=&days=7`, `POST /api/assist/feedback` |
| Server | [`assist/suggest.ts`](../src/lib/server/assist/suggest.ts) → [`assist/briefing.ts`](../src/lib/server/assist/briefing.ts) `runBriefing()`, [`open-loops.ts`](../src/lib/server/open-loops.ts), [`decide.ts`](../src/lib/server/decide.ts), [`harness/loop.ts`](../src/lib/server/harness/loop.ts) |
| Tables | `suggestions` (`loop_id`, `run_id`), `open_loops`, `agent_runs`; reads `context_items` (signals), `entities`, `memories`, `user_profile` |
| Quota | `assist_calls` |
| Events | `earcue:recommendstatus`, `earcue:suggestionsupdated` |
| Tests | `server/suggest.test.ts`, `server/open-loops.test.ts`, `server/migration-027.test.ts`; evals in `tests/evals/pipeline.eval.ts` |

Triggers: the app opening (when sources exist and a refresh is due), the Refresh button, a finished
import, and the return from OAuth (`/app?connected=google`).

A briefing takes three steps:

1. **Candidates, by SQL.** Open loops, the next 24 h of calendar events, and the last 72 h of
   messages that annotation marked `key`.
2. **Rank, by `decide()`.** Uses `MODEL_ANNOTATE`, with a week of `already` titles and a month of
   dismissed ones as state. Then `dropRepeats()` removes any pick that repeats one of those titles.
3. **Write, by `MODEL_REASON`.** Only the top three are written, through the tool loop, as strict
   JSON.

Raw items on this path must be annotated and must not be marked sensitive. AGENTS.md
(**Sensitivity**) has the full rule.

Feedback on a suggestion that came from an open loop closes that loop: accepting it marks the loop
`done`, and "Not useful" marks it `dismissed`. `GET /api/assist/catchup` runs
`refresh_open_loops()` (SQL, no model call), which detects new loops and resolves or expires old
ones.

## Dashboard

A page of panels that earcue picks for each person
([plan](plans/2026-09-25-feat-generative-dashboard-plan.md)). The model scores candidate panels and
never writes UI.

| Layer | Where |
|---|---|
| UI | [`dashboard-view.tsx`](../src/components/app/dashboard-view.tsx): the panels, a menu on each (Pin to the top / Unpin, Hide), "Show N hidden panels again", Refresh |
| Client | [`dashboard.ts`](../src/lib/client/dashboard.ts) `loadDashboard()`, `buildDashboard()` (run by [`recommend.ts`](../src/lib/client/recommend.ts) after the briefing), `setPanel()` |
| API | `GET /api/assist/dashboard`, `POST /api/assist/dashboard-build`, `POST /api/assist/dashboard-panel {key, action}` |
| Server | [`assist/dashboard.ts`](../src/lib/server/assist/dashboard.ts) (candidates, fingerprint, `decide()`, panel reads), [`shared/dashboard.ts`](../src/lib/shared/dashboard.ts) (catalog, `pickPanels()`, `applyPanelAction()`) |
| Tables | `dashboards`, `agent_runs` (task `dashboard`); reads `open_loops`, `entities`, `item_entities`, `context_items`, `memories`, `suggestions`, `user_profile` |
| Quota | `assist_calls`, only for a build that asks the model |
| Events | `earcue:dashboardupdated`, `earcue:recommendstatus` |
| Tests | `server/dashboard.test.ts`, `shared/dashboard.test.ts`, the dashboard block in `server/harness/subrequests.test.ts`; eval `tests/evals/dashboard.eval.ts` (`EVAL_DASHBOARD=1`) |

Panels: recommendations, replies you owe, coming up this week, promises you made, waiting on
others, a card per busy person, organisation or active project, projects and ideas, gone quiet,
mail and chat statistics, most talked about. A panel is offered only when it has data behind it. A
build asks the model again only when the candidates' banded counts change or the page is a day old.
Panels follow the proactive rule, as For you does.

## Sources

All imports share one chunked-upload protocol on the assist dispatcher:
`begin` → `items` | `browser` (300 rows per chunk) → `finish`. File imports, Gmail backfill and the
extension all use it, so every source gets an `imports` row with provenance and can be removed.

### File imports

| Source | Accepted files | Parser |
|---|---|---|
| WhatsApp chat | `.txt`, or the iOS `.zip` around it | [`importers/whatsapp.ts`](../src/lib/shared/importers/whatsapp.ts) |
| LinkedIn data | the "Download your data" `.zip` | [`importers/linkedin.ts`](../src/lib/shared/importers/linkedin.ts) (conversations as `chat`, profile, applications, posts and connections as `doc`) |
| Bookmarks | `.html` / `.htm` (browser export) | [`importers/bookmarks.ts`](../src/lib/shared/importers/bookmarks.ts) |
| Google Takeout history | `.zip` / `.json` | [`importers/history.ts`](../src/lib/shared/importers/history.ts) |
| Notes and documents | `.txt`, `.md`, `.csv` | [`importers/document.ts`](../src/lib/shared/importers/document.ts) (split into `doc` items) |
| Any zip | `.zip` | [`importers/zip.ts`](../src/lib/shared/importers/zip.ts) unpacks, then detects the type |

| Layer | Where |
|---|---|
| UI | [`sources-view.tsx`](../src/components/app/sources-view.tsx), [`settings-knowledge.tsx`](../src/components/app/settings-knowledge.tsx) |
| Client | [`knowledge.ts`](../src/lib/client/knowledge.ts) `importFile()` → `learnLoop()` (`annotateLoop()`, then `distillLoop()`) |
| API | `POST /api/assist/begin`, `/items`, `/browser`, `/finish`; `GET /api/assist/imports`; `POST /api/assist/whatsapp-self` |
| Server | [`assist/imports.ts`](../src/lib/server/assist/imports.ts), [`knowledge.ts`](../src/lib/server/knowledge.ts) `normalizeItems` (sets `thread_key`), `normalizeBrowserRows`, `insertContextItems`; [`entities.ts`](../src/lib/server/entities.ts) links participants at insert |
| Tables | `imports`, `context_items` (with `participants` from [`participants.ts`](../src/lib/shared/participants.ts), and `thread_key`), `entities`, `entity_aliases`, `item_entities` |
| Quota | `import_items` (per item) |
| Tests | `shared/importers.test.ts`, `shared/linkedin.test.ts`, `server/linkedin-import.test.ts`, `shared/bookmarks.test.ts`, `shared/zip-document.test.ts`, `shared/participants.test.ts`, `server/knowledge-pipeline.test.ts`, `server/entities.test.ts` |

The WhatsApp card asks "Which one is you in these chats?" and offers the speakers who appear in every
exported chat. The answer makes that name the person's own entity, so earcue can tell what they
wrote from what they were sent. A LinkedIn archive needs no question: when the import finishes, the
server finds its owner, the one profile on every conversation (with at least two conversations), and
that profile joins the person's own entity (`linkLinkedinSelf()` in `entities.ts`). No name is ever
used for this; an archive where it is not clear leaves the profile for the manual merge.

### Connectors: Gmail, Calendar, Slack (Optional)

| Layer | Where |
|---|---|
| UI | Sources → "Gmail & Calendar", "Slack" cards; [`settings-connections.tsx`](../src/components/app/settings-connections.tsx) |
| Client | [`connect.ts`](../src/lib/client/connect.ts) `startOAuth`, `syncConnections`, `disconnect`; [`knowledge.ts`](../src/lib/client/knowledge.ts) `backfill("gmail")` |
| API | `/api/connect/list`, `start`, `callback`, `sync`, `upload`, `disconnect`; `POST /api/assist/gmail-backfill` |
| Server | [`connect.ts`](../src/lib/server/connect.ts), [`connectors.ts`](../src/lib/server/connectors.ts) (OAuth, token refresh, fetchers), [`secretbox.ts`](../src/lib/server/secretbox.ts) (AES-256-GCM tokens), [`shared/gmail.ts`](../src/lib/shared/gmail.ts) `gmailItem()` |
| Tables | `connections`, `context_items`, `imports` |
| Quota | `connector_syncs` (sync, upload), `import_items` (Gmail backfill) |
| Config | `GOOGLE_CLIENT_ID`/`SECRET`, `SLACK_CLIENT_ID`/`SECRET`, `CONNECTOR_ENC_KEY` |
| Tests | `shared/gmail.test.ts` |

Google scopes are read-only Gmail and Calendar. Sync pulls recent calendar events and Slack
conversation history into `context_items`. `/api/connect/upload` needs connectors configured, so
documents go through the import protocol instead.

Gmail backfill and sync skip the Promotions and Social categories (`GMAIL_QUERY_FILTER`), except
Social mail from LinkedIn and Fiverr (`GMAIL_SOCIAL_SOURCES`): their notification mail is how their
messages, applications and orders reach earcue, since neither offers an API a person can connect.
Sync reads the oldest 15 messages since its cursor, so a burst of that mail delays the rest to the
next sync rather than skipping it (`server/connector-sync.test.ts`).

### Connected services: hosted MCP servers (Optional)

| Layer | Where |
|---|---|
| UI | Sources → "Connect a service" ([`services-section.tsx`](../src/components/app/services-section.tsx)): connected list with "Let earcue take actions", Refresh tools, Reconnect, Disconnect; directory search; key form; connect by URL. Action chips under Ask earcue replies ([`ask-earcue.tsx`](../src/components/app/ask-earcue.tsx)); `?service_connected=`/`?service_error=` toasts in [`app-shell.tsx`](../src/components/app/app-shell.tsx) |
| Client | [`services.ts`](../src/lib/client/services.ts) (`listServices`, `connectService`, `refreshService`, `setAllowActions`, `disconnectService`, `loadCatalog`); state in `useConnectionSettings` ([`settings-connections.tsx`](../src/components/app/settings-connections.tsx)); [`chat.ts`](../src/lib/client/chat.ts) `actions` |
| API | `/api/connect/services`, `service-connect`, `service-callback`, `service-refresh`, `service-update`, `service-disconnect`, `service-client` (OAuth client metadata document); `POST /api/assist/chat` (`use_service`) |
| Server | [`services.ts`](../src/lib/server/services.ts) (actions, `openService`, `use_service`, `SERVICES_PROMPT`, action check), [`mcp.ts`](../src/lib/server/mcp.ts) (Streamable HTTP client), [`mcp-auth.ts`](../src/lib/server/mcp-auth.ts) (MCP authorization), [`shared/mcp.ts`](../src/lib/shared/mcp.ts) (URL check, SSE parsing, read/action classification, listing, catalog search) |
| Tables | `service_connections` (migration 029); `agent_runs.output.service_calls` |
| Quota | `connector_syncs` (connect, refresh); `assist_calls` (the chat turn that calls a service) |
| Config | `CONNECTOR_ENC_KEY`; `BETTER_AUTH_URL` on https for client metadata documents; the directory is `public/mcp-catalog.json` (`npm run mcp-catalog`) |
| Tests | `shared/mcp.test.ts`, `server/services.test.ts`, `server/harness/subrequests.test.ts` ("a connected service"); eval `action-check.eval.ts` (`EVAL_ACTION=1`) |

Nothing a service returns is stored; Ask earcue reads it for one reply. Action tools stay off per
service until the person turns them on, and then each needs the person's own words to ask for it
(`actionAsked()`). SSE-only (`…/sse`) servers are not supported and are left out of the directory.

### Browser extension

| Layer | Where |
|---|---|
| UI | **Sources** → This browser (`BrowserTile` in [`sources-view.tsx`](../src/components/app/sources-view.tsx)): Add the extension (`EXTENSION_STORE_URL`, from `/api/health` `features.extensionUrl`; unset shows the load-unpacked steps), Connect this browser, Sync now, Disconnect |
| Client | [`lib/client/extension.ts`](../src/lib/client/extension.ts): window messages to the extension's `bridge.js` (`status`, `pair`, `sync`, `unpair`) |
| Code | [`extension/`](../extension): `background.js` (hourly alarm sync, one reused import per source, pairing), `bridge.js` (content script on earcue's own origins), `page-capture.js`, `popup.*`, `options.*` (manual base URL and token). It imports nothing from `src/`. |
| Auth | Bearer ingest token, label `browser`, minted by the Sources view and handed to the extension (`POST /api/assist/token`, which also returns `account`); `token-revoke` revokes the calling bearer (the extension unpairing) or, with the session, every token of a label. Table `ingest_tokens` |
| API | `begin`, `browser`, `finish`, `page`, `excludes`, `token-revoke` on `/api/assist/*`. These six answer CORS preflight. |
| Server | [`assist/imports.ts`](../src/lib/server/assist/imports.ts) `handlePage` (read-page text, gated by `users.capture_pages`), [`shared/pagetext.ts`](../src/lib/shared/pagetext.ts) |
| Quota | `import_items` |
| Freshness | `/api/health` `stale` flags silent extension history, bookmark and page-capture sources ([`freshness.ts`](../src/lib/shared/freshness.ts)) |
| Tests | `client/extension.test.ts` (the page side of the bridge), `server/ingest-tokens.test.ts` (mint, bearer and label revoke), `shared/history-paging.test.ts` (the extension keeps copies of these helpers), `shared/pagetext.test.ts`, `shared/freshness.test.ts` |

### Removal and exclusions

| Feature | API | Server | Effect |
|---|---|---|---|
| Remove an import | `POST /api/assist/remove` | `removeImport()` | Deletes its items, plus the memories only those items supported (via `memory_sources`) |
| Exclude a domain | `GET`/`POST /api/assist/excludes` | `purgeHost()` | Deletes that host's items and the memories only they supported; also saves the `capturePages` toggle |

## Memory and knowledge

| Feature | UI | API | Server | Quota |
|---|---|---|---|---|
| Item signals | none | `POST /api/assist/annotate` | [`annotate.ts`](../src/lib/server/annotate.ts) `annotatePendingItems()` → [`decide.ts`](../src/lib/server/decide.ts) | `annotations` |
| Distillation | Status line after imports | `POST /api/assist/distill` | `runDistillPass()` | `distills` |
| Recall search | Memory search box (optional rerank) | `GET /api/assist/recall?q=&container=&rerank=1` | `recall()`: vector + full-text fused with RRF, then `memory_strength()` | `recalls` |
| Manual memory | Memory → remember | `POST /api/assist/remember` | `addManualMemory()` | `assist_calls` |
| Browse / forget | Memory list, "Forget this" | `GET /api/assist/memories`, `POST /api/assist/forget` | [`assist/memory.ts`](../src/lib/server/assist/memory.ts) `forgetMemory()` (tombstone) | none |
| Correct | Memory row → edit | `POST /api/assist/correct {id, text}` | `correctMemory()`, `supersedeMemory()` | `assist_calls` |
| Ask earcue | [`ask-earcue.tsx`](../src/components/app/ask-earcue.tsx): the conversation, change chips with Undo | `POST /api/assist/chat {messages}` | [`assist/chat.ts`](../src/lib/server/assist/chat.ts) → `runLoop()` over the read tools plus `remember`, `forget`, `correct` | `assist_calls` (one per call) |
| People | [`people-section.tsx`](../src/components/app/people-section.tsx) | `GET /api/assist/people`, `GET /api/assist/person?id=`, `POST /api/assist/entity-merge {from, into}` | [`assist/people.ts`](../src/lib/server/assist/people.ts), [`entities.ts`](../src/lib/server/entities.ts) | none |
| Spaces | Space filter | `GET /api/assist/containers` | `containersFor()` | none |
| Profile | "What earcue knows about you" (Memory and For you) | `GET /api/assist/profile` | `profileFor()`, `rebuildProfile()` | none |

What one distill pass does, in order ([`knowledge.ts`](../src/lib/server/knowledge.ts) `runDistillPass`):

1. `forgetStaleMemories()` decays and prunes old memories, marking each one `decay`. `pruneRuns()`
   drops `agent_runs` rows older than 30 days.
2. `rollupTraceEpisodes()` turns captured traces into episodes. This only matters with capture on.
3. `embedPendingItems()` embeds up to `EMBED_ITEMS_PER_PASS` document items, newest first. Items
   triaged `drop` go last, or are never embedded when `TRIAGE_GATE=hard`.
4. `distillQueue()` takes items that are not yet distilled (`distilled_at` null) and are either
   annotated or past the wait. The order is `key` first, then `keep` and unjudged items by salience,
   then `drop`. Items are grouped by `thread_key`, and `key` items get longer excerpts. `chatJson`
   then reads them with browsing, people, known entities, existing memories and spaces as context.
5. `upsertMemories()` deduplicates at `MEMORY_DEDUP_SIM` and skips a fact the person forgot, found
   by tombstone. `applyRelations()` writes `memory_edges`, provenance goes to `memory_sources`, and
   the memory is linked to its entity.
6. `runConsolidationPass()` writes derived memories, and `rebuildProfile()` runs when the profile is
   stale.

Annotation is not part of the pass. Catch-up and imports call `annotate` before `distill`, and
items wait up to `DISTILL_ANNOTATE_WAIT_HOURS` (24) for signals. `TRIAGE_GATE` defaults to `soft`:
`drop` items are still distilled and embedded, only last. With `hard` they get neither. `MODEL_ANNOTATE` is the one switch for the smaller model; it
falls back to `earcue-reason` until an `earcue-annotate` deployment exists.

"Forget this" leaves a tombstone (migration 022), so a later distill pass cannot learn the same fact
again. A memory the person states themselves (manual or chat) lifts the tombstone. Correct stores the
new text and supersedes the old memory. Both mark the profile stale, so the next catch-up rebuilds it.

Sensitive memories (`memories.sensitive`: health, money, legal, intimate) never reach suggestions or
the profile. Only the person's own surfaces return them: recall, Ask earcue and People. Raw items
follow a matching rule on proactive surfaces. An item appears there only after annotation, and only
if its `sensitive` signal is under 0.5.

Ask earcue keeps the conversation on the client and sends the last 12 turns. Server-side it keeps
only the person's typed message, as a `note` item, when a turn remembers something. Before running,
each write passes the guards AGENTS.md lists: typed turns only, refs the loop has seen, a cap of
three `remember`s, and a `decide()` check that the person asked for the change.

Every person in `context_items.participants` resolves to an entity by exact address. Names never
merge on their own (migration 028), so the People section offers a manual merge.

| | |
|---|---|
| UI | [`memory-view.tsx`](../src/components/app/memory-view.tsx), [`memory-row.tsx`](../src/components/app/memory-row.tsx), [`ask-earcue.tsx`](../src/components/app/ask-earcue.tsx), [`people-section.tsx`](../src/components/app/people-section.tsx) |
| Client | [`knowledge.ts`](../src/lib/client/knowledge.ts) `annotateLoop`, `distillLoop`, `recallMemory`, `remember`, `forgetMemory`, `correctMemory`, `loadPeople`, `loadPerson`, `mergePeople`, `loadSpaces`; [`chat.ts`](../src/lib/client/chat.ts) `sendChat`, `undoChange` (event `earcue:chat`) |
| Tables | `memories` (`forgotten_reason`, `run_id`, `entity_id`), `memory_sources`, `memory_edges`, `user_profile`, `context_items` (signals, `distilled_at`, `embedding`), `entities`, `entity_aliases`, `item_entities`, `agent_runs` |
| Model calls | [`llm.ts`](../src/lib/server/llm.ts) `chatJson`, [`decide.ts`](../src/lib/server/decide.ts), [`embed.ts`](../src/lib/server/embed.ts), [`harness/`](../src/lib/server/harness) |
| Tests | `server/knowledge-distill.test.ts`, `server/knowledge-dedup.test.ts`, `server/knowledge-pipeline.test.ts`, `server/annotate.test.ts`, `server/distill-gate.test.ts`, `server/distill-entities.test.ts`, `server/entities.test.ts`, `server/chat.test.ts`, `client/chat.test.ts`, `server/embed.test.ts`, `server/migration-020.test.ts` to `migration-028.test.ts` |

## Catch-up

Nothing runs on a clock. When the app opens or an import finishes, the client asks what work is due
and runs it as ordinary requests, so the normal quota and entitlement checks apply.

| Layer | Where |
|---|---|
| Client | [`catchup.ts`](../src/lib/client/catchup.ts) `runCatchup()` |
| API | `GET /api/assist/catchup` → `{ reviewDays, distillDue, profileDue, annotateDue, loops }`. No inference. Its one write is `refresh_open_loops()`. |
| Server | [`assist/catchup.ts`](../src/lib/server/assist/catchup.ts), [`open-loops.ts`](../src/lib/server/open-loops.ts) |
| Follow-ups, in order | `POST /api/review` for each finished day (capture only); `POST /api/assist/annotate` while items wait for signals, then the plan again; `POST /api/assist/distill` while items are ready or the profile is stale |

## Capture (on hold)

Set `CAPTURE_ENABLED = true` to bring back the **All day**, **Day** and **Live** views, the capture
settings, the flag toasts, the capture pill and the onboarding card.

| Feature | UI | Client | API | Server | Tables | Quota |
|---|---|---|---|---|---|---|
| Mic and screen capture | [`ambient-view.tsx`](../src/components/app/ambient-view.tsx), [`capture-pill.tsx`](../src/components/app/capture-pill.tsx), [`settings-ambient.tsx`](../src/components/app/settings-ambient.tsx) | [`capture.ts`](../src/lib/client/capture.ts), [`vad-gate.ts`](../src/lib/client/vad-gate.ts), [`frame-worker.ts`](../src/lib/client/frame-worker.ts), [`localstore.ts`](../src/lib/client/localstore.ts), [`use-ambient-capture.ts`](../src/hooks/use-ambient-capture.ts) | none | none | IndexedDB (local only) | none |
| Budget pacer | [`budget-chip.tsx`](../src/components/app/budget-chip.tsx) | [`budget.ts`](../src/lib/client/budget.ts), [`shared/budget.ts`](../src/lib/shared/budget.ts) | `GET /api/account/usage` | [`account.ts`](../src/lib/server/account.ts) | `usage_daily` | none |
| Audio transcription | none | [`pipeline.ts`](../src/lib/client/pipeline.ts) | `POST /api/ingest/audio`, internal `POST /api/ingest/audio/process` | [`llm.ts`](../src/lib/server/llm.ts) `transcribe()`, [`bindings.ts`](../src/lib/server/bindings.ts) | `traces`; R2 `earcue-media`, queue `earcue-ingest` | `audio_seconds` |
| Frame captions | none | `pipeline.ts` | `POST /api/ingest/frames` | vision `chat()` | `traces` | `frames` |
| Timeline / search / heatmap | [`day-view.tsx`](../src/components/app/day-view.tsx) | [`day.ts`](../src/lib/client/day.ts) | `GET`/`POST /api/traces` | [`api/traces/route.ts`](../src/app/api/traces/route.ts) | `traces` (`text_tsv`) | none |
| Day review | `day-view.tsx` | `day.ts`, `catchup.ts` | `GET`/`POST /api/review` | [`review.ts`](../src/lib/server/review.ts) `runReview` | `day_reviews` | `reviews` |
| Meetings | [`assist-view.tsx`](../src/components/app/assist-view.tsx) | [`meetings.ts`](../src/lib/client/meetings.ts), [`shared/meetings.ts`](../src/lib/shared/meetings.ts) | `/api/assist/meeting-open`, `meeting-close`, `meetings` | [`assist/meetings.ts`](../src/lib/server/assist/meetings.ts) | `meetings` | `assist_calls` (close) |
| Live suggestions | `assist-view.tsx`, toasts | [`assist.ts`](../src/lib/client/assist.ts) `maybeSuggest` | `POST /api/assist/suggest` (live mode) | [`assist/suggest.ts`](../src/lib/server/assist/suggest.ts) | `suggestions` | `assist_calls` |
| Flags | [`alert-toasts.tsx`](../src/components/app/alert-toasts.tsx) | `pipeline.ts` `watchRows` | `POST /api/watch` | [`api/watch/route.ts`](../src/app/api/watch/route.ts), [`shared/alerts.ts`](../src/lib/shared/alerts.ts) | `traces` | `watch_calls` |
| Fact-check | Flag "Check" action | `pipeline.ts` | `POST /api/factcheck` | [`api/factcheck/route.ts`](../src/app/api/factcheck/route.ts) (model only, no web access) | none | `assist_calls` |

Tests: `api/ingest-audio.test.ts`, `client/pipeline.test.ts`, `server/llm-transcribe.test.ts`,
`shared/{vad,frames,turns,day,meetings,alerts,prompt,budget}.test.ts`.

## Accounts and billing

| Feature | UI | API | Server | Tables |
|---|---|---|---|---|
| Sign up / sign in (email + password, Google) | [`signin-form.tsx`](../src/components/auth/signin-form.tsx), `/signin` | `/api/auth/[...all]` | [`auth-server.ts`](../src/lib/server/auth-server.ts) `getAuth()` | `"user"`, `"session"`, `"account"`, `"verification"`, `users` |
| Turnstile on sign-up (Optional) | `signin-form.tsx` | `/api/auth/sign-up/email` | better-auth `captcha` plugin | none |
| Session gate on pages | `/app`, `/account` | none | [`page-session.ts`](../src/lib/server/page-session.ts) | none |
| Request auth | none | every route | [`auth.ts`](../src/lib/server/auth.ts) `requireUser`, `requireIngestUser`, `requireAuthed` | `ingest_tokens` |
| Plans and quotas | [`upgrade-card.tsx`](../src/components/app/upgrade-card.tsx), quota toasts | none | [`plans.ts`](../src/lib/server/plans.ts), [`quota.ts`](../src/lib/server/quota.ts), [`entitlement.ts`](../src/lib/server/entitlement.ts) | `usage_daily`, `users.plan`/`unlimited` |
| Checkout and portal (Optional, `BILLING_ENABLED=1`) | [`account-panel.tsx`](../src/components/account/account-panel.tsx) | `/api/account/checkout`, `/api/auth/customer/*` | Polar plugin, `syncEntitlement` webhook | `users.plan_status`, `current_period_end` |
| Export / delete / usage | `account-panel.tsx` (reached from [`account-menu.tsx`](../src/components/app/account-menu.tsx)) | `/api/account/export`, `delete`, `usage` | [`account.ts`](../src/lib/server/account.ts) | all user rows |

Tests: `api/gate.test.ts`, `server/plans.test.ts`, `shared/auth-errors.test.ts`.

**Plans** ([`plans.ts`](../src/lib/server/plans.ts)): `none` is the paywall and allows recall only.
`free` is what everyone gets while billing is off: ingestion and recommendations with small caps and
no capture. `pro` adds capture caps. `users.unlimited` lifts all caps.

## Platform and operations (internal)

| Feature | Where |
|---|---|
| Health | [`api/health/route.ts`](../src/app/api/health/route.ts). Public: `{ok, release, missingCount, features}`. With `Bearer CRON_SECRET` it adds `missing`, `stale`, `llm` spend and `runs` (today's `agent_runs` per task and outcome). It never queries the DB on the public branch. |
| Run log and harness | [`harness/`](../src/lib/server/harness): `runs.ts` (one `agent_runs` row per model task, with its prompt version, refs and outcome; 30-day retention), `check.ts` (output check), `schema.ts`, `context.ts` (budgets, untrusted sections, `redactInjection()`), `tools.ts` (the read tools `recall`, `search_items`, `thread`, `calendar`, `person`, `entity`, `open_loops`), `loop.ts` (`runLoop()`). Tests: `server/harness/*.test.ts`, including `subrequests.test.ts` for the Worker's subrequest budget. |
| Offline evals | [`tests/evals/`](../tests/evals), `npm run eval`. It runs against the real Azure deployment, so it costs money and never runs in `npm test` or CI. Each run commits a `results/<date>.json` file. `EVAL_LABELS=1`, `EVAL_CHANGE=1`, `EVAL_ACTION=1` and `EVAL_DASHBOARD=1` add the annotation, change-check, action-check and dashboard layout evals. |
| Spend metering and ceiling | [`llm.ts`](../src/lib/server/llm.ts) `postWithRetry` → `llm_usage_daily` (per user and model). `DAILY_TOKEN_CEILING` → `SpendCeilingReached` → 503. Tests: `server/llm-chat.test.ts`. |
| DB access | [`db.ts`](../src/lib/server/db.ts) (one `pg` client per query over Hyperdrive), [`request-scope.ts`](../src/lib/server/request-scope.ts). Tests: `server/request-scope.test.ts`. |
| Audio queue consumer | [`infra/task-consumer/`](../infra/task-consumer): `earcue-ingest` → `/api/ingest/audio/process`, DLQ `earcue-ingest-dlq` |
| Schema | [`db/migrations/`](../db/migrations), `npm run migrate` |
| Scripts | `dev:doctor`, `dev:seed`, `dev:token`, `seed:admin`, `reembed` ([`scripts/`](../scripts)) |
| CI/CD | `.github/workflows/ci.yml`: lint → typecheck → test → build; on `main`, migrate + deploy + health poll. The deploy job is skipped until the `CLOUDFLARE_ACCOUNT_ID` repository variable is set, so for now production is migrated and deployed by hand. |

## Cross-references

### Quota metric → what charges it

| Metric (`usage_daily`) | Charged by |
|---|---|
| `import_items` | `begin`/`items`/`browser` imports, `page`, `gmail-backfill` |
| `distills` | `POST /api/assist/distill` |
| `annotations` | `POST /api/assist/annotate` (per item, before any model call) |
| `recalls` | `GET /api/assist/recall` |
| `assist_calls` | `suggest`, `remember`, `correct`, `chat` (one per call, however many steps), `dashboard-build` (only when it asks the model), `meeting-close`, `/api/factcheck` |
| `connector_syncs` | `/api/connect/sync`, `/api/connect/upload`, `/api/connect/service-connect`, `/api/connect/service-refresh` |
| `audio_seconds` | `/api/ingest/audio` |
| `frames` | `/api/ingest/frames` |
| `watch_calls` | `/api/watch` |
| `reviews` | `POST /api/review` |

### Table → features

| Table | Features |
|---|---|
| `users` | Accounts, plans, `tz`, `capture_pages`, `unlimited` |
| `usage_daily` | Quotas, budget pacer, `/account` usage |
| `llm_usage_daily` | Spend metering, health `llm` |
| `imports` | Every source; removal |
| `context_items` | Every source's raw items and notes; documents' embeddings; participants; `thread_key`; item signals; `distilled_at` |
| `memories`, `memory_sources`, `memory_edges` | Distillation, recall, provenance-based removal, consolidation, tombstones, correct, Ask earcue |
| `entities`, `entity_aliases`, `item_entities` | People, entity links from annotation and distill, the `person`/`entity` tools |
| `open_loops` | Open loops, briefing candidates, feedback, the dashboard's loop panels |
| `agent_runs` | Run log for every model task, health `runs`, export |
| `user_profile` | Distill and trace cursors, profile buckets |
| `suggestions` | For you feed, live suggestions, feedback (`loop_id`, `run_id`), the dashboard's recommendations panel |
| `dashboards` | The Dashboard view's page: chosen panel keys, fingerprint, pins, hidden panels, `run_id` |
| `connections` | Gmail/Calendar/Slack OAuth |
| `service_connections` | Connected services (hosted MCP servers): credentials, OAuth client, cached tools, `allow_actions` |
| `ingest_tokens` | Extension auth |
| `traces`, `day_reviews`, `meetings` | Capture (on hold) |

### Coverage gaps

These features have no direct unit test today:

- Connector OAuth, sync and token refresh (`connect.ts`, `connectors.ts`)
- Account delete (`account.ts`); export is covered in `knowledge-pipeline.test.ts`
- Recall rerank (`rerankMemories`)
- The client recommendation loop (`recommend.ts`, `catchup.ts`)
- The extension (`extension/`) itself, apart from the helper copies tested in `history-paging.test.ts`; `client/extension.test.ts` covers only the page's side of the bridge
- Page capture (`handlePage`), apart from `pagetext.test.ts`
- The People section and Ask earcue components; `chat.ts` on the client is covered, the views are not
- The "Connect a service" section (`services-section.tsx`) and `lib/client/services.ts`
- The Dashboard view (`dashboard-view.tsx`) and `lib/client/dashboard.ts`; the server side is covered in `server/dashboard.test.ts`
