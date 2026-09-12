# 004 — Ingest cost model: what a day and a backfill actually cost

Research output for `.wayfinder/tickets/004-ingest-cost-model.md`. **Facts only** — no budget
decisions, no cap recommendations. Every call shape below was read out of source at the cited
`file:line`. Every price is either from a primary source (linked at the end) or marked
**UNVERIFIED**.

Read date: 2026-09-12. Deployment shape assumed throughout: **single user** (repo owner, own data),
Vercel Hobby, NVIDIA NIM the only inference provider, Gemini embeddings only, Neon Postgres.

---

## 0. Two findings that reframe the whole model

Before the numbers, two facts that change what "cost" even means here.

### 0.1 NVIDIA's hosted NIM API has no published per-token price. It is credit-metered and the credits are not purchasable.

`api/_lib/env.js:12` points at `https://integrate.api.nvidia.com/v1` — the hosted build.nvidia.com
catalog, not self-hosted NIM. NVIDIA publishes **no per-token rate** for it. The model page for the
exact transcription model this repo defaults to
([nemotron-3-nano-omni-30b-a3b-reasoning](https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning))
carries no pricing or credit-consumption language at all; `https://build.nvidia.com/pricing` is a
404.

What NVIDIA's own developer forum states: **1,000 API credits on signup, up to 5,000 total on
request, +4,000 more by supplying a business email to activate a 90-day AI Enterprise evaluation.**
Credits cannot be bought. When they run out the options are: request more, self-host NIM, or move to
a third-party serverless host. Secondary sources consistently describe the metering as
**≈1 credit per API call**, variable by model — **UNVERIFIED** by NVIDIA (the forum thread
explicitly does not confirm the credit↔call ratio).

**Consequence:** the meter that actually applies to this deployment today is **API call count against
a finite, non-renewable ~5,000–9,000 credit allowance**, not dollars per token. Dollar figures below
are given against *market-proxy* rates from other hosts so the arithmetic is re-runnable, but they
are not what this deployment is billed.

Incidental: `api/_lib/plans.js:3-7` carries a stale comment telling the reader to re-verify Gemini
rates for four `gemini-3.5-*` / `gemini-2.5-*` model ids that no longer appear anywhere in the code.
The PLANS numbers underneath it were derived from a pricing model that no longer describes this
system.

### 0.2 On this deployment the quota system is off.

`scripts/seed-admin.mjs:46-48` seeds the owner with `unlimited = true`. `capsFor`
(`api/_lib/plans.js:36`) then returns `UNLIMITED_CAPS` (`api/_lib/plans.js:23-33`):
`distills: 1_000_000`, `recalls: 1_000_000`, `assistCalls: 1_000_000`, `watchCalls: 1_000_000`,
`frames: 1_000_000`, `importItems: 100_000_000`, `audioSeconds: 86_400`.

So every "capped by" entry in the inventory below reads **1,000,000/day for the only user of this
system**. The `pro` caps are listed because they are the shipped defaults and the arithmetic should
be re-runnable under either, but they do not currently bind.

Second-order effect: `effectivePlan` returns `"pro"` unconditionally while billing is off
(`api/_lib/plans.js:17`, `BILLING_ENABLED` defaults `"0"` at `api/_lib/env.js:38`). `handleRecall`
gates LLM reranking on `user.plan === "pro"` (`api/assist/[action].js:885`) — so **reranking is
enabled**, adding one `MODEL_REASON` call per recall, with a 1,000,000/day ceiling.

---

## 1. Call-shape inventory

Models resolved from `api/_lib/env.js:14-16,21`:

| env var | default model id | line |
|---|---|---|
| `MODEL_TRANSCRIBE` | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | `api/_lib/env.js:14` |
| `MODEL_VISION` | `meta/llama-3.2-11b-vision-instruct` | `api/_lib/env.js:15` |
| `MODEL_REASON` | `minimaxai/minimax-m3` | `api/_lib/env.js:16` |
| `MODEL_EMBED` | `gemini-embedding-001` (768 dims, `api/_lib/embed.js:3`) | `api/_lib/env.js:21` |

### 1.1 NIM calls — live capture path

| # | Call site | Per | Batch actually used | Model | Est. input tokens | maxTokens | Capped by (pro / unlimited) |
|---|---|---|---|---|---|---|---|
| 1 | `api/ingest/audio.js:78-89` `chat()` | **per audio chunk** | 1 chunk = **20 s** (`src/capture.js:12` `AUDIO_CHUNK_MS`); flush drains ≤6 chunks serially = 6 separate calls (`src/pipeline.js:38` `getPendingChunks(6)`) | TRANSCRIBE | whole blob inline as `data:` URI (`api/ingest/audio.js:84`); ~500 audio tok + ~60 text (**UNVERIFIED** audio tokenization) | 1200 | `audio_seconds` (`:53`) — 28 800 s/day → **1 440 calls/day** / 86 400 s → **4 320 calls/day** |
| 2 | `api/ingest/frames.js:59-67` `chatJson()` | **per frame, 1 frame per call** | hard `frames.slice(0, 1)` (`api/ingest/frames.js:51`); client mirrors with `FRAME_BATCH_MAX = 1` (`src/pipeline.js:69`) and `FRAMES_PER_CALL = 1` (`src/budget.js:9`) | VISION | 1 JPEG ≤2 000 000 b64 chars (`:47`) + ~130 text; ~1 100 image tokens (**UNVERIFIED**) | 500 | `frames` — 1 440/day; pacer floor **60 s** (`src/budget.js:7`) → ≤60/h |
| 3 | `api/watch.js:58-63` `chatJson()` | **per batch** | `watchBuffer.slice(-40)` = ≤40 trace rows (`src/pipeline.js:208`) | REASON | ~2 000 | 800 | `watch_calls` (`:49`) — 480/day; pacer floor **60 s** |
| 4 | `api/assist/[action].js:368-373` `chatJson()` (suggest) | per tick | profile + 8 memories + ≤80 traces + 5 calendar + 10 inbox + 20 titles (`:355-366`) | REASON | **~7 000** (fattest hot-path prompt) | 1200 | `assist_calls` (`:306`) — 160/day; pacer floor **180 s** (`src/budget.js:7`, matches `ASSIST_MIN_INTERVAL_MS` `api/_lib/env.js:20`) |
| 5 | `api/assist/[action].js:94-100` `chatJson()` (meeting-close) | per meeting | whole meeting transcript rendered (`:86`), ≥60 s meetings only (`:71`) | REASON | varies, ~3–20 k | 2000 | `assist_calls` (`:77`) |
| 6 | `api/factcheck.js:17-26` `chat()` | per claim | 1 | REASON | ~300 | 300 | **NOTHING — no `assertEntitled`, no `consume`.** Only `requireUser` (`:8`). The one authenticated handler in the repo that skips both gates (contrast `api/watch.js:29-34,44-47`) |
| 7 | `api/review.js:122-127` `chatJson()` | per (user, day) | last **800** trace rows, rendered then truncated to **60 000 chars** (`api/review.js:109`) | REASON | **~16 000** | 2500 | `reviews` — 2/day, **but only on the HTTP path** (`api/review.js:163`). The cron calls `runReview` directly with **no `consume`** (`api/cron/review-sweep.js:92`) |

### 1.2 NIM + Gemini calls — knowledge path

`runDistillPass` (`api/_lib/knowledge.js:696-796`) is the unit of work. One invocation:

| Step | Site | Calls | Batch | Est. input tokens | maxTokens |
|---|---|---|---|---|---|
| `rollupTraceEpisodes` | `:703` → `:489-540` | **0 LLM, 0 embed** | reads ≤**600** traces (`:489` default `maxTraces`), groups into ≤80-line episodes (`:510`), `EPISODE_GAP_MS = 900000` (`api/_lib/env.js:29`) | — | — |
| distill | `:755-761` `chatJson()` | **1 NIM REASON** | **per batch of `DISTILL_BATCH = 300` `context_items`** (`api/_lib/env.js:23`, used `:711-716`). Each item: title ≤200 + body ≤600 chars (`:728-729`) | 300 items ≈ 45 k chars ≈ **11 k tok**, + 25-row domain summary (`:735`), + 60 `existing` memories (`:737-741`), + containers (`:742`), + 3 recent reviews (`:746-753`) → **~18 000** | 2500 |
| `upsertMemories` | `:764` → `:191-250` | **1 Gemini `batchEmbedContents`** | **per ≤100 texts** (`api/_lib/embed.js:44-47`); distill emits ≤**25** memories (instruction `:487`) → 1 call. Then **2 sequential SQL round-trips per memory**: HNSW nearest probe (`:211-216`) + update (`:226`) or insert (`:239`) → ≤50 round trips | ≤25 × ~40 tok | — |
| `applyRelations` | `:765` → `:252-275` | 0 LLM/embed | ≤2 SQL round-trips per relation | — | — |
| `runConsolidationPass` | `:772` → `:640-680` | **1 NIM REASON** + **1 Gemini embed** | **per batch of 40 memories** (`:645`); gated `rows.length >= DREAM_MIN_MEMORIES (12)` (`:647`, `api/_lib/env.js:28`) and `Date.now() < deadline - 15000` (`:770`); emits ≤5 derived (`:637`) | ~3 000 | 1200 |
| `rebuildProfile` | `:784` → `:568-608` | **1 NIM REASON** | **per batch of 120 memories** (`:576`); gated on `created + updated > 0` | ~9 000 | 1500 |

**Total per distill pass: 3 NIM `MODEL_REASON` calls + 2 Gemini `batchEmbedContents` calls,
consuming 300 `context_items`.** Counted as **one** `distills` unit (`api/cron/review-sweep.js:46`,
`api/assist/[action].js:776`).

Recall:

| Site | Calls | Notes |
|---|---|---|
| `recall()` `api/_lib/knowledge.js:317-399` | **1 Gemini `embedOne`** (`:324`) + 4 SQL (fused RRF `:326`, documents `:361`, hit_count bump `:374`, optional related `:386`) | `RECALL_CANDIDATES = 30`, `RECALL_RRF_K = 60` (`api/_lib/env.js:25-26`) |
| `rerankMemories()` `api/_lib/knowledge.js:298-308` | **+1 NIM REASON**, maxTokens 600, `deadlineMs: 20000` | only when `?rerank=1` **and** `user.plan === "pro"` (`api/assist/[action].js:885`) — which is always, per §0.2. Payload = the ≤25 fused rows |
| callers | `handleRecall` `api/assist/[action].js:887` (cap `recalls` 1 000/day pro) · `handleSuggest` `api/assist/[action].js:331` (rides `assist_calls`) | |
| `addManualMemory` `api/_lib/knowledge.js:820-834` | **1 NIM REASON** (maxTokens 400) + **1 Gemini embed** | `/api/assist/remember`, cap `assist_calls` (`:913`) |

### 1.3 The import path carries ZERO inference

This is the load-bearing fact for the backfill number.

| Site | Calls |
|---|---|
| `normalizeBrowserRows` `api/_lib/knowledge.js:54-116` | **pure JS, zero network.** Drops untitled history rows (`:72`) and low-signal ones — `visitCount < 2 && typedCount < 1` (`:78`). Drops excluded hosts (`:65`) and non-http(s)/localhost URLs (`:46-48`) |
| `normalizeItems` `api/_lib/knowledge.js:118-153` | pure JS; body truncated to 4 000 chars (`:136`) |
| `insertContextItems` `api/_lib/knowledge.js:157-182` | **exactly 1 SQL round-trip per batch**, `insert ... select from unnest(...)` with `on conflict do update` (`:175-178`). No LLM, no embedding |
| `handleBrowser` `api/assist/[action].js:497-529` | server rejects batches >500 (`:505`); extension sends **300** (`extension/background.js:47`); browser-file importer also sends **300** (`src/knowledge.js:48,63`). `consume("import_items", items.length)` (`:514`) |
| `handleItems` `api/assist/[action].js:531-561` | same, `consume` at `:546` |
| `handleWhatsappBackfill` `api/assist/[action].js:694-769` | **zero inference.** ≤**100 chats** (`:724` `chatsOverview(sessionName, 100)`) × ≤**500 messages** (`:728` `for offset < 500; offset += 100`) = **≤50 000 items per full pass.** One `insertContextItems` per chat (`:748`). 45 s deadline (`:719`) with a resumable `cursor` = chat index (`:717`, `:753`) |
| `handleGmailBackfill` `api/assist/[action].js:591-692` | **zero inference.** 100 ids/page (`:621`), metadata fetched 10-wide via `Promise.all` (`:631-640`), loops pages until the 45 s deadline (`:618`), `cursor` = `pageToken` (`:672`) |
| `handleWhatsappWebhook` `api/connect/[action].js:304-363` | **zero inference.** 1 `insertContextItems` per inbound message (`:356`), `consume("import_items", 1)` (`:349`). Returns **200 not 429** on quota (`:351-353`) so WAHA stops redelivering |
| `handleSync` `api/connect/[action].js:137-194` | zero inference. **One SQL round-trip per item** in a serial loop (`:159-170`) — not batched, unlike `insertContextItems`. Then a retention delete of `import_id is null` rows older than `CONTEXT_RETENTION_DAYS = 30` (`:188-191`, `api/_lib/env.js:19`). Cap `connector_syncs` 96/day, pacer floor 600 s (`src/budget.js:7`) |

### 1.4 Cron

`vercel.json:7` — `{ "path": "/api/cron/review-sweep", "schedule": "0 6 * * *" }` — **once per day**,
`maxDuration: 60` (`vercel.json:15`). The only cron in the repo.

- `SWEEP_BUDGET_MS = 50000`, `SWEEP_LIMIT = 200` (`api/_lib/env.js:17-18`).
- Reviews get the first 70% ≈ 35 s (`api/cron/review-sweep.js:69`), knowledge gets the remainder
  (`:70`, `:103`).
- Knowledge sweep: `forgetStaleMemories()` — one SQL `update` (`:20` → `api/_lib/knowledge.js:682`),
  then **exactly one `runDistillPass` per candidate user** (`:39-51`), each granted
  `Math.min(deadline, Date.now() + 45000)` (`:47`).
- With one user: cron ceiling is **1 review call + 3 distill REASON calls + 2 Gemini embed calls per
  night**, hard-stopped at 50 s.

---

## 2. Pricing

### NVIDIA NIM — see §0.1. No published per-token rate. **UNVERIFIED.**

Market-proxy rates for the same model weights at other hosts, fetched from the OpenRouter models
API on 2026-09-12 (**secondary source**, used only so the token arithmetic is re-runnable):

| Model | Input $/M | Output $/M | Status |
|---|---|---|---|
| `minimax/minimax-m3` (= `MODEL_REASON`) | **$0.30** | **$1.20** | listed, 1 048 576 ctx |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` (= `MODEL_TRANSCRIBE`) | $0 | $0 | **only a `:free` variant is listed.** No paid rate published anywhere I could reach → **UNVERIFIED.** Nearest paid sibling `nvidia/nemotron-3-nano-30b-a3b` = $0.05 / $0.20. **Audio-token accounting for the omni model: UNVERIFIED** |
| `meta/llama-3.2-11b-vision-instruct` (= `MODEL_VISION`) | — | — | **not listed on OpenRouter today; deepinfra model page 404s. Price UNVERIFIED. Per-image token count UNVERIFIED** |

### Gemini embeddings

The current Gemini API pricing page lists **exactly one** embedding model:

| Model | Text input $/M | Batch API $/M |
|---|---|---|
| `gemini-embedding-2` | **$0.20** | $0.10 |

**`gemini-embedding-001` — the model this repo actually uses (`api/_lib/env.js:21`) — is documented
as still supported (text-only, 2 048-token input limit, 128–3 072 output dims) but does NOT appear
on the current pricing page. Its paid rate is UNVERIFIED.** Widely-reported secondary figure:
$0.15/M. All Gemini figures below use **$0.20/M** as a verified upper bound.

Two corrections that matter:
- `batchEmbedContents` is the **synchronous** multi-request endpoint, not the asynchronous Batch API.
  **The 50% batch discount does not apply.**
- `api/_lib/embed.js:20` truncates each text to 8 000 chars, but `gemini-embedding-001`'s input
  limit is **2 048 tokens** (~8 000 chars is right at the edge). A long `context_items` body could
  be rejected rather than truncated — a correctness note, not a cost note.

### Neon Postgres

| Item | Rate |
|---|---|
| Free plan | **0.5 GB storage/project, 100 CU-hours/project**; hitting either suspends compute until the next cycle |
| Launch | **$0.106/CU-hour**, **$0.35/GB-month**, $1.50/extra branch-month, no monthly minimum |
| Scale | $0.222/CU-hour, $0.35/GB-month |
| CU definition | 1 CU ≈ 4 GB RAM; **minimum compute 0.25 CU** (~1 GB RAM); CU-hours = size × hours running |
| Scale-to-zero | **default 5 minutes** of no active queries |

pgvector index: `create index memories_embedding on memories using hnsw (embedding vector_cosine_ops)`
(`db/migrations/008_knowledge.sql:42`), over `embedding vector(768)` (`:32`, matching
`EMBED_DIMS = 768` at `api/_lib/embed.js:3`). Neon publishes no separate pgvector or index charge —
index pages are billed as ordinary storage at $0.35/GB-month.

---

## 3. Number 1 — steady-state day

**Assumptions (change these and re-run):**

- 2 h armed capture, mic only, speech present ~40% of the time (the voiced gate at
  `src/capture.js:125` drops silent 20 s chunks; `minVoicedMsFor` = 2 000 ms while >25% of the audio
  budget remains, `src/budget.js:49-51`).
- 1 h screen capture, frames paced at the 60 s floor.
- 200 inbound WhatsApp messages via webhook over the day.
- 1 h of browsing; extension alarm is hourly (`extension/background.js:6`) → 24 syncs/day, ~60 new
  history rows each.
- 1 meeting closed.
- Nightly cron: 1 review + 1 distill pass.
- 5 manual recalls (rerank on, per §0.2).

**NIM calls:**

| Source | Calls | Est. input tok | Est. output tok |
|---|---|---|---|
| audio (`api/ingest/audio.js:78`) | 2 h / 20 s × 40% = **144** | ~81 k (mostly audio) | ~22 k |
| frames (`api/ingest/frames.js:59`) | **60** | ~74 k (mostly image) | ~18 k |
| watch (`api/watch.js:58`) | 2 h / 60 s = **120** | ~240 k | ~96 k |
| suggest (`api/assist/[action].js:368`) | 2 h / 180 s = **40** | ~280 k | ~48 k |
| meeting-close (`api/assist/[action].js:94`) | **1** | ~10 k | ~2 k |
| review, cron (`api/review.js:122`) | **1** | ~16 k | ~2.5 k |
| distill + consolidate + profile (`api/_lib/knowledge.js:755,649,590`) | **3** | ~30 k | ~5.2 k |
| rerank (`api/_lib/knowledge.js:302`) | **5** | ~10 k | ~3 k |
| **Total** | **≈374 NIM calls/day** | **≈741 k in** | **≈197 k out** |

`MODEL_REASON` alone: ~586 k in, ~157 k out.

**Gemini `batchEmbedContents` calls:** 40 (one per suggest recall, `api/_lib/knowledge.js:324`)
+ 5 (manual recalls) + 2 (distill: memories + derived) = **≈47 calls/day**, carrying
≈**6 000 tokens** total (a suggest query embeds a ≤400-char focus string,
`api/assist/[action].js:328`; the distill embed is ≤25 memory sentences).

**Neon:** compute stays hot for the whole 2 h capture session (a flush fires every 20 s,
`src/capture.js:140`, so the 5 min idle timer never elapses). Plus 24 hourly extension syncs, each
paying a 5 min idle tail = 2 h. Plus cron ~1 min. ≈**4.2 h at 0.25 CU = 1.05 CU-hours/day
≈ 32 CU-hours/month.** Storage growth ≈300 rows/day × ~400 B + index overhead ≈ **0.25 MB/day**.

**Cost:**

| Meter | Steady-state day |
|---|---|
| **NVIDIA credits (the meter that applies)** | **≈374 credits/day.** A 5 000-credit allowance lasts **~13 days**; the 9 000-credit business-email allowance ~24 days. Not purchasable when exhausted |
| NIM dollars, `MODEL_REASON` at market proxy | 586 k × $0.30/M + 157 k × $1.20/M = $0.176 + $0.188 = **$0.36/day** |
| NIM dollars, TRANSCRIBE | at the `nemotron-3-nano-30b-a3b` sibling rate: **~$0.008/day** — **UNVERIFIED** |
| NIM dollars, VISION | 60 calls, ~74 k image-equiv input — **UNVERIFIED, no rate obtainable** |
| Gemini | 6 000 tok × $0.20/M = **$0.0012/day** (≈$0.04/month). Rounding error |
| Neon | 32 CU-h/month is **inside the 100 CU-h free allowance**; on Launch = 32 × $0.106 = **$3.39/month ≈ $0.11/day** + $0.0026/month storage |

**Steady-state day ≈ 374 NIM calls, 47 Gemini calls, 1.05 CU-hours. ≈$0.37/day of inference at
market-proxy rates (two of three models unverified) + ≈$0.11/day Neon compute.
Under NVIDIA's real meter: ≈374 of a one-time ~5 000-credit budget.**

---

## 4. Number 2 — cold-start backfill

**Assumptions:**

- `IMPORT_LOOKBACK_DAYS = 180` (`api/_lib/env.js:22`), mirrored as a hardcoded constant in
  `extension/background.js:1` with a comment requiring the two stay equal.
- **The extension cannot actually deliver 180 days.** `chrome.history.search` is called with
  `maxResults: 5000` (`extension/background.js:35`), so the first sync sees **at most 5 000 rows**
  regardless of the 180-day window. Post-filter (drop untitled, drop `visitCount<2 && typedCount<1`,
  `api/_lib/knowledge.js:72,78`) → ~2 500 items. A file-based import through `src/knowledge.js` is
  not bounded this way.
- 2 500 history items + 800 bookmarks.
- WhatsApp full backfill: ceiling is **50 000 items** (100 chats × 500 msgs,
  `api/assist/[action].js:724,728`); assume 25 000 real.
- Gmail 180 days: ~10 000 emails.
- **Total ≈38 300 `context_items`.**

**Ingest-side inference: exactly zero.** Every import handler in §1.3 is pure SQL. The 38 300 rows
arrive in 38 300/300 = **128 chunked POSTs** (`extension/background.js:47`, `src/knowledge.js:48`),
each one `insertContextItems` = one SQL statement (`api/_lib/knowledge.js:168`), plus the
WhatsApp/Gmail walkers which batch per chat / per page.

**Distill-side:** 38 300 / `DISTILL_BATCH` 300 = **128 distill passes**, each 3 NIM `MODEL_REASON` +
2 Gemini embed:

| | |
|---|---|
| NIM calls | 128 × 3 = **384** |
| NIM input tokens | 128 × (18 k + 3 k + 9 k) = **≈3.84 M** |
| NIM output tokens | 128 × (2 500 + 1 200 + 1 500) = **≈666 k** |
| NIM dollars (market proxy) | 3.84 M × $0.30/M + 666 k × $1.20/M = $1.15 + $0.80 = **≈$1.95 one-off** |
| Gemini calls | 128 × 2 = **256** |
| Gemini tokens | 128 × ~1 200 = 154 k → **$0.03 one-off** |
| Memories produced | ≤25/pass × 128 = ≤3 200 before dedup at `MEMORY_DEDUP_SIM = 0.9` (`api/_lib/env.js:24`, applied `api/_lib/knowledge.js:218`) → realistically 800–1 500 rows |
| Storage, `context_items` | 38 300 rows × ~350 B payload ≈ 13 MB heap + `body_tsv` GIN + the `(user_id, provider, external_id)` unique index ≈ **40–60 MB** |
| Storage, `memories` + HNSW | 1 500 × 768 × 4 B = 4.6 MB vectors + HNSW graph ≈ **~15 MB** |
| Storage dollars | ~75 MB — **inside Neon Free's 0.5 GB**; on Launch = **$0.026/month** |
| Neon compute | 128 passes, each dominated by waiting on NIM with a hot connection ≈ 60 s → **~2.1 h ≈ 0.53 CU-hours** total |

**Calendar time is the real constraint, not money.** The cron runs **one** `runDistillPass` per user
per night (`api/cron/review-sweep.js:39-51`) = 300 items/night → **128 nights ≈ 4.3 months** to
drain the backlog. The manual `/api/assist/distill` action (`api/assist/[action].js:771-784`) can be
POSTed 24×/day on `pro` → 6 days; under `unlimited` (1 000 000 distills) the only limit is the 45 s
deadline per call (`:782`).

**Cold-start backfill ≈ 384 NIM calls, 256 Gemini calls, ~4 M NIM input tokens, ~75 MB storage,
≈$2 one-off at market-proxy rates. Under NVIDIA's real meter: ≈384 credits.**

**This is less than one and a half steady-state days.** The backfill is cheap because import carries
no inference and distillation batches 300 items into one prompt; the live day is expensive because
it is 1 NIM call per 20 s of audio and 1 per frame.

---

## 5. Number 3 — worst plausible runaway

Five candidate mechanisms, evaluated. Two are real, three are not.

### 5.1 REAL — `api/factcheck.js` has no quota gate, and `nim.js` fans out 3× beneath it

`api/factcheck.js:5-26`: `requireUser` at `:8`, then straight to `chat()` at `:17`. **No
`assertEntitled`, no `consume`.** Every other authenticated handler follows the documented
auth → entitlement → quota order (`api/watch.js:29-34,44-47`; `api/ingest/audio.js:41-57`); this one
skips the last two. Reachable from the client via `checkClaim` (`src/pipeline.js`, re-exported
`app.js:5`) and directly by any authenticated caller.

Compounded by `api/_lib/nim.js`: `chat()` retries up to **3 HTTP attempts** (`:10`) on any of
`{429, 500, 502, 503, 504}` (`:3`, `:44`). Sustained at NVIDIA's documented 40 RPM ceiling
(**UNVERIFIED**, secondary source) × 3 attempts = 120 HTTP requests/min.

| | |
|---|---|
| Requests/day | 40 × 60 × 24 = **57 600 logical, up to 172 800 HTTP** |
| Tokens | ~300 in + ~300 out each → 17.3 M in + 17.3 M out |
| Dollars (market proxy) | $5.2 + $20.7 = **≈$26/day**, ×3 on a retry storm = **≈$78/day** |
| NVIDIA credits | **the entire 5 000-credit allowance in under 2 hours** |

### 5.2 REAL — `chatJson` retry amplification: one counted operation, up to 6 billed requests

`api/_lib/nim.js:130-149`. Every `chatJson` is up to **two** `chat()` calls: the first attempt, then
a JSON-nudge retry at `:144`. The retry calls `buildJsonMessages(messages, schema)` **again**
(`:138`) — **it rebuilds and re-sends the entire original prompt**, plus a nudge, at the same
`maxTokens`. And each `chat()` is itself up to 3 HTTP attempts (`:10`).

**One logical `chatJson` = up to 6 billable NIM requests, and the quota counter was decremented
exactly once, before the call.** `consume()` counts logical operations; `nim.js` spends HTTP
requests. `api/_lib/quota.js` structurally cannot see this.

On the distill path this is the expensive case: 3 logical `chatJson` × 6 = **18 NIM requests per
"1 distill"**, each carrying up to 18 k input tokens → **~200 k input tokens billed against a
counter that reads `distills: 1`.** The triggering condition is exactly the one
`api/_lib/nim.js:135-137`'s own comment describes: a model that answers in prose despite the
schema example. A model in that state burns 6× the prompt for zero memories, forever, because
`distill_cursor` only advances after a successful parse (`api/_lib/knowledge.js:767`).

### 5.3 REAL but bounded — the episode → `context_items` → distill feedback loop

`rollupTraceEpisodes` writes its own episode summaries **back into `context_items`**
(`api/_lib/knowledge.js:536`), each a ≤4 000-char body (`:531`). `runDistillPass` then reads
`context_items` forward of `distill_cursor` (`:712-716`) — **including the episodes it wrote on this
same invocation** (rollup runs first, at `:703`, before the cursor read at `:708`).

So `context_items` grows even with zero imports and zero connectors: a capture-heavy day producing
~600 traces yields ~8 episodes → 8 more items to distill. **Bounded** (episodes do not generate
traces), inflating the backlog by ~1–3% per cycle rather than diverging. Worth naming because it
means the "nightly cron over a huge `context_items` table" scenario arrives eventually with no
import activity at all.

### 5.4 NOT a runaway — re-backfilling the same window costs zero inference

The ticket's hypothesis. It does not hold, for a specific reason worth recording.

`handleWhatsappBackfill` resumes from `cursor` only for an import row with `status = 'running'`
(`api/assist/[action].js:706-709`). Any WAHA failure sets `status = 'failed'` (`:763`), so the next
call **opens a fresh import at `chatIndex = 0`** (`:710-717`) and re-walks all 100 chats × 500
messages. Likewise `extension/background.js:63-66` deliberately leaves `lastSyncMs` unchanged on
failure so the next alarm retries the identical window.

But: `insertContextItems` upserts on `(user_id, provider, external_id)` (`api/_lib/knowledge.js:175`)
and **does not change the row's `id`**. Re-upserted rows therefore stay *behind* `distill_cursor` and
are **never re-distilled**. The cost of a re-backfill is: WAHA/Gmail API quota, N SQL round-trips,
and a double charge against the `import_items` counter (`:740`) — **zero NIM calls, zero Gemini
calls.** The counter over-reports; the bill does not.

### 5.5 NOT a runaway — the nightly cron cannot overspend, only starve

`api/cron/review-sweep.js` is hard-bounded three ways: `SWEEP_BUDGET_MS = 50000`
(`api/_lib/env.js:18`) checked at `:40` and `:87`, `SWEEP_LIMIT = 200` (`:17`) as a SQL `limit`, and
`maxDuration: 60` (`vercel.json:15`). With one user its ceiling is **1 review + 3 distill REASON
calls + 2 Gemini calls per night**, no matter how large `context_items` grows. The candidate query
(`:22-31`) is two `exists` subqueries against indexed `(user_id, id)` predicates.

The cron's actual failure mode is **starvation, and a latent overrun**: reviews take 70% of the
budget (`:69`), leaving ~15 s — but `runKnowledgeSweep` then grants a single distill pass
`Date.now() + 45000` (`:47`), which **exceeds the 15 s it has left and can exceed
`maxDuration: 60`** on a night with reviews to do. The function is then killed mid-pass. Damage is
limited because `upsertMemories` and the `distill_cursor` advance both commit before consolidation
and the profile rebuild (`api/_lib/knowledge.js:764-767`) — at most the profile rebuild is lost.
Cost impact: the 300-items-per-night drain rate is optimistic; on a busy night it is zero.

### Worst plausible runaway — the number

**§5.1 × §5.2: an accidental loop over `api/factcheck.js`, which has no quota gate, with `nim.js`'s
3× HTTP retry beneath it.**

**≈57 600 logical NIM calls/day, up to 172 800 HTTP requests/day, ≈$26–78/day at market-proxy rates
(UNVERIFIED), and NVIDIA's entire non-purchasable ~5 000-credit allowance consumed in under two
hours.**

Runner-up, because it needs no bug to trigger — only a model drifting off JSON: **§5.2 alone turns
every nightly distill pass into ~200 k input tokens billed against a counter reading 1**, and it
persists indefinitely because `distill_cursor` never advances past the failing batch.

---

## 6. Single largest cost driver

**It depends on the meter, and the two answers differ. Under the meter that actually applies today
it is audio transcription.**

### Under NVIDIA's real meter (credits ≈ API calls) — `api/ingest/audio.js:78`

**One NIM request per 20 seconds of kept audio.** `AUDIO_CHUNK_MS = 20000` (`src/capture.js:12`) →
`recorder.start(AUDIO_CHUNK_MS)` (`:143`) → one `chat()` per chunk (`api/ingest/audio.js:78`), with
the entire audio blob inlined as a base64 `data:` URI in the prompt (`:84`).

- **144 of 374 calls (39%) on a modelled steady-state day** — the largest single line by call count.
- Scales **linearly with hours armed**, with no batching anywhere: the flush drains 6 pending chunks
  as **6 separate calls** (`src/pipeline.js:38`), never one batched request.
- Ceiling: `audioSeconds` 28 800/day → **1 440 calls/day** on `pro`; 86 400/day → **4 320 calls/day**
  on `unlimited`, which is what this deployment runs (§0.2).
- The only thing holding it below that ceiling is a client-side heuristic — the voiced-audio gate at
  `src/capture.js:125` with `minVoicedMsFor` (`src/budget.js:49-51`) — not a server cap.
- At 4 320 calls/day the ~5 000-credit lifetime allowance is gone in **a single day of continuous
  capture**.

### Under a per-token meter — `api/watch.js:58-63`

If NIM ever bills per token at the `minimax-m3` market rate, the largest line is instead the
per-minute flag-detection call: **≈$0.19 of a ≈$0.36 `MODEL_REASON` day (52%)**. 120 calls × ~2 000
input + 800 output, on a model priced **4× more for output than input**, for a call whose own
instruction says "Emit an empty array when nothing qualifies — that is the common case"
(`api/watch.js:27-31`). It is also the only `chatJson` call site in the repo that passes **no
`deadlineMs`** (`api/watch.js:58-63`), so it inherits the full 45 s default and all 3 retries
(`api/_lib/nim.js:7`).

### What is definitively *not* the cost driver

- **Embeddings.** ≈$0.04/month at the verified upper-bound rate. Six orders of magnitude below NIM.
- **Neon storage.** ~75 MB after a full backfill; the HNSW index over one user's corpus is ~15 MB.
  Inside the free tier. Neon **compute** ($3.39/month on Launch, driven by the 20 s flush keeping
  the instance hot) is ~90× the storage cost.
- **The backfill.** §4: ≈$2 and 384 calls, one-off. Less than 1.5 steady-state days.
- **The nightly cron.** §5.5: structurally incapable of overspending.

---

## 7. Gaps and unverified items

| Item | Status |
|---|---|
| NVIDIA NIM per-token price, any model | **UNVERIFIED — no published rate exists.** build.nvidia.com/pricing 404s; the model pages carry no pricing; the docs FAQ URL 404s. Obtainable only from an NVIDIA AI Enterprise quote or an account's own billing page |
| NVIDIA credit↔call ratio | **UNVERIFIED.** "1 credit ≈ 1 API call, variable by model" is secondary-source only; the NVIDIA forum thread declines to confirm it. Obtainable from the account's credit balance before/after a known number of calls |
| NVIDIA 40 RPM rate limit | **UNVERIFIED**, secondary source. Obtainable from response headers on a real call |
| `meta/llama-3.2-11b-vision-instruct` price + image token count | **UNVERIFIED.** Not listed on OpenRouter; deepinfra page 404s. Obtainable from the `usage` field NIM returns and `api/_lib/nim.js:39` already captures but discards |
| `nemotron-3-nano-omni-*` audio token accounting | **UNVERIFIED.** Only a `:free` variant listed anywhere. Same fix: log the `usage` field |
| `gemini-embedding-001` paid rate | **UNVERIFIED** — still documented as supported but absent from the pricing page. $0.20/M (`gemini-embedding-2`) used as a verified upper bound; $0.15/M is the secondary-source figure |
| All input-token estimates in §3–§4 | **ESTIMATED from prompt structure, not measured.** `api/_lib/nim.js:39` already returns `usage: json.usage` from every NIM response and **every caller throws it away** — `chat()`'s return value is destructured for `.text` only at `api/ingest/audio.js:90`, and `chatJson` (`:132`) discards the whole `result` object except `.text`. Logging that one field via `api/_lib/log.js` would replace every estimate in this document with a measurement |
| Neon actual CU-hours and storage | **ESTIMATED.** Real figures are on the Neon console's Usage page for this project |

---

## Sources

Primary:
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) — `gemini-embedding-2` $0.20/M text input, $0.10/M batch; no `gemini-embedding-001` entry
- [Gemini API embeddings docs](https://ai.google.dev/gemini-api/docs/embeddings) — `gemini-embedding-001` still supported, 2 048-token input limit, 128–3 072 dims; `batchEmbedContents` still supported
- [NVIDIA NIM model page: nemotron-3-nano-omni-30b-a3b-reasoning](https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning) — no pricing or credit language on the page
- [NVIDIA developer forum: API credits for build.nvidia.com](https://forums.developer.nvidia.com/t/api-credits-for-build-nvidia-com/306633) — 1 000 credits on signup, 5 000 trial ceiling, +4 000 with business email; credits not purchasable; credit↔call ratio not confirmed
- [Neon pricing](https://neon.com/pricing) — Free 0.5 GB / 100 CU-h; Launch $0.106/CU-h + $0.35/GB-month; Scale $0.222/CU-h
- [Neon usage metrics](https://neon.com/docs/introduction/usage-metrics) — 1 CU ≈ 4 GB RAM, min 0.25 CU, CU-h = size × hours, 1 GB-month definition
- [Neon compute lifecycle](https://neon.com/docs/introduction/compute-lifecycle) — 5 min default scale-to-zero
- [NVIDIA NIM LLM API reference](https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html) — `chat/completions` contract

Secondary (market-proxy rates and unconfirmed operational limits, flagged inline):
- [OpenRouter models API](https://openrouter.ai/api/v1/models) — `minimax/minimax-m3` $0.30/$1.20 per M; `nvidia/nemotron-3-nano-30b-a3b` $0.05/$0.20 per M; `nemotron-3-nano-omni-30b-a3b-reasoning` `:free` only (fetched 2026-09-12)
- [OpenRouter: minimax/minimax-m3](https://openrouter.ai/minimax/minimax-m3)
- [OpenRouter: nvidia/nemotron-3-nano-30b-a3b](https://openrouter.ai/nvidia/nemotron-3-nano-30b-a3b)
- [decodethefuture.org: NVIDIA NIM API pricing/limits](https://decodethefuture.org/en/nvidia-nim-api-pricing-limits-guide/) — 40 RPM, 1 000→5 000 credits, "1 credit ≈ 1 API call"
- [costbench.com: NVIDIA NIM free plan](https://costbench.com/software/llm-api-providers/nvidia-nim/free-plan/) — hosted catalog is a prototyping tier with unpublished quotas
