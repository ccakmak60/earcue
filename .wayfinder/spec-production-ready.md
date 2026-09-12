---
id: spec-1
title: "Hardening spec: knowledge base, WhatsApp, Chrome ingestion"
parent: map-1
labels: [ready-for-agent]
status: draft
assignee: ccakmak60
---

# Hardening spec: knowledge base, WhatsApp, Chrome ingestion

> **Status: draft, not locked.** Five decisions in [Implementation Decisions](#implementation-decisions)
> are marked **OPEN** and carry a recommended default rather than an answer. They are the subject of
> grilling tickets 5, 6, 7, 9, 10 on [the map](map-production-ready-kb-whatsapp-chrome.md) and are the
> owner's to make. Everything else is settled and implementable as written.
>
> Grounded in research tickets 1–4:
> [supermemory delta](research/001-supermemory-delta.md) ·
> [WAHA facts](research/002-waha-facts.md) ·
> [Chrome Web Store gates](research/003-chrome-store-gates.md) ·
> [cost model](research/004-cost-model.md).

## Problem Statement

The owner runs earcue on their own real data every day and cannot currently trust it.

Three named features are built and shipped but not dependable:

1. **The knowledge base fills up but recall is a coin flip.** Imported `context_items` are searched
   by raw Postgres full-text only — they are never chunked and never embedded, so a document is
   findable solely by literal keyword overlap. `recall()` fuses vector and full-text candidates with
   Reciprocal Rank Fusion and re-scores by `memory_strength()` decay, but applies no similarity
   floor: a query with no good match still returns eight confident-looking rows. Memories the LLM
   *inferred* (`origin = 'derived'`) rank identically to memories drawn from real source material,
   and there is no way to tell whether turning any of the four tuning knobs
   (`RECALL_CANDIDATES`, `RECALL_RRF_K`, the decay half-life, re-rank on/off) makes recall better or
   worse.

2. **WhatsApp is dark.** `api/_lib/waha.js`, the three `whatsapp-*` dispatcher actions, and
   `handleWhatsappBackfill()` are all written, but `WAHA_BASE_URL` is `""`, so `connectorsEnabled()`
   hides the connector and the code has never met a running container. When it does run, the design
   loses messages: WAHA's `WebhookSender.send()` is fire-and-forget with no dead-letter queue, so
   any message delivered while the deployment is down is gone; `chatMessages()` passes
   `downloadMedia: "false"`, so voice notes and images are dropped without a trace; and
   `normalizeWahaMessage()` has four payload mismatches against real WAHA output.

3. **Nothing can tell the owner that ingestion broke.** `extension/background.js` swallows every
   sync failure into `console.error` inside a service worker nobody watches. The WhatsApp webhook
   writes `last_error` onto a `connections` row nothing reads. Email delivery was deliberately
   removed in `011_drop_email_prefs.sql`. `/api/health` checks environment variables and nothing
   else. A sync can fail silently for weeks and the only symptom is recall quietly getting worse —
   which is indistinguishable from the recall problem above.

Underneath all three: **the budget meter is not what the code assumes.** `api/_lib/quota.js` caps
per-metric daily *call counts*, which is a proxy for spend, and the owner's account is seeded
`unlimited = true`, so every cap reads 1,000,000/day and none of them bind. Meanwhile the actual
constraint is a finite, non-renewable NVIDIA credit allowance worth roughly 13 days of steady-state
use, and one authenticated handler (`api/factcheck.js`) reaches the inference path with no
entitlement check and no quota consumption at all.

The Chrome extension additionally cannot be installed the intended way: five Chrome Web Store
review gates block a listing today, the most serious being that it starts uploading browsing
history the instant it is installed, before the user has seen any consent surface.

## Solution

One hardening pass that makes the three features dependable for a single owner running daily, by
adding **one observable readiness surface**, **one measurable recall bar**, and **one enforced cost
ceiling** — and by closing the specific data-loss holes each ingestion path has.

From the owner's point of view, after this pass:

- Opening the app shows, at a glance, whether each source is fresh — WhatsApp session state, last
  browser sync, last distill pass, stuck imports — with the repair button for each one right next to
  its status. Nothing is ever "quietly broken".
- An external uptime poller watches one URL and alerts when ingestion goes stale, replacing the
  notification channel that migration 011 removed. No new email infrastructure.
- Recall is answerable. A fixed set of the owner's own real questions, with the owner's own
  judgements, runs as a script against the live database and prints one number. Any change to the
  retrieval path is accepted or rejected by whether that number moves.
- Backfill gaps close on their own: each source has a defined lookback, a defined re-backfill
  semantic, and a cursor that only advances over data actually accepted — so an interrupted sync
  retries the gap instead of skipping it.
- WhatsApp runs against a real, provisioned container with a known restore procedure, and dropped
  media is either ingested or explicitly and visibly declared out of scope rather than silently
  discarded.
- Spend is bounded by a number the owner chose, enforced at one place, with real token counts
  recorded instead of estimated.
- The extension is installable from the Chrome Web Store, asks before it reads anything, and says
  truthfully in `privacy.html` what leaves the machine and to whom.

## User Stories

**Knowing the system is healthy**

1. As the owner, I want each ingestion source to report when it last successfully accepted data, so that I can tell at a glance whether the knowledge base is still being fed.
2. As the owner, I want a single URL that returns non-OK when any source has gone stale, so that a free external uptime service can notify me without earcue needing a notification channel of its own.
3. As the owner, I want the staleness threshold to be per-source rather than global, so that a weekly bookmark sync and an hourly history sync are not judged by the same clock.
4. As the owner, I want the unauthenticated health response to stay exactly as cheap as it is today, so that an uptime poller hitting it every minute never touches the database or costs me anything.
5. As the owner, I want the detailed per-source report to require the existing `CRON_SECRET` bearer token, so that publishing the health URL to an uptime service does not publish my ingestion state to the internet.
6. As the owner, I want a freshness strip in the app's Knowledge tab reading the same data as the health endpoint, so that I see the same truth in the place where I would act on it.
7. As the owner, I want each stale source in that strip to sit next to the control that repairs it, so that detection and repair are one motion rather than a detection followed by a hunt.
8. As the owner, I want an `imports` row that has sat in `running` past a threshold to be reported as stuck, so that a backfill killed mid-flight by a function timeout does not look like an in-progress one forever.
9. As the owner, I want the nightly cron to record that it ran and what it did, so that "the distill pass has not completed in 48 hours" is a detectable condition and not an inference from missing memories.
10. As the owner, I want a WhatsApp session in any state other than `WORKING` to count as stale, so that a session dropped by WhatsApp's 14-day linked-device rule surfaces as a problem rather than as an absence of messages.

**Trusting recall**

11. As the owner, I want a fixed file of my own real questions against my own knowledge base, so that recall quality is a measurement instead of an impression.
12. As the owner, I want each question paired with my own judgement of what a correct answer contains, so that the bar is mine and not an LLM's opinion of itself.
13. As the owner, I want the eval set frozen before any retrieval change is chosen, so that the architecture decision cannot be shaped to flatter itself.
14. As the owner, I want one number printed at the end of an eval run, so that accepting or rejecting a retrieval change is a comparison and not a debate.
15. As the owner, I want a stated value of that number below which I consider recall not production ready, so that "good enough" is decided once rather than re-litigated per change.
16. As the owner, I want the eval harness to run against the live database with real embeddings, so that it measures the system I actually use rather than a fixture.
17. As the owner, I want the harness to be a plain script I run on demand, so that it costs nothing when I am not running it and needs no test framework this repo does not have.
18. As the owner, I want recall to return nothing rather than something when no candidate clears a similarity floor, so that an unanswerable question reads as unanswerable instead of as eight plausible wrong rows.
19. As the owner, I want memories the model inferred to rank below memories drawn from real source material at equal relevance, so that the knowledge base's confident claims trace back to something I actually said, read, or received.
20. As the owner, I want imported documents to be retrievable by meaning and not only by literal keyword, so that a question phrased differently from the source text still finds it.
21. As the owner, I want long imported documents split into coherent units before they are embedded, so that one relevant paragraph inside a long page is findable without the whole page having to be relevant.
22. As the owner, I want each retrieval change scoped small enough to land and be measured on its own, so that a regression is attributable to one change rather than to a batch.
23. As the owner, I want any retrieval change requiring re-embedding flagged with its cost before I accept it, so that a schema improvement does not quietly consume days of credit allowance.

**Not losing data**

24. As the owner, I want the browser history sync to never advance its cursor past visits it did not actually upload, so that a truncated or interrupted sync retries the gap instead of skipping it permanently.
25. As the owner, I want the history sync to page through a window it cannot fetch in one call, so that a busy day exceeding the per-call result cap does not silently drop its oldest visits.
26. As the owner, I want the extension to tell the server how far back it actually reached, so that a lookback the browser cannot honour is visible rather than aspirational.
27. As the owner, I want to know whether history is ingested per-URL or per-visit, and to have that stated, so that "I visited this three times this week" is either answerable or knowably unanswerable.
28. As the owner, I want WhatsApp history gaps closed by the backfill path rather than by webhook redelivery, so that messages arriving while the deployment is down are eventually ingested anyway.
29. As the owner, I want the WhatsApp backfill to be re-runnable over a window I choose, so that closing a known gap does not require reasoning about cursors.
30. As the owner, I want a second backfill over the same window to be a no-op for stored data, so that re-running it out of caution is free rather than destructive or duplicative.
31. As the owner, I want the backfill's own limits on chats and messages-per-chat to be explicit and raisable, so that "backfilled" does not silently mean "the first hundred chats, five hundred messages each".
32. As the owner, I want messages carrying media rather than text to be either ingested or visibly recorded as skipped, so that a voice note is not indistinguishable from a message that never existed.
33. As the owner, I want `normalizeWahaMessage()` to be correct against the payloads the chosen WAHA engine actually sends, so that a field-name mismatch does not discard messages silently.
34. As the owner, I want duplicate webhook deliveries to be idempotent, so that WAHA's retry policy inflates no counters and creates no duplicate rows.
35. As the owner, I want group-chat messages either ingested or filtered by an explicit rule, so that group traffic is a decision rather than an accident of what the payload happened to contain.
36. As the owner, I want to know what losing the Neon database would actually cost me, so that I can decide how much backup posture is warranted given that browser and WhatsApp data can be re-backfilled but captured traces cannot.
37. As the owner, I want the restore procedure for the WhatsApp session to be one I have actually executed, so that "it is on a volume" is a verified claim rather than an assumption.

**Not blowing the budget**

38. As the owner, I want every authenticated handler that reaches an inference call to pass through the entitlement and quota gates, so that no endpoint can spend my allowance without being counted.
39. As the owner, I want real token counts recorded rather than estimated, so that the cost model becomes a measurement I can re-read instead of arithmetic I have to re-run.
40. As the owner, I want a stated monthly ceiling across inference, embeddings, database, and the WhatsApp host, so that there is a number to compare actual spend against.
41. As the owner, I want the per-metric daily caps recalibrated against that ceiling, so that the caps that already exist mean something rather than being documentation.
42. As the owner, I want a cold-start backfill authorised separately from steady-state use, so that a legitimate one-time spike is not blocked by a daily cap sized for a normal day.
43. As the owner, I want the worst accidental loop bounded at one place, so that runaway protection is a single thing I can verify rather than a property distributed across call sites.
44. As the owner, I want to see credit and spend consumption where I already see quota, so that the budget surface is one surface and not two.
45. As the owner, I want the nightly distill pass to not be able to overrun its function's own time limit, so that a truncated pass fails cleanly instead of being killed mid-write.
46. As the owner, I want to know how many nights the backfill queue will take to drain at the current batch size, so that "backfilled" has a date attached.

**Installing the extension**

47. As the owner, I want to install the extension from the Chrome Web Store, so that it stays updated and survives a machine rebuild without side-loading.
48. As a Chrome Web Store reviewer, I want to see a consent surface before the extension reads any browsing data, so that the extension's behaviour matches its disclosures.
49. As the owner, I want the extension to not start uploading on install, so that installing it is not itself the act of consenting.
50. As a Chrome Web Store reviewer, I want to be able to exercise the extension without an account I cannot obtain, so that I can verify what it does rather than reject it for being unverifiable.
51. As a Chrome Web Store reviewer, I want the privacy policy to name browsing history and bookmarks explicitly and to name the third parties that receive derived data, so that the single-purpose and limited-use requirements are demonstrably met.
52. As the owner, I want the extension to request only the host permissions it needs, so that a wildcard permission does not invite a rejection I can avoid by deleting one line.
53. As the owner, I want to know whether the pasted ingest token survives review before I build a real auth flow, so that I do not pay for a large change the store does not require.
54. As the owner, I want a stated release procedure for shipping a new extension version, so that a fix does not sit unshipped because the process was never written down.
55. As the owner, I want `privacy.html` to say NVIDIA where it currently says Gemini for inference, so that the policy describes the system that exists.

**Verifying the whole thing**

56. As the owner, I want every new pure function exercised by `selfCheck()`, so that logic regressions are caught without introducing a test framework this repo does not have.
57. As the owner, I want pure logic shared between the server and `selfCheck()` to live where both can import it, so that verifying it does not require duplicating it.
58. As the owner, I want a written pre-flight checklist covering what only a human can confirm, so that "production ready" has a definition I can walk through rather than a feeling.
59. As the owner, I want the checklist to be runnable against a local `vercel dev` as well as the deployment, so that I can verify a change before it ships.
60. As the owner, I want `AGENTS.md` updated in the same pass, so that the next session's architecture reference is not already stale.

## Implementation Decisions

### Inherited hard constraints

These are not decisions; they bound every decision below.

- **Vercel Hobby caps the deployment at 12 serverless functions and all 12 are in use**
  (`account/[action]`, `assist/[action]`, `auth/[...all]`, `connect/[action]`, `cron/review-sweep`,
  `factcheck`, `health`, `ingest/audio`, `ingest/frames`, `review`, `traces`, `watch`). Every new
  endpoint in this spec is a new `action` on an existing dispatcher or an extension of an existing
  handler. **No new top-level file under `api/`.**
- **There is exactly one cron entry.** New periodic work is a step inside
  `api/cron/review-sweep.js`, not a second cron.
- **No test framework, linter, or CI.** Verification is `selfCheck()`, `/api/health`, and
  `scripts/*.mjs`. A decision that assumes a test suite is not implementable.
- **`db/migrations/` is append-only and the next file is `013_*.sql`.** (`AGENTS.md` says the next
  is `012` — stale, `012_unlimited.sql` exists. Fix in the same pass.)
- **`src/` must never import from `api/`,** and Vercel does not serve `api/` as static assets. Logic
  needed in both places goes in `src/`.
- **Gate order is fixed:** `requireUser` (401) → `assertEntitled` (402) → `consume` (429) → input
  validation → business logic.

### D1. The readiness seam: `/api/health` becomes the one health surface

`/api/health` is extended from an environment-variable check into a full readiness report. It is the
single mechanism serving three otherwise-separate needs: silent-failure detection, cost visibility,
and the automated half of "production ready".

- The **unauthenticated** response keeps its exact current contract — `{ ok, release, missingCount,
  features }`, 200/503 on missing required env — and performs **no database query**. This is
  deliberate: it is the URL an uptime poller hits every minute, and a cold Neon query on that path
  is a recurring cost for no benefit.
- The **`Authorization: Bearer <CRON_SECRET>`** branch, which already exists to expose the `missing`
  array, additionally returns a per-source freshness report and flips `ok` to false (and the status
  to 503) when any source is stale. An uptime service configured with the bearer header therefore
  watches ingestion health; one configured without it watches only boot health.
- `GET`-only and `405` on everything else stays.

Chosen over the alternatives: a new endpoint costs a function slot that does not exist; reinstating
email means re-adding a delivery dependency migration 011 deliberately removed; an app-only surface
cannot alert while the app is closed, which is exactly when a sync fails; extending `/api/health`
reuses a handler, a route, an auth mechanism, and a 200/503 contract that all already exist.

### D2. Freshness is computed from existing columns, not a new table

No new tracking table. Each source's last-success timestamp already exists:

| Source | Last-success signal | Existing column |
|---|---|---|
| Browser history / bookmarks | most recent completed import | `imports.updated_at` where `source` in the browser sources and `status = 'complete'` |
| WhatsApp live | webhook accepted a message | `connections.last_synced_at` where `provider = 'whatsapp'` |
| WhatsApp session | session state | live `getSession()` status, already fetched by `whatsapp-status` |
| Distillation | cron advanced the cursor | `user_profile.updated_at` |
| Stuck imports | non-terminal too long | `imports.status = 'running'` and `updated_at` older than threshold |
| Connector errors | last recorded failure | `connections.last_error` (non-null) |

Thresholds live in `ENV_DEFAULTS` in `api/_lib/env.js` as a single `HEALTH_STALE_*` group with coded
defaults, following the existing tuning-knob convention — so they are adjustable without a
deployment and absent-safe.

The **staleness predicate itself is a pure function** placed in `src/` (per the `src/turns.js` /
`src/meetings.js` precedent) so that both the health handler and `selfCheck()` import the same
implementation. This is the one structural move that makes the readiness logic verifiable at all.

### D3. Repair lives next to detection

The Knowledge tab's freshness strip reads the same authenticated health payload and renders each
stale source beside the control that fixes it — all of which already exist: **Backfill WhatsApp**
(`whatsappBackfill`), **Distill** (`handleDistill`), the WhatsApp **relink** flow
(`connectWhatsapp` → `whatsapp-link`), and import removal (`handleRemove`). No new repair
affordances are built; the work is wiring, not construction. A detection with no adjacent repair is
noise and does not ship.

### D4. Cursors advance only over accepted data

The general rule for all three ingestion paths, and the direct fix for the primary silent-data-loss
mode.

- **Extension history sync.** `chrome.history.search` returns at most `maxResults` entries,
  most-recent-first. Today the extension asks for 5,000 in one call and then sets
  `lastSyncMs = endTime` on success — so a window containing more than 5,000 entries drops its
  *oldest* visits and then permanently advances past them. Fix: page the window by walking
  `endTime` backwards from the oldest entry received until a page returns fewer than the cap, and
  set `lastSyncMs` to the oldest timestamp actually uploaded on partial failure rather than to
  `endTime`. `IMPORT_LOOKBACK_DAYS` becomes reachable instead of aspirational.
- **Granularity is per-URL, stated explicitly.** `chrome.history.search` returns one entry per URL
  carrying `lastVisitTime` and `visitCount`, not one entry per visit. Per-visit ingestion would
  require `chrome.history.getVisits` per URL — rejected: it multiplies request count and
  `context_items` rows for a capability the recall queries do not need. `visitCount` and
  `typedCount` are already carried through `normalizeBrowserRows`, which is sufficient. **Documented
  as a limitation, not fixed.**
- **WhatsApp backfill** already resumes via `imports.cursor` holding a chat index. Its real bounds
  are the undocumented literals `chatsOverview(sessionName, 100)` and `offset < 500` — a hard cap of
  100 chats and 500 messages per chat. These move to `ENV_DEFAULTS` knobs so "backfilled" has known
  limits.

### D5. WhatsApp gaps close by backfill, never by webhook retry

Settled by [the WAHA research](research/002-waha-facts.md): `WebhookSender.send()` calls
`axios.post` without awaiting it and logs the rejection — best-effort, in-memory, no persistence, no
dead-letter, no replay. A webhook-only ingestion design is therefore a silent-data-loss design by
construction, regardless of the `retries` config `sessionConfig()` sends.

Consequences:

- The backfill path (`chats/{id}/messages` with `filter.timestamp.gte`) is the **authoritative**
  ingestion path. The webhook is a latency optimisation on top of it.
- A bounded backfill runs periodically as a step in `api/cron/review-sweep.js`, after review and
  distillation, on the remainder of the same budget — the same pattern `runKnowledgeSweep` already
  uses. It closes whatever the webhook missed without the owner noticing a gap.
- Re-backfill is **idempotent by design and stays that way**: `insertContextItems` upserts on
  `(user_id, provider, external_id)` where `external_id` is `waha:${msg.id}`, and the upsert
  preserves `context_items.id`. Re-imported rows therefore stay behind `user_profile.distill_cursor`
  and are never re-distilled — a re-backfill costs zero inference. The only cost is a
  double-decremented `import_items` counter, addressed in D8.
- **Webhook idempotency needs no new mechanism.** The existing unique constraint already absorbs
  duplicate deliveries. What changes is that the response distinguishes an insert from a no-op so
  duplicate volume is observable.
- `normalizeWahaMessage()` is corrected against the payload shape the chosen engine actually emits:
  the display-name path currently reads `msg._data?.notifyName` / `pushName`, which is
  engine-specific and absent on GOWS; `fromMe` and the `message` vs `message.any` event distinction
  are handled; group chats (`@g.us`) are filtered or ingested by explicit rule rather than by
  omission; unrecognised `session.status` values do not fall through silently. **The authoritative
  payload shapes come from ticket 11, which must run before this is implemented** — the four
  mismatches are documented findings, not verified observations.

### D6. Media is declared, not silently dropped

`chatMessages()` sends `downloadMedia: "false"`, and `normalizeWahaMessage()` returns `null` for any
message with an empty `body` — so a voice note is currently indistinguishable from a message that
never existed. Voice notes and images are **not** ingested in this pass (transcribing them would
route audio through `MODEL_TRANSCRIBE` at a cost the cost model did not budget and the credit
allowance cannot absorb). Instead a skipped media message increments the `imports.items_skipped`
counter that already exists and is already rendered by `renderImportRow`. The owner sees a count of
what was not ingested. Deliberate, visible, reversible.

### D7. Retrieval changes, ordered, gated on the eval number

Adopted from [the supermemory delta](research/001-supermemory-delta.md) — subject to D11's eval set
existing first, and each item accepted or rejected by whether the eval number moves. Scope caveat
that governs the whole list: supermemory's memory engine is **not** in its public repository, so
every claim about its internals is a documentation claim, not read code. These are adopted because
they are defensible on their own merits, never because "their architecture does it".

Ordered cheapest-and-safest first:

1. **Similarity floor on recall.** `recall()` applies no threshold; a query with no good match still
   returns `limit` rows ranked by a fused score that is always positive. Add a floor below which a
   candidate is discarded. No migration, no re-embedding, one predicate — and it directly fixes the
   "confident wrong answers" failure. Highest value per line of code in the list.
2. **Down-weight inferred memories.** `recall()` already selects `m.origin` but the score expression
   `f.rrf * (1 + 0.5 * memory_strength(...))` ignores it, so `origin = 'derived'` rows rank
   identically to first-party ones. Add an origin factor to the score. `upsertMemories` already
   refuses to let a derived memory overwrite a first-party one at dedup time; this extends the same
   principle to ranking. No migration.
3. **Chunk and embed imported documents.** The largest structural gap: `context_items` are searched
   only via `body_tsv` full-text, never chunked, never embedded, so document recall is pure keyword
   overlap. Requires a migration (`013_*.sql`) and an embedding pass over existing rows — the one
   item here with a real cost, which the cost model prices at roughly 256 Gemini calls for the full
   ~38,300-item corpus. Flagged as **needs migration + re-embedding**.
4. **Ingest at coherent-unit granularity.** `runDistillPass` sends one `chatJson` call carrying
   `DISTILL_BATCH = 300` heterogeneous items and asks the model to produce memories from all of
   them at once. Splitting by coherent unit trades call count for quality — and call count is the
   binding meter, so this is gated on D9's ceiling and deferred by default.
5. **Query rewriting before retrieval** and **metadata filters on recall** — deferred. Both are
   plausible improvements with no evidence yet that they move this owner's eval number, and both add
   per-query cost against a call-count meter.

**Explicitly rejected**, so they are not reopened: version chains, `isStatic` flags, configurable
profile buckets, per-container vector namespaces, cross-encoder reranking, and `entityContext`
steering — cost or complexity out of proportion to single-user benefit. Async queues, multi-modal
extractors, and container merge/scoped keys are **not applicable** to this stack. Anything requiring
a store other than Neon + pgvector is **rejected by default**: pgvector is fixed.

### D8. One authenticated handler currently bypasses the cost gates

`api/factcheck.js` runs `requireUser` and then calls `chat()` directly — no `assertEntitled`, no
`consume`. It is the only authenticated handler in the repo that violates the gate order `AGENTS.md`
mandates. It is live, not dead code: `app.js:270` renders a Verify control on `factcheck` flags,
which calls `src/pipeline.js` `checkClaim()`. So it is **gated, not deleted**: add `assertEntitled`
and `consume(user, "assist_calls", 1)` in the canonical order.

Amplification that makes this matter more than one missing gate: `chatJson` is up to **two**
`chat()` calls (the retry at `nim.js:144` rebuilds the full prompt), each up to **three** HTTP
attempts (`nim.js:10`) — **six billable requests per one decremented counter**. Because it is
user-click-driven rather than automated, the realistic exposure is lower than the theoretical
57,600 logical calls/day, but the gate is still absent and the 6:1 amplification applies to every
`chatJson` site.

Two further fixes in the same area:

- **Record real token counts.** `chat()` at `nim.js:39` already returns `usage` from every NIM
  response and every caller discards it. Persisting that one field replaces every estimate in the
  cost model with a measurement, and is the precondition for any spend-based ceiling.
- **`api/watch.js`** is the only `chatJson` call site passing no `deadlineMs`, and it requests 800
  output tokens on the reason model for a call whose own instruction says the empty array is the
  common case. Add a deadline and cut `maxTokens`.
- **Latent overrun:** `review-sweep.js:47` grants `runDistillPass` up to 45 s
  (`Math.min(deadline, Date.now() + 45000)`), and `runDistillPass`'s own `chatJson` carries
  `deadlineMs: 45000`, but by the time the knowledge sweep starts only the remainder of
  `SWEEP_BUDGET_MS` (50 s) is left against a `maxDuration` of 60 s. The inner deadline must be
  derived from the outer budget rather than restated.

### D9. **OPEN** — the cost ceiling and where it is enforced (ticket 9)

*Owner decision. This is a spend commitment, not a technical call.*

What [the cost model](research/004-cost-model.md) establishes and this spec treats as fact:

- The meter is **not dollars**. `NIM_BASE_URL` points at `integrate.api.nvidia.com` — the
  build.nvidia.com catalog, which publishes no per-token price. It is a credit-metered allowance,
  ceiling 5,000, not purchasable. The budget unit is **API calls against a finite, non-renewable
  allowance**, worth roughly **13 days** of steady state (≈374 NIM + 47 Gemini calls/day).
- Every quota cap is **non-binding today**: `scripts/seed-admin.mjs:48` seeds the owner
  `unlimited = true`, so `capsFor()` returns `UNLIMITED_CAPS` at 1,000,000/day per metric.
- **Cold-start backfill is cheap, not expensive** — ≈384 NIM and 256 Gemini calls for the whole
  ~38,300-item corpus, under 1.5 steady-state days. The import path carries zero inference
  (`insertContextItems` is one SQL statement) and distillation batches 300 items per prompt. The
  real constraint is **calendar**: one 300-item pass per night means **4.3 months** to drain.
- **Largest driver on the meter that applies:** `api/ingest/audio.js:78`, one NIM request per 20 s
  of kept audio (`AUDIO_CHUNK_MS = 20000`) — 144 of 374 daily calls, 39%, with no batching at all
  (a flush drains six chunks as six separate calls). Ceiling 4,320/day under `unlimited`.

**Recommended default:** don't build spend tracking. Instead — (a) log `usage` per D8 so the next
decision is made on data; (b) turn `unlimited` off for the owner account and set real `pro` caps
recalibrated against a credit allowance rather than an imagined dollar price; (c) authorise backfill
as a separate metric rather than a manual override, so a one-time spike does not need the daily cap
raised; (d) batch `api/ingest/audio.js` so the largest driver stops being per-20-seconds. Runaway
protection stays in `api/_lib/nim.js`, which already owns retry and deadline handling — no new layer.
Reuse `src/budget.js` and the `earcue:budget` event for visibility rather than building a second
surface.

**Needs from the owner:** the monthly number, and whether the calendar cost of the 4.3-month
backfill drain is acceptable or whether `DISTILL_BATCH` / pass count per night goes up.

### D10. **OPEN** — where WAHA runs (ticket 7)

*Owner decision. Spend commitment plus a host choice.*

Facts that constrain it: WAHA is fully free and open source since version 2026.6.1 (Plus is gone;
nothing `api/_lib/waha.js` calls was ever paywalled, so **no WAHA Plus purchase is required** —
that sub-question is closed). Session state persists on a volume at `/app/.sessions`; PostgreSQL
session storage is free; NOWEB writes `.sessions/noweb/{session}/store.sqlite3`. Vendor guidance
floors at 2 vCPU / 4 GB even for one session, while the vendor's own per-session figures are far
lower (NOWEB and GOWS ≈0.1 CPU / 200 MB). Range ≈$5–25/mo; only DigitalOcean's $24/mo is
primary-sourced. **WhatsApp logs out linked devices unless the primary phone comes online every 14
days** (number high-confidence, exact wording unverified).

The decisive technical constraint: **Vercel functions must reach WAHA's HTTP API over the public
internet.** That rules out any laptop-only or LAN-only placement unless it is fronted by a tunnel
with a stable public hostname. "Runs only when my laptop is open" is a real option with a real cost:
every message arriving while it is closed depends entirely on the backfill path in D5 to recover,
and the 14-day rule still applies.

**Recommended default:** smallest always-on VPS (≈$5–7/mo), **NOWEB** engine, Docker volume for
`/app/.sessions`, public HTTPS fronted by Caddy with `WAHA_API_KEY` as the only credential —
or a Cloudflare Tunnel if managing TLS is unwanted. `WAHA_WEBHOOK_BASE_URL` = the Vercel production
origin. **Kill criterion:** if the session drops twice to the 14-day rule, abandon live WhatsApp
ingestion and fall back to `src/importers/whatsapp.js`, which already works and costs nothing to
operate.

**Needs from the owner:** host, plan, and the accepted monthly number.

**Blocks:** ticket 11 (stand up WAHA and link the real session), which in turn supplies the verified
payload shapes D5 depends on. **This is the critical path** — the WhatsApp half of this spec cannot
be implemented from documentation alone.

### D11. **OPEN** — the recall bar (ticket 6)

*Owner decision, and the one item here that genuinely cannot be defaulted:* the eval set is 10–15
of the owner's own real questions about their own data. Nobody else can write them, and an invented
set would measure the wrong thing.

**Recommended shape** once the questions exist: known-item judgement ("this specific memory must
appear in the top N") rather than ranked relevance or an LLM judge — cheapest to produce, cheapest
to re-run, no inference cost per run. Metric: recall@8, matching `recall()`'s default `limit`. The
harness is `scripts/recall-eval.mjs` in the style of `scripts/migrate.mjs`, using
`scripts/load-env.mjs` and hitting the live database directly. It is run as a gate before and after
each D7 change, not continuously.

**Needs from the owner:** the 10–15 questions, the expected answer for each, and the recall@8 value
below which they consider recall not production ready.

**Blocks:** every item in D7. The eval set must be frozen before the retrieval changes are chosen,
or the eval gets shaped to flatter the change.

### D12. **OPEN** — publish the extension (ticket 10)

*Owner decision, but low-risk: the [store research](research/003-chrome-store-gates.md) found no
policy banning off-device transmission of browsing history, so a listing is plausible and the five
gates are documentation plus one manifest line — no architectural change.*

The five blocking gates:

1. **No in-extension consent surface**, aggravated by `chrome.runtime.onInstalled` calling
   `syncAll()` immediately — installing the extension *is* the act of consenting. Fix: drop the
   `syncAll()` call from `onInstalled` (keep the alarm registration) and gate the first sync on an
   explicit opt-in recorded in `chrome.storage.local`.
2. **`privacy.html` never says "history" or "bookmarks".** Its three `history` occurrences are Slack
   OAuth scopes. It also has no WhatsApp section, does not name NVIDIA at all, and wrongly credits
   Gemini with processing audio and screen frames — all inference goes through NVIDIA NIM; Gemini
   does embeddings only. The policy must describe the system that exists.
3. **No Limited Use statement.**
4. **`http://localhost/*` in `optional_host_permissions`** — one line to delete. `https://*/*` is
   also broader than needed; `options.js` already requests the specific origin at runtime via
   `chrome.permissions.request`, so the wildcard can narrow.
5. **A reviewer cannot exercise the extension** without an earcue account and an ingest token.

**Recommended default:** publish **public** (the research found unlisted relaxes none of the five
gates, so it buys nothing); do all five documentation/manifest fixes; **keep the pasted ingest
token** — the research found it is not itself a review problem, and a real auth flow is a much larger
change to buy nothing the store requires.

**Needs from the owner:** confirm public listing, confirm the token stays, and decide how a reviewer
gets a working account.

### D13. Documentation is part of the change, not a follow-up

Per `AGENTS.md`'s own rule. In the same pass: the migrations table gains its `013` row and the
"next one is" note is corrected from the stale `012`; every new `ENV_DEFAULTS` knob lands in
`.env.example` first and then in the required-vars list; the extended `/api/health` contract and the
`src/`-resident freshness predicate are described under Architecture and Testing & QA; `privacy.html`
is corrected per D12.

## Testing Decisions

### What a good test is here

Only external behaviour. A check that asserts on how `recall()` builds its SQL, or on the internal
shape of a freshness report, is worse than no check — it fails on every refactor and passes on every
real regression. A check asserts on what a caller sees: given these inputs, this verdict; given
this database state, this `ok` value.

There is no test framework, no linter, and no CI in this repo, and this spec does not introduce any.
`AGENTS.md` is explicit that QA is manual plus `selfCheck()`, and a spec that assumes otherwise is
not implementable.

### The seams

Three, and the first two already exist.

**Seam 1 — `selfCheck()` in `app.js`** (existing; `?selfcheck` instead of normal boot). Covers
everything pure. This is where the new logic is actually verified:

- the per-source staleness predicate from D2;
- `normalizeWahaMessage()` against recorded real payloads from ticket 11, including the four
  mismatch cases, the group-chat rule, and the empty-body/media case from D6;
- the extension's history-window paging arithmetic from D4 — given a page that hit the result cap,
  the next window's bounds, and the cursor value on partial failure.

Two of those three currently live where `selfCheck()` cannot reach them. `normalizeWahaMessage()` is
in `api/_lib/waha.js`, and `src/` must never import from `api/` — so **the pure halves move to
`src/`**, following the `src/turns.js` and `src/meetings.js` precedent that exists for exactly this
reason: logic needed by both a serverless function and the browser lives in `src/`. The extension is
an independent codebase that imports nothing from `src/`, so its paging arithmetic is duplicated
there by necessity — as `src/budget.js` already duplicates the quota metric map, with the same
comment explaining why.

Prior art in the same file: `shouldKeep`, `groupTurns`, `frameChanged`, `meetingTransition`,
`pickDistinct`, `localDayOf`, `normalizeAlert`, and the three `src/importers/*` parsers are all
exercised there today. New cases match that style — plain `assert` with a message naming what
mismatched.

**Seam 2 — `/api/health`** (existing, extended per D1). Covers everything requiring live database
state, and does double duty: it is simultaneously the production failure detector and the automated
pre-flight check. `curl -s localhost:3000/api/health -H "Authorization: Bearer $CRON_SECRET"` against
`vercel dev` is the single command that answers "is this deployment healthy", which is why the
freshness report belongs here rather than in a script.

**Seam 3 — `scripts/recall-eval.mjs`** (new; the only new seam). Recall quality needs a live
database, real embeddings, and a human judgement file — none of which fit either seam above.
Read-only, run on demand, no production path depends on it. Prior art: `scripts/migrate.mjs` for
the shape, `scripts/load-env.mjs` for env loading. One new file in a directory whose stated purpose
is one-off `node` CLI scripts.

### What is verified by hand, and written down

The pre-flight checklist from story 58. These are the things no seam can reach:

- the WAHA QR-scan and relink flow end to end, and the session surviving a container restart;
- the volume restore procedure, executed rather than assumed;
- the extension's consent gate as a Chrome Web Store reviewer would encounter it, on a clean profile;
- `privacy.html` read against what the code actually sends, to whom;
- the uptime poller actually firing when a source is made stale on purpose.

Ticket 11 produces the first two as findings. They are recorded, not re-derived.

## Out of Scope

- **Multi-tenant hardening** — per-user rate limiting, abuse prevention, tenant isolation beyond
  what exists. The destination is single-user: the owner, on their own data.
- **Billing, Polar, and entitlement work.** `assertEntitled` already gates these endpoints and the
  owner account is comped. D8 adds a missing call to the existing gate; it does not touch billing.
- **The capture pipeline** — `api/ingest/*`, `src/capture.js`, traces, teleprompter, day review.
  Real and load-bearing, but not one of the three named features. The one exception is the audio
  batching in D9, which is in scope solely because `api/ingest/audio.js` is the single largest
  consumer of the meter that binds.
- **Media transcription for WhatsApp.** Declared and counted per D6, not ingested.
- **Per-visit browser history granularity.** Documented as a per-URL limitation per D4.
- **A real auth flow for the extension.** The pasted ingest token stays unless store review forces
  otherwise (D12).
- **A second cron, a new serverless function, or a test framework.** All three are structurally
  unavailable and every decision above is shaped to avoid needing them.
- **Privacy posture beyond what the store listing forces.** The owner explicitly did not rank
  privacy exposure among the failure modes. WhatsApp message bodies and full browser history do
  leave the machine for NVIDIA NIM and Gemini, and encryption at rest currently covers only
  connector OAuth tokens (`secretbox.js`). D12 fixes the *disclosure* because the Chrome Web Store
  requires it; it does not change the *posture*.
- **Neon backup and restore policy.** Story 36 asks the question and it remains a fog patch on the
  map. Worth noting the asymmetry it turns on: browser and WhatsApp data can be re-backfilled from
  source, but captured traces cannot — they exist nowhere else.

## Further Notes

**The five open decisions, as a checklist.** This spec is not locked until each has an answer.
Each is a grilling ticket, each is HITL, and each resolves one per session:

| # | Decision | Ticket | Blocks |
|---|---|---|---|
| D11 | The recall bar — 10–15 real questions, expected answers, the recall@8 floor | [006](tickets/006-recall-quality-bar.md) | all of D7 |
| D10 | Where WAHA runs — host, plan, monthly number | [007](tickets/007-waha-hosting-decision.md) | ticket 11, then D5 |
| D9 | The cost ceiling and its enforcement point | [009](tickets/009-cost-ceiling.md) | D7 item 4, D2 thresholds |
| D1–D3 | Silent-failure detection — thresholds, surface, repair | [005](tickets/005-silent-failure-detection.md) | — (default above is complete) |
| D12 | Publish the extension — listing type, token, reviewer access | [010](tickets/010-extension-publish-call.md) | — (default above is complete) |

Ticket [008](tickets/008-supermemory-adoption-call.md) is the formal home of D7 and stays blocked on
D11 by design — the eval set must be frozen before the architecture changes are chosen.

**Suggested implementation order,** which is not the order above. D1–D3 first: they are
self-contained, need no open decision, and every subsequent change is easier to trust once the
system can say whether it is healthy. D8 next, because it is three small fixes to a real hole and
the `usage` logging it adds is the precondition for D9 being decided on data instead of estimates.
D4 next (extension paging), the largest silent-data-loss fix that needs nothing from anyone. Then
ticket 11 as soon as D10 lands, because the verified WAHA payload shapes gate D5 and D6. D7 last,
and only after D11.

**The critical path runs through ticket 11, not through any decision.** The WhatsApp half of this
spec rests on payload shapes nobody has observed. The four `normalizeWahaMessage()` mismatches, the
real `session.status` sequence, the QR validity window, and whether the webhook reaches Vercel at
all are documented inferences from source code, not observations. Implementing D5 and D6 from
documentation would mean writing code against a payload shape that may not exist. The WAHA research
lists ten loose ends resolvable only against a live container.

**One asymmetry worth keeping in view.** Everything in this spec that touches recall quality is
reversible and measurable. Everything that touches data loss is neither: a visit dropped by the
5,000-result cap in a window the cursor has already passed is gone from the source too, and no
later fix recovers it. That is why D4 is ordered ahead of D7 despite bad recall being the more
visible symptom.

**Two pieces of stale documentation found while writing this,** both fixed under D13: `AGENTS.md`
says the next migration is `012` when `012_unlimited.sql` already exists, and `privacy.html`
credits Gemini with processing audio and screen frames when all inference runs through NVIDIA NIM
and Gemini does embeddings only. The second one is a privacy-policy inaccuracy, not just a doc bug.

**Tracker note.** No issue tracker or triage-label vocabulary was configured for this session.
`AGENTS.md` names Linear as the project tracker, but nothing in the repo holds credentials for it,
which is why this effort runs on the local `.wayfinder/` markdown tracker (see
[README](README.md)). This spec is therefore published as a file rather than as an issue, and
`ready-for-agent` is set as a frontmatter label by convention. Run
`/setup-matt-pocock-skills` to wire a real tracker if these specs should land as issues instead.
