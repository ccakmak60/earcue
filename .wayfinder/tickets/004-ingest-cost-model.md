---
id: 4
title: "What a day and a backfill actually cost"
parent: map-1
labels: [wayfinder:research]
status: closed
assignee: ccakmak60
blockedBy: []
---

## Question

Cost blowout is one of the three named failure modes, and there is no cost model today —
`api/_lib/quota.js` caps *call counts* per metric, which is a proxy, not a budget.

Build the model. Two inputs: current pricing (external) and current call shapes (in this repo).

- **Pricing**: NVIDIA NIM `chat/completions` for the models `api/_lib/env.js` defaults to,
  Gemini `batchEmbedContents`, and Neon storage/compute for a pgvector HNSW index at this scale.
- **Call shapes**: count the LLM and embedding calls per unit of work by reading
  `api/_lib/knowledge.js` (`runDistillPass`, `rollupTraceEpisodes`, `runConsolidationPass`,
  `rerankMemories`, `recall`), `api/cron/review-sweep.js`, and the ingest path. Note where a call
  is per-item vs per-batch, and the batch sizes actually used.

Produce three numbers with the assumptions shown:

1. **Steady-state day** — normal capture + a day of WhatsApp messages + an hour of browsing.
2. **Cold-start backfill** — 180 days of browser history plus a full WhatsApp history backfill.
3. **Worst plausible runaway** — the most expensive loop reachable by accident (a retry storm, a
   re-backfill, the nightly cron over a huge `context_items` table).

Output: the three numbers, plus the single largest cost driver named explicitly.

## Answer

Findings: [`research/004-cost-model.md`](../research/004-cost-model.md).

**Two facts reframe the whole ticket.**

1. **The meter is not dollars.** `api/_lib/env.js:12` points at `integrate.api.nvidia.com` — the
   build.nvidia.com catalog, which publishes **no per-token price** (`/pricing` is a 404). It is a
   **credit-metered trial**: 1,000 credits on signup, 5,000 on request, +4,000 with a business
   email, not purchasable. So the real budget unit is **API calls against a finite,
   non-renewable allowance**, not spend. Flagged unverified; the dollar figures below use
   OpenRouter market proxies so the arithmetic can be re-run against any price.
2. **Quota is off on this deployment.** `scripts/seed-admin.mjs:48` seeds the owner
   `unlimited = true`, so `UNLIMITED_CAPS` (`api/_lib/plans.js:23-33`) reads 1,000,000/day for
   every metric. Every `pro` cap is documented but **non-binding today**.

**The three numbers.**

1. **Steady-state day** (2 h capture, 1 h screen, 200 WhatsApp messages, 24 extension syncs, cron):
   ≈**374 NIM calls, 47 Gemini calls, 1.05 CU-hours** — ≈$0.37/day inference + $0.11/day Neon.
   Against the meter that actually applies: **a 5,000-credit allowance lasts ~13 days.**
2. **Cold-start backfill** (~38,300 `context_items`): ≈**384 NIM calls, 256 Gemini calls, ~$2
   one-off, ~75 MB storage** — **less than 1.5 steady-state days.** The import path carries *zero*
   inference (`insertContextItems` is one SQL statement) and distillation batches 300 items per
   prompt. The constraint is **calendar, not cost**: one 300-item pass per night = **4.3 months**
   to drain. Separately, `IMPORT_LOOKBACK_DAYS = 180` is aspirational — `chrome.history.search`
   caps at `maxResults: 5000` (`extension/background.js:35`), so the extension can never deliver
   180 days.
3. **Worst runaway:** `api/factcheck.js:5-26` is the one authenticated handler with **no
   `assertEntitled` and no `consume`** — `requireUser` then straight to `chat()`. Amplified by
   `api/_lib/nim.js`: `chatJson` is up to **2** `chat()` calls (the retry at `:144` rebuilds the
   full prompt), each up to **3** HTTP attempts (`:10`) = **6 billable requests per one decremented
   counter.** At 40 RPM: ≈57,600 logical / 172,800 HTTP calls per day, ≈$26–78/day, **the entire
   credit allowance in under 2 hours.**

**The ticket's re-backfill hypothesis was wrong.** Upserts don't change `context_items.id`, so
re-imported rows stay behind `distill_cursor` and are never re-distilled — a re-backfill costs
zero inference and only double-charges the counter. The nightly cron can't overspend either
(triple-bounded); its failure modes are starvation and a latent `maxDuration` overrun
(`review-sweep.js:47` grants 45 s out of a ~15 s remaining budget).

**Largest cost driver — differs by meter, so both:**

- Under the meter that applies: **`api/ingest/audio.js:78`** — one NIM request per 20 s of kept
  audio (`AUDIO_CHUNK_MS = 20000`), **144 of 374 calls/day (39%)**, no batching anywhere (a flush
  drains 6 chunks as 6 separate calls), ceiling 4,320/day under `unlimited`. Only a client-side
  voiced-audio heuristic holds it down.
- Under a per-token meter: **`api/watch.js:58-63`**, 52% of `MODEL_REASON` spend — 800 output
  tokens on a 4×-output-priced model, for a call whose own instruction says the empty array is the
  common case, and the only `chatJson` site passing no `deadlineMs`.

**Cheap follow-up worth carrying into the spec:** `api/_lib/nim.js:39` already returns `usage` from
every NIM response and **every caller discards it.** Logging that one field replaces every token
estimate here with a measurement.
