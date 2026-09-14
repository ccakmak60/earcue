# 007 — Can the entire earcue/skua app be hosted for free? Verdict + bottlenecks

Research output. **Facts + a verdict.** Every non-trivial claim is cited to a primary
source (official docs/pricing pages read today, or repo `file:line`) with access date,
or marked **UNVERIFIED**.

Read date: 2026-09-14. All prices USD. Repo root assumed: Next.js 16 App Router,
`engines: node 22.x` (`package.json:6-8`). Prior art in this folder: `004-cost-model.md`
(ingest call shapes, credit metering), `005-hosting-comparison.md` (Vercel vs alternatives,
WAHA co-hosting), `002-waha-facts.md` (WAHA licensing/footprint). This note answers a
narrower question than 005: **is $0 hosting possible at all**, on one platform or across
free tiers — not which paid host is best.

**Convention note:** the repo keeps such notes in `.wayfinder/research/` (numbered
`NNN-*.md`); there is no `docs/research/`, `notes/`, or ADR dir, so this file follows the
`.wayfinder/research/` convention.

---

## 0. What "the entire app" means — runtime dependency inventory

Read out of source today (all paths repo-relative):

| # | Dependency | Evidence in repo | Hosted-service counterpart |
|---|---|---|---|
| 1 | Hosting: Next.js App Router, 12 API route handlers (`traces`, `watch`, `ingest/audio`, `ingest/frames`, `review`, `health`, `cron/review-sweep`, `factcheck`, `assist/[action]`, `auth/[...all]`, `connect/[action]`, `account/[action]`) | `src/app/api/**/route.ts` (glob); `package.json:34` (`next`), `package.json:10-16` scripts | Vercel (current) or any Node 22 host |
| 2 | Postgres + pgvector HNSW, `vector(768)` | `db/migrations/008_knowledge.sql:1,32,42` (`CREATE EXTENSION vector`, `embedding vector(768)`, HNSW `vector_cosine_ops`); `src/lib/server/db.ts` (neon HTTP driver), `src/lib/server/auth-server.ts:45` (`pg.Pool`, `max: 1` — second access path by design, `:43-44`) | Neon (current) |
| 3 | NVIDIA NIM inference (transcribe/vision/reason), base `https://integrate.api.nvidia.com/v1` | `src/lib/server/env.ts:14-18` defaults (`MODEL_TRANSCRIBE`, `MODEL_VISION`, `MODEL_REASON`); `src/lib/server/nim.ts` (OpenAI-compatible `chat`/`chatJson` + retry + `nim_usage` metering, `db/migrations/013_nim_usage.sql`) | build.nvidia.com hosted catalog (credit-metered) |
| 4 | Gemini embeddings only, `gemini-embedding-001`, 768 dims, `batchEmbedContents`, ≤100 texts/batch | `src/lib/server/embed.ts:4,21-36,60` (`EMBED_DIMS = 768`, batch endpoint, batching); `src/lib/server/env.ts:22` (`MODEL_EMBED`) | Google Gemini Developer API (free tier) |
| 5 | Polar billing — **currently OFF and inert** | `.env.example:7` ("ON HOLD — keep 0"); `src/lib/server/env.ts:45` (`BILLING_ENABLED` default `"0"`); `src/lib/server/plans.ts:30-32` (`effectivePlan` returns `"pro"` for everyone while off); `src/lib/server/auth-server.ts:10-34` (no Polar plugin at all when off); `PRICE_USD = 19` (`plans.ts:53`) | Polar (sandbox free / Starter per-transaction) |
| 6 | Cron: 1× daily `0 6 * * *` → `/api/cron/review-sweep`, 50 s internal budget | `vercel.json:4-6`; `src/lib/server/env.ts:19-20` (`SWEEP_LIMIT`, `SWEEP_BUDGET_MS`) | Vercel Cron (or any scheduler) |
| 7 | Auth: better-auth email+password + optional Google OAuth; session needs direct-TCP `pg.Pool` | `src/lib/server/auth-server.ts:42-60` (Pool + providers; Google omitted until credentials exist) | Self-hosted in-app (no vendor fee); Google Cloud OAuth client (free) |
| 8 | Connectors: Google, Slack OAuth; WhatsApp via WAHA (REST + webhook, `X-Api-Key`, token `X-Earcue-Waha-Token`) | `src/lib/server/env.ts:38-44` (connector flags); `src/lib/server/waha.ts:32-47,53-65` (REST client, 15 s timeout, webhook registration with 5 exponential retries) | Google/Slack OAuth (free); WAHA container (free software, needs always-on host + persistent volume) |
| 9 | Extension (Chrome) + `scripts/` (`migrate.mjs`, `seed-admin.ts`, `dev-*` use `pg.Client`) | `extension/`, `scripts/`, `package.json` scripts | No hosting cost (client-side + one-shot CLIs) |

`pg` stays in `dependencies` (`package.json:34`) because `auth-server.ts` and the scripts
need real TCP clients — only `db.ts` uses the Neon HTTP driver. Any host must therefore
allow **outbound TCP to Postgres**, not just HTTPS.

---

## 1. Free-tier mapping (primary sources, read 2026-09-14)

### 1.1 Hosting — Vercel Hobby $0

- **Price:** Hobby $0/mo; Pro $20/mo ([pricing](https://vercel.com/pricing)).
- **Compute allowance:** Hobby = 1M function invocations, 4 Active-CPU-hours, 360 GB-hours
  provisioned memory / month; Pro overage from $0.60/M invocations, $0.128/Active-CPU-hour,
  $0.0106/GB-hour ([pricing](https://vercel.com/pricing)).
  Active CPU meters code execution only, **not** I/O wait on NIM/Neon
  ([functions limitations](https://vercel.com/docs/functions/limitations), "Cost and usage").
  This app's handlers are I/O-bound → steady state (~30 k invocations/mo per 005 §2.1
  arithmetic) is ~3% of the Hobby invocation allowance. **Compute $0 on Hobby at steady state.**
- **Bandwidth:** 100 GB/mo Fast Data Transfer + 10 GB/mo Fast Origin Transfer on Hobby;
  1 TB on Pro ([pricing](https://vercel.com/pricing), [limits](https://vercel.com/docs/limits)
  usage summary). Single-user capture payloads are KB-scale JSON — fits by ~3 orders of
  magnitude, but it is the Hobby meter most likely to bite if polling goes aggressive.
- **Builds:** 45 min max per deployment, 1 concurrent build, Hobby uses basic machines
  "Included" ([limits](https://vercel.com/docs/limits), [pricing](https://vercel.com/pricing)).
  `next build` of this repo fits; no paid build minutes at this scale.
- **maxDuration:** Hobby default **and** maximum 300 s with Fluid compute; the repo's
  `maxDuration = 60` settings fit with 5× headroom
  ([functions limitations](https://vercel.com/docs/functions/limitations)).
- **Function count (the 12-function cap):** plain `api/` deployments are capped at 12
  functions on Hobby, but **Next.js dynamic code is bundled into the fewest functions
  possible** and "it's unlikely that you'll hit the limit"
  ([runtimes](https://vercel.com/docs/functions/runtimes), "Functions created per
  deployment"; [limits](https://vercel.com/docs/limits) marks it "Framework-dependent").
  12 route handlers ≠ 12 functions here. **Not a blocker.**
- **Request body:** 4.5 MB max per function request/response
  ([functions limitations](https://vercel.com/docs/functions/limitations)).
  Extension batches (300 items, `DISTILL_BATCH`) must stay under this — fits today.
- **Filesystem:** read-only except 500 MB `/tmp` scratch
  ([runtimes](https://vercel.com/docs/functions/runtimes)). **WAHA cannot run here**
  (needs persistent `/app/.sessions` + always-on process) — the hard single-platform blocker (§3).
- **Env vars:** 1 000/environment, 64 KB total per deployment
  ([limits](https://vercel.com/docs/limits)). ~20 vars fit trivially.
- **Cron:** included on all plans; **Hobby ≤ once per day**, ±59 min precision; faster
  expressions fail deployment
  ([cron usage & pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing)).
  The repo's single daily `0 6 * * *` fits **exactly**; precision is irrelevant for a nightly sweep.
- **OAuth sign-in (GitHub/Google/GitLab/Bitbucket):** Included on Hobby
  ([pricing](https://vercel.com/pricing)). No fee for the Google sign-in button path.
- **Hobby hard ceiling:** usage caps cannot be topped up — "If you have a free Hobby
  account, you are limited to the usage caps and cannot purchase additional usage"
  ([pricing FAQs](https://vercel.com/pricing)). Over a cap = throttle/suspend until next
  cycle, not a bill. Upgrade path is Pro $20/mo, not à la carte.

### 1.2 Postgres + pgvector — Neon Free $0

- **Free allowance:** 100 CU-hours + 0.5 GB storage + 5 GB egress **per project**;
  hitting any Free limit **suspends compute until the next billing month**
  ([pricing](https://neon.com/pricing), [plans](https://neon.com/docs/introduction/plans)).
- **Paid fallback (cheapest):** Launch = $0.106/CU-hour + $0.35/GB-month storage, no minimum
  ([pricing](https://neon.com/pricing)). At 004's ~32 CU-hours/mo steady state that is
  **≈$3.39 + $0.03 storage ≈ $3.42/mo** (arithmetic from verified rates).
- **pgvector:** `CREATE EXTENSION vector` — "available on every Neon plan with no add-on
  or paid tier required" ([pgvector docs](https://neon.com/docs/extensions/pgvector)).
  HNSW supports `vector` up to 2 000 dims — the repo's `vector(768)` fits.
  **Already migrated and working; zero reason to move.**
- **Scale-to-zero:** forced after 5 min inactivity on Free, cannot be disabled
  ([plans](https://neon.com/docs/introduction/plans)). Consequence: the 1/min health poll
  and 20 s audio flushes keep the compute warm while capturing; overnight idle → cold
  start (seconds) on first morning request. Tolerable for single-user, not for an SLA.
- **Fit:** full backfill ≈ 75 MB (004 §4) < 0.5 GB cap with ~6× headroom; ~32 CU-h/mo <
  100 CU-h with ~3× headroom. **Free fits steady state; backfill + heavy capture months
  are the overflow risk.**

### 1.3 NVIDIA NIM — free credits, finite and non-purchasable

- **Access:** free NVIDIA Developer Program account → API key; NIM containers also
  downloadable with that key or an AI Enterprise license
  ([NIM getting started](https://docs.nvidia.com/nim/large-language-models/latest/getting-started.html)).
  No credit card for the key itself.
- **Metering:** the hosted catalog (`integrate.api.nvidia.com`, the repo's default
  `NIM_BASE_URL`) carries **no published per-token price** — the model page for the repo's
  exact transcription default shows no pricing or credit language
  ([model page](https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning),
  `https://build.nvidia.com/pricing` 404s; both confirmed in 004 §0.1).
- **Credit allowance: UNVERIFIED as of today.** 004 cites an NVIDIA forum thread
  ([thread](https://forums.developer.nvidia.com/t/api-credits-for-build-nvidia-com/306633)):
  1 000 credits on signup, up to 5 000 on request, +4 000 with a business email (90-day
  AI Enterprise eval); credits cannot be bought. I re-requested that thread today and got
  HTTP 429, so I **could not re-verify** — carry these numbers as secondary-source only.
  The credit↔call ratio (≈1 credit/call, model-variable) is likewise **UNVERIFIED**.
- **Why it matters:** 004 §6 shows audio transcription is the credit burner — one NIM call
  per 20 s of kept audio, up to ~4 320 calls/day on `unlimited` (which is what this
  deployment runs, 004 §0.2), exhausting a ~5 000-credit lifetime allowance in **~1 day of
  continuous capture**. Steady-state single-user (~374 calls/day, 004) lasts ~2 weeks per
  5 000 credits. **This is the binding free constraint of the whole system.**
- **Paid fallback:** none at retail — credits are request-only, then self-host NIM (GPU you
  rent) or move inference to a third-party serverless host. There is no "$X/mo NIM plan" to cite.

### 1.4 Gemini embeddings — free tier $0 (verified), exact RPM UNVERIFIED

- **Free tier exists and covers this use case:** "Free input & output tokens", "generous
  limits", Google AI Studio access; the paid upgrade buys higher limits, batch API (50%
  reduction), and no training-on-your-content
  ([Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)).
  004 §6 prices embeddings at ≈$0.04/month upper bound — six orders of magnitude below NIM.
- **`gemini-embedding-001` still supported** for text-only use; `batchEmbedContents` still
  supported ([embeddings docs](https://ai.google.dev/gemini-api/docs/embeddings)).
- **Rate limits:** RPM/TPM/RPD per project, RPD resets midnight Pacific; exact numbers live
  in the reader's AI Studio console and "are not guaranteed" — the docs page lists no fixed
  free-tier RPM for the embedding model
  ([rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)). At ~47 embed
  calls/day (004), any published free tier clears it by ~100×. **Free fits; mark any exact
  "X RPM free" claim UNVERIFIED.**
- **Free-tier cost:** your content may be used to improve Google's products
  ([pricing](https://ai.google.dev/gemini-api/docs/pricing)). For a personal memory corpus,
  note it; paid tier opts out.

### 1.5 Polar billing — $0 while off; Starter free when on

- **Pricing:** Starter **free**, 5.00% + 50¢ per transaction; Pro $20/mo (3.80% + 40¢);
  no monthly fee on Starter ([polar.sh](https://polar.sh/) pricing section, read today).
- **Sandbox:** fully isolated separate environment with its own tokens, test cards
  (`4242 4242 4242 4242`), free to use ([sandbox](https://polar.sh/docs/integrate/sandbox)).
  API rate limits 100 req/min sandbox, 500 req/min production
  ([API overview](https://polar.sh/docs/api-reference/2026-04/introduction)).
- **Repo status:** billing OFF — `effectivePlan` gives every user Pro caps and the Polar
  plugin isn't even registered, so sign-up cannot 500 on a missing token
  (`plans.ts:30-32`, `auth-server.ts:10-34`). **Polar costs exactly $0 until `BILLING_ENABLED=1`,
  and $0/month after (Starter, per-transaction only, and only when someone actually pays).**

### 1.6 Connectors — Google/Slack OAuth free; WAHA software free, hosting is not

- **Google/Slack:** OAuth clients cost nothing; Google sign-in on Vercel Hobby included
  (§1.1). Slack's free workspace tier covers incoming webhooks/Events API at this volume —
  **UNVERIFIED** against current Slack pricing (not re-read today; connector is dormant until
  `SLACK_CLIENT_ID` is set, `env.ts:40-41`).
- **WAHA:** since 2026.6.1, "100% free and open source — all features … no paid tiers and no
  separate Plus image"; single image `devlikeapro/waha`; only paid item is a voluntary
  $5/mo Community tier with "no perks"
  ([FAQ](https://waha.devlike.pro/docs/overview/faq/),
  [WAHA Plus](https://waha.devlike.pro/docs/how-to/waha-plus/),
  [pricing](https://waha.devlike.pro/pricing/)). Every endpoint `waha.ts` calls is Core-free
  (002 §1). Footprint for 1 session: **0.1 CPU / 200 MB** on GOWS/NOWEB
  ([FAQ](https://waha.devlike.pro/docs/overview/faq/), via 002 §2).
- **The catch is hosting, not licensing:** WAHA needs an always-on process + persistent
  `/app/.sessions` + a public URL the app can reach and a webhook URL WAHA can reach
  (002 §3, §7; `waha.ts:22-27`). No serverless platform provides that for $0 durably.

---

## 2. Verdict

### Can it ALL be hosted on ONE platform for free? **No.**

No single $0 offering covers all three shapes this system needs simultaneously:

1. serverless web + daily cron (Vercel Hobby does this), **plus**
2. serverless Postgres + pgvector (Neon Free does this), **plus**
3. an always-on stateful container with a persistent volume (WAHA).

Vercel has no always-on container/volume primitive on any plan feature list
([pricing](https://vercel.com/pricing), [runtimes](https://vercel.com/docs/functions/runtimes));
Neon is a database, not a container host. Any "one platform" answer (a VPS with Docker:
app + Postgres + WAHA on one box) ceases to be free at the always-on compute layer —
there is no primary-source $0 always-on VM with a persistent disk to cite, so that path is
**not verified free**.

### Can it be hosted for $0 across free tiers? **Partial yes — with two finite meters and one homeless container.**

| Piece | Free home | Verdict |
|---|---|---|
| Next.js app + daily cron | Vercel Hobby | ✅ fits (§1.1) |
| Postgres + pgvector HNSW | Neon Free | ✅ fits steady state (§1.2) |
| Embeddings | Gemini free tier | ✅ fits by ~100× (§1.4) |
| Billing | Polar off / Starter / sandbox | ✅ $0 (§1.5) |
| Auth | better-auth self-hosted + free OAuth clients | ✅ $0 (§1.1, `auth-server.ts`) |
| NIM inference | build.nvidia.com credits | ⚠️ **finite, non-renewable, non-purchasable** (§1.3) |
| WhatsApp (WAHA) | — | ❌ **no free always-on container home on the chosen stack** (§1.6) |

So: everything except **NIM longevity** and **WAHA's bed** is free indefinitely at
single-user steady state. Those are the bottlenecks, ranked:

1. **NIM credits (binding).** ~5 000–9 000 lifetime calls vs ~374/day steady state, up to
   ~4 320/day continuous capture (004 §6). Exhaustion bricka **all** inference —
   transcribe, vision, watch, assist, review, distill. No retail fallback; fallbacks are
   request-more-credits → self-host NIM on rented GPU → migrate inference provider (code
   change: `nim.ts` is OpenAI-compatible, so a provider swap is contained).
2. **WAHA has no free bed.** Options, cheapest first: (a) run WAHA on hardware you already
   own (home server/RPi — electricity only, **UNVERIFIED** as a recommendation, no source);
   (b) cheapest paid container/VM with a small persistent disk — re-price at decision time
   (005 §2 surveyed paid options; no free tier re-verified here); (c) leave WhatsApp
   disconnected — the connector is optional (`WAHA_BASE_URL` unset hides it, `env.ts:42`).
3. **Neon Free caps (distant third).** 0.5 GB / 100 CU-h / 5 GB egress per project; breach =
   suspended until next month, not a bill. Cheapest fallback: Launch ≈ **$3.42/mo** at
   current volume (arithmetic, §1.2).
4. **Vercel Hobby caps (fourth).** Bandwidth 100 GB and the no-top-up rule are the ones to
   watch; cron (1/day exactly), functions bundling, and 300 s maxDuration all fit today.
   Fallback: Pro **$20/mo** ([pricing](https://vercel.com/pricing)).

### Cheapest-paid-fallback summary (per bottleneck)

| Bottleneck | First paid step | Price (primary source) |
|---|---|---|
| NIM credits exhausted | Request more → rented-GPU self-host → provider migration | No retail price exists (UNVERIFIED future cost) |
| WAHA needs a bed | Smallest always-on container/VM + disk | Re-price at decision time (005's paid survey is 2026-09-14, not re-verified here) |
| Neon Free overflow | Neon Launch | $0.106/CU-h + $0.35/GB-mo ([pricing](https://neon.com/pricing)) ≈ $3.42/mo |
| Vercel Hobby overflow | Vercel Pro | $20/mo ([pricing](https://vercel.com/pricing)) |
| Polar (when billing on) | Polar Starter | $0/mo + 5.00% + 50¢/txn ([polar.sh](https://polar.sh/)) |

---

## Sources (primary, all accessed 2026-09-14 unless noted)

- [Vercel pricing](https://vercel.com/pricing) — Hobby $0 / Pro $20; 1M invocations, 4 CPU-h, 360 GB-h, 100 GB transfer; cron included; no top-up on Hobby
- [Vercel functions limitations](https://vercel.com/docs/functions/limitations) — 300 s Hobby max; 4.5 MB body; Active CPU excludes I/O wait
- [Vercel cron usage & pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing) — Hobby 1/day, ±59 min, 100/project
- [Vercel runtimes](https://vercel.com/docs/functions/runtimes) — Next.js bundling ("unlikely to hit the limit"); read-only FS + 500 MB `/tmp`
- [Vercel limits](https://vercel.com/docs/limits) — framework-dependent function cap; 64 KB env; 45 min builds; usage summary
- [Neon pricing](https://neon.com/pricing) — Free 100 CU-h / 0.5 GB / 5 GB egress per project; suspend-on-breach; Launch $0.106/CU-h + $0.35/GB-mo
- [Neon plans](https://neon.com/docs/introduction/plans) — forced 5-min scale-to-zero on Free; branch/storage rules
- [Neon pgvector](https://neon.com/docs/extensions/pgvector) — every plan, no add-on; HNSW `vector` ≤ 2 000 dims
- [NVIDIA NIM getting started](https://docs.nvidia.com/nim/large-language-models/latest/getting-started.html) — free Developer Program key access
- [nemotron-3-nano-omni-30b-a3b-reasoning model page](https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning) — no pricing/credit language (via 004 §0.1)
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) — free tier, free I/O tokens; paid upgrade terms
- [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) — per-project RPM/TPM/RPD, midnight-PT reset, AI-Studio-held numbers
- [Gemini embeddings](https://ai.google.dev/gemini-api/docs/embeddings) — `gemini-embedding-001` + `batchEmbedContents` still supported
- [Polar homepage pricing](https://polar.sh/) — Starter $0 + 5.00% + 50¢; Pro $20; sandbox + test cards
- [Polar sandbox](https://polar.sh/docs/integrate/sandbox) — isolated env, own tokens, Stripe test cards
- [Polar API overview](https://polar.sh/docs/api-reference/2026-04/introduction) — 500/min prod, 100/min sandbox
- [WAHA FAQ](https://waha.devlike.pro/docs/overview/faq/) — 100% free since 2026.6.1; 0.1 CPU / 200 MB single session (via 002 §2)
- [WAHA Plus](https://waha.devlike.pro/docs/how-to/waha-plus/) / [pricing](https://waha.devlike.pro/pricing/) — Plus retired; $5 Community voluntary
- Repo: `package.json`, `vercel.json`, `next.config.ts`, `.env.example`, `src/lib/server/env.ts`, `src/lib/server/db.ts`, `src/lib/server/auth-server.ts`, `src/lib/server/nim.ts`, `src/lib/server/embed.ts`, `src/lib/server/entitlement.ts`, `src/lib/server/quota.ts`, `src/lib/server/plans.ts`, `src/lib/server/waha.ts`, `db/migrations/008_knowledge.sql`, `db/migrations/013_nim_usage.sql`, `src/app/api/**/route.ts`
- Prior notes: `.wayfinder/research/004-cost-model.md`, `.wayfinder/research/005-hosting-comparison.md`, `.wayfinder/research/002-waha-facts.md`

### UNVERIFIED items (could not confirm from a primary source today)

- NVIDIA credit balances (1 000 / 5 000 / +4 000), credit↔call ratio, 40 RPM limit — secondary-source via 004; forum re-fetch returned HTTP 429 today
- Exact Gemini free-tier RPM/TPM for `gemini-embedding-001` — held in the reader's AI Studio console, not published
- `gemini-embedding-001` paid per-token rate — absent from the pricing page (004 used `gemini-embedding-2` $0.20/M as upper bound)
- Slack free-tier sufficiency for the connector volume — Slack pricing not re-read
- Any $0 always-on VM/container with persistent disk for WAHA — no primary-source free offering cited
- Audio/image per-call token counts in 004's arithmetic — estimated from prompt structure; `nim.ts` returns `usage` but every caller discards it
