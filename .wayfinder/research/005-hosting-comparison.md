# 005 — Hosting comparison: where earcue + WAHA should run

Research output for `.wayfinder/tickets/007-waha-hosting-decision.md`. **Facts + a
recommendation.** Every non-trivial claim is cited to a primary source (official docs,
official pricing pages, the Azure retail-prices API, or repo `file:line`) with access
date, or marked **UNVERIFIED**.

Read date: 2026-09-14. All prices USD unless noted, US East / iad region where the
provider varies by region. Azure figures use `eastus` from the retail API.

---

## 0. Assumptions up front

1. **Single user, steady state from 004.** ~374 NIM calls/day, ~47 Gemini embed
   calls/day, ~32 Neon CU-hours/month, ~75 MB storage after a full backfill, one
   60 s cron pass/night (`.wayfinder/research/004-cost-model.md` §3–§4). Inference
   cost (~$0.37/day market-proxy) and the NVIDIA credit meter are host-independent
   and excluded from every total below — hosting changes where code runs, not what
   the models cost.
2. **The app stays as-is:** Next.js 16 App Router, `engines: node 22.x`
   (`package.json:6-8`), `next build` + `next start` scripts present
   (`package.json:10-16`). Any host that runs Node 22 or Docker runs it with zero
   code change.
3. **WAHA is mandatory and always-on.** One session, GOWS or NOWEB engine preferred
   (0.1 CPU / 200 MB for 1 session), `/app/.sessions` on a persistent volume,
   bidirectional reachability: app → WAHA REST, WAHA → app webhook
   (`.wayfinder/research/002-waha-facts.md` §2, §3, §7). WAHA webhook delivery is
   best-effort with no durable queue — ~5 retries over ~62–75 s, then the event is
   gone (002 §5). The host must therefore keep WAHA alive, not just startable.
4. **Neon stays unless stated.** pgvector HNSW over `vector(768)` is already migrated
   (`db/migrations/008_knowledge.sql:32,42` per 004 §2). Moving Postgres means
   re-proving pgvector + HNSW on the new host.
5. **Azure context:** tenant `Default Directory` has zero accessible subscriptions
   today. Any Azure option requires a new subscription + billing instrument first —
   that setup cost is real and counted in operational burden, not in dollars.
6. **"Verified"** = I read the number on an official page/API today. Anything
   computed from verified rates is labeled arithmetic. Anything from a JS-rendered
   page I could not read, a search snippet, or general knowledge is **UNVERIFIED**.

---

## 1. What the repo demands of any host

| Requirement | Source | Consequence |
| 12 route handlers, 8 with `export const maxDuration = 60` | `src/app/api/*/route.ts` (glob 12 routes; grep 2026-09-14: 8 set `maxDuration = 60`) | Serverless host must allow 60 s invocations; the Hobby-era 12-function dispatcher pattern (`README.md:37-39`) is now harmless baggage on hosts without a function cap |
| Node 22.x | `package.json:6-8` | Host needs Node 22 runtime or Docker |
| Daily cron `0 6 * * *` → `/api/cron/review-sweep`, 50 s internal budget | `vercel.json:4-6`, `src/lib/server/env.ts:19-20` | Host needs one daily scheduled invocation with ≥60 s timeout |
| Request bodies up to extension batches of 300 items / 4 MB bodies | `src/lib/server/env.ts` defaults; 004 §1.3 | Serverless body cap must clear ~4 MB (Vercel's is 4.5 MB — tight but fits) |
| ~20 env vars, 6 required, lazy fail-fast validation | `src/lib/server/env.ts:3-10`, `.env.example` | Host needs a secrets manager; nothing exotic |
| Postgres + pgvector HNSW, 768 dims | 004 §2 | Neon already works; alternatives must prove `CREATE EXTENSION vector` + HNSW |
| WAHA container, persistent `/app/.sessions`, public HTTPS in + outbound HTTPS out | 002 §3, §7 | Host must run a second always-on container/service with a volume and a public URL |
| Health endpoint polled ~1/min, authorized variant | `README.md:103-116` | No special need, but scale-to-zero hosts pay a wake per poll if the poller hits the app host |

---

## 2. Per-option facts

### 2.1 Vercel (current) — Hobby $0 / Pro $20/mo

- **Price (verified):** Hobby $0/mo; Pro $20/mo
  (https://vercel.com/pricing, accessed 2026-09-14).
- **Functions budget (verified):** Hobby includes 1M invocations, 4 Active-CPU-hours,
  360 GB-hours provisioned memory per month; overage on Pro is $0.60/M invocations,
  from $0.128/Active-CPU-hour, from $0.0106/GB-hour
  (https://vercel.com/pricing and https://vercel.com/docs/limits, accessed 2026-09-14).
  Active CPU meters only code execution, **not** I/O wait on NIM/Neon
  (https://vercel.com/docs/functions/limitations, "Cost and usage", accessed 2026-09-14) —
  this app's handlers are I/O-bound, so the 4 CPU-hour allowance is generous.
- **Steady-state fit (arithmetic from verified allowances):** a capture-heavy day is
  ~600–1 000 invocations (004 §3: audio flushes every 20 s, watch 1/min, suggest
  1/3 min, 24 hourly extension syncs). A month of heavy days is ~30 k invocations —
  3% of the Hobby allowance. **Vercel compute is $0 at steady state on Hobby.**
- **maxDuration (verified):** with Fluid compute (default on new projects since
  2025-04-23), Hobby default **and** maximum is 300 s; Pro/Enterprise 300 s default,
  800 s max, 1800 s beta
  (https://vercel.com/docs/fluid-compute, https://vercel.com/docs/functions/limitations,
  both accessed 2026-09-14). The repo's 60 s settings fit Hobby with 5× headroom.
  Note: pre-Fluid Hobby max was 60 s (same limits page) — the 60 s convention in
  `route.ts` files is a leftover of that era, not a current constraint.
- **Cron (verified):** included on all plans; **Hobby may run cron at most once per
  day** with ±59 min scheduling precision; expressions more frequent than daily fail
  deployment (https://vercel.com/docs/cron-jobs/usage-and-pricing, accessed
  2026-09-14). The repo's single daily `0 6 * * *` sweep fits exactly. Precision
  (±59 min) does not matter for a nightly review.
- **Function cap (verified, and good news):** the README's 12-function dispatcher
  pattern (`README.md:37-39`) exists because plain-API deployments are capped at 12
  functions on Hobby — but **Next.js/SvelteKit dynamic code is bundled into the
  fewest functions possible** and "it's unlikely that you'll hit the limit"
  (https://vercel.com/docs/functions/runtimes, "Functions created per deployment",
  accessed 2026-09-14). The dispatchers are harmless but no longer load-bearing.
- **Node 22 (verified):** 20.x, 22.x, 24.x (default) all available; `engines.node`
  in `package.json` overrides project settings
  (https://vercel.com/docs/functions/runtimes/node-js/node-js-versions, accessed
  2026-09-14). Repo pins `22.x` (`package.json:7`) — runs unchanged.
- **Request body (verified):** 4.5 MB max per function request/response
  (https://vercel.com/docs/functions/limitations, accessed 2026-09-14). Extension
  batches of 300 items must stay under this — fits today, worth knowing if batch
  size ever grows.
- **Filesystem (verified):** read-only except 500 MB `/tmp` scratch
  (https://vercel.com/docs/functions/runtimes, accessed 2026-09-14). **WAHA cannot
  run on Vercel Functions** — no persistent `/app/.sessions`, no always-on process.
  WAHA must live elsewhere in every Vercel scenario.
- **Env/secrets (verified):** 1 000 vars/environment, 64 KB total per deployment
  (https://vercel.com/docs/limits, accessed 2026-09-14). ~20 vars fit trivially.
- **WAHA fit:** none natively. Vercel → WAHA needs a public WAHA URL + API key
  (002 §7); WAHA → Vercel webhook needs only outbound HTTPS, which every host has.
  Cannot IP-allowlist Vercel (dynamic egress; static IPs are Enterprise-only) per
  002 §7 — API key is the only access control on Hobby/Pro.

### 2.2 Neon (current) — Free $0 / Launch pay-as-you-go

- **Price (verified):** Free: 0.5 GB storage + 100 CU-hours/project, then compute
  suspends until next cycle. Launch: **$0.106/CU-hour** + **$0.35/GB-month**, no
  minimum. Scale-to-zero after 5 min inactivity by default
  (https://neon.com/pricing, accessed 2026-09-14).
- **Steady-state fit (arithmetic from 004 §3):** ~32 CU-hours/mo → **inside Free**;
  on Launch = 32 × $0.106 = **$3.39/mo** + ~$0.03 storage. Verified rates, 004
  arithmetic.
- **pgvector (verified):** `CREATE EXTENSION vector;` — available on every plan, no
  add-on (https://neon.com/docs/extensions/pgvector, accessed 2026-09-14). Already
  migrated and working; zero reason to move.
- **Backfill headroom (arithmetic from 004 §4):** full 38 k-item backfill ≈ 75 MB —
  inside Free's 0.5 GB. Free only breaks if the corpus grows ~7× or compute exceeds
  100 CU-hours (roughly 3× current capture volume).

### 2.3 Fly.io — Machines from $1.94/mo + volumes; Managed Postgres from $38/mo

- **Compute (verified):** `shared-cpu-1x · 256MB` = **$1.94/mo** (iad/ewr; ×1.038–1.615
  elsewhere), billed by the second while running; extra RAM $5.00/GB-mo
  (https://fly.io/pricing/, accessed 2026-09-14). A Next.js `next start` wants
  ~512 MB–1 GB in practice → `shared-cpu-2x · 512MB` **$3.89/mo** or
  `shared-cpu-4x · 1GB` **$7.78/mo** (same source). A GOWS WAHA (200 MB) fits the
  $1.94 slot.
- **Volumes (verified):** **$0.15/GB-mo** on provisioned capacity, billed hourly
  whether the machine runs or not (https://fly.io/pricing/, accessed 2026-09-14).
  1–2 GB for WAHA sessions = $0.15–0.30/mo. Exactly the `/app/.sessions` primitive
  002 §3 needs.
- **Egress (verified):** $0.02/GB North America + Europe (same source). Irrelevant at
  single-user scale.
- **Managed Postgres (verified):** Basic plan `shared-2x · 1GB` = **$38/mo** +
  storage **$0.28/GB** (same source). ~20× Neon Launch for this workload — never
  buy it for earcue; the sensible Fly shape keeps Neon.
- **Idle behavior (verified):** autostop/autostart Machines exist as a documented
  feature (https://fly.io/docs/launch/autostop-autostart/, exists 2026-09-14; page
  body is JS-rendered so wake-latency specifics are **UNVERIFIED**). WAHA must NOT
  autostop (session liveness); the web app may.
- **Next.js fit (verified):** official `nextjs/deploy-fly` template; Docker
  deployments support all Next.js features
  (https://nextjs.org/docs/app/getting-started/deploying, accessed 2026-09-14).
  Cron = either a second always-on Machine running a scheduler (wasteful) or an
  external ping of an endpoint — no native cron. The daily sweep would move to a
  scheduled Machine start or a cron-job Machine (`fly` supports scheduled
  machines; exact pricing = ordinary Machine seconds — **UNVERIFIED** whether
  `schedule:` machines are GA on the reader's org; treat as ordinary compute).
- **WAHA fit:** excellent. One $1.94 Machine + $0.15 volume + public `*.fly.dev`
  URL with TLS. Both directions trivially satisfied.
- **Cheapest sensible Fly shape (arithmetic):** app `shared-cpu-2x` $3.89 + 2 GB
  volume $0.30 + WAHA $1.94 + 1 GB volume $0.15 + Neon Free $0 = **≈$6.30/mo**,
  all rates verified.

### 2.4 Railway — Hobby $5 (incl. $5 usage); CPU $20/vCPU-mo, RAM $10/GB-mo, vol $0.15/GB-mo

- **Price (verified):** Hobby $5/mo including $5 usage; Pro $20/mo including $20
  usage; usage billed per second. Memory **$10/GB-mo**, CPU **$20/vCPU-mo**,
  volumes **$0.15/GB-mo**, service egress **$0.05/GB**
  (https://railway.com/pricing, accessed 2026-09-14).
- **Postgres (verified):** deploy-from-template Postgres based on the official
  Docker image; **pgvector is NOT in the default template** — available via a
  separate marketplace template (`pgvector`)
  (https://docs.railway.com/databases/postgresql, accessed 2026-09-14). Self-managed
  (backups/observability are the user's templates), and it bills like any other
  service (RAM + CPU + volume per second). Keeping Neon avoids all of this.
- **Steady-state arithmetic (rates verified, sizing mine):** app always-on 0.5 vCPU
  ($10) + 512 MB ($5) ≈ $15 usage; WAHA GOWS 0.1 vCPU ($2) + 256–512 MB ($2.50–5)
  + 1 GB volume ($0.15) ≈ $5–7 usage. Total ≈ $20–22 usage on Hobby $5 → roughly
  **$20–25/mo all-in with Neon**, or +$8–15/mo for self-hosted Postgres instead of
  Neon. Railway never sleeps services on paid plans (no sleep stated on pricing
  page; free-plan sleep specifics **UNVERIFIED** — irrelevant, free tier caps at
  1 vCPU/0.5 GB/3-day logs and is not the target).
- **Cron:** scheduled cron-service executions are a documented Railway feature;
  per-second billing applies — exact cron UX not re-verified today, treat
  mechanics as **UNVERIFIED**, cost as ordinary compute seconds.
- **WAHA fit:** good. Persistent volumes + public domains + always-on are all
  first-class. Both reachability directions fine.

### 2.5 Render — Starter web $7/mo; Postgres from $6/mo; disks $0.25/GB-mo

- **Price (verified):** web Starter 512 MB/0.5 CPU **$7/mo**, Standard 2 GB/1 CPU
  **$25/mo**; Postgres Basic-256mb **$6/mo**, Basic-1gb **$19/mo**; SSD disks
  **$0.25/GB-mo**; Hobby workspace bandwidth 5 GB then $0.15/GB
  (https://render.com/pricing, accessed 2026-09-14).
- **Minimal sensible shape (arithmetic):** app Starter $7 + WAHA Starter $7 + 2 GB
  disk $0.50 + Neon Free $0 = **≈$14.50/mo**; comfortable shape (Standard app $25 +
  managed PG Basic-1gb $19 instead of Neon) ≈ **$51/mo**. 512 MB for Next.js
  production is tight — Starter is a gamble, Standard is the honest pick.
- **Idle behavior:** Render free-tier services spin down on inactivity — the free
  plan page could not be fetched today (https://docs.render.com/free-plan → 404
  via reader), so sleep specifics are **UNVERIFIED**. Paid instances stay up.
  WAHA must be paid-tier regardless.
- **Cron:** native cron jobs billed per minute per instance tier (pricing page
  lists Cron Jobs from $1/mo, Starter $0.00016/min). The daily 60 s sweep ≈
  **$0.07/mo** (arithmetic) — cheapest cron of any option, but it shells to a
  command, so the sweep would need an HTTP-call wrapper.
- **WAHA fit:** good — Docker web/private service + disk + public URL. Same
  bidirectional story as Railway/Fly.

### 2.6 Azure Container Apps (Consumption) — verified per-second rates

Retail API (`https://prices.azure.com/api/retail/prices`, queried 2026-09-14,
`eastus`, USD), all **verified**:

| Meter | Rate |
|---|---|
| vCPU active (`Standard vCPU Active Usage`) | **$0.000024/vCPU-s** |
| Memory active (`Standard Memory Active Usage`) | **$0.000003/GiB-s** |
| vCPU idle (`Standard vCPU Idle Usage`) | **$0.000003/vCPU-s** (8× cheaper than active) |
| Memory idle (`Standard Memory Idle Usage`) | **$0.000003/GiB-s** (same as active) |
| Requests (`Standard Requests`) | **$0.40/M** |
| Free grant/subscription/mo | 180,000 vCPU-s + 360,000 GiB-s + 2 M requests |

Billing model (verified): per-second allocation billing; **$0 while scaled to
zero**; min-replicas > 0 bills idle rate when CPU < 0.01 core and net < 1 000 B/s
(https://learn.microsoft.com/en-us/azure/container-apps/billing, accessed
2026-09-14). KEDA HTTP/TCP/custom scalers; min/max replicas per revision
(…/scale-app, accessed 2026-09-14). Scheduled work is a **Container Apps Job**
with a cron expression, UTC, billed active-rate only while executing (…/jobs,
accessed 2026-09-14) — the daily sweep maps cleanly.

- **Steady-state arithmetic (verified rates, sizing mine):** app `0.5 vCPU / 1 GiB`,
  min-replicas 0, single-user traffic ≈ always idle-or-zero between requests.
  If run 24 h at idle as the safe always-warm case: vCPU 0.5 × 0.000003 × 2.628M s
  = $3.94 + mem 1 × 0.000003 × 2.628M s = $7.88 → **≈$11.80/mo** minus a small free
  grant. Realistic with scale-to-zero: a few dollars. Requests: ~30 k/mo, inside
  the 2 M grant → $0.
- **WAHA arithmetic:** must be min-replicas 1 (session liveness — scale-to-zero
  would drop the WhatsApp connection). Same 0.5/1 GiB shape → **≈$11.80/mo** at
  idle, mostly memory. Plus **Azure Files** for `/app/.sessions` — persistent
  storage on ACA is Azure Files mounts only
  (https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts, accessed
  2026-09-14); ephemeral EmptyDir dies with the replica. Files pricing is
  provisioned-IOPS/throughput based and JS-rendered (page returned `$-`
  placeholders) → **≈$1–3/mo UNVERIFIED**.
- **Postgres:** Flexible Server burstable **B1MS (1 vCore / 2 GiB) $0.017/hr =
  ≈$12.41/mo** (verified, retail API eastus). pgvector supported: allowlist
  `vector` in `azure.extensions`, then `CREATE EXTENSION vector`
  (https://learn.microsoft.com/en-us/azure/postgresql/extensions/how-to-use-pgvector
  and …/how-to-allow-extensions, accessed 2026-09-14). Storage $/GB not captured
  → **UNVERIFIED, budget ~$2/mo**. Note B1MS burstable credits can throttle under
  sustained load — fine for one user, **UNVERIFIED** at backfill pace.
- **ACA total (arithmetic):** ≈$12 (app) + $12 (WAHA) + $2 (Files, UNVERIFIED) +
  $12.41 (PG) + $2 (PG storage, UNVERIFIED) + ~$0 bandwidth (first 100 GB/mo free,
  verified https://azure.microsoft.com/en-us/pricing/details/bandwidth/) ≈
  **$38–42/mo**, vs $3.39/mo for the same Postgres+compute on Neon+free hosts.
- **Burden:** new subscription + billing, resource group, environment, registry,
  two container apps, Files share, Postgres allowlist, cron job, TLS (managed,
  but configured). Highest setup cost of the container options.

### 2.7 Azure App Service (Linux) — B1 ~$13/mo UNVERIFIED

- **Price:** official page renders `$-` placeholders via JS (accessed 2026-09-14,
  unusable). Secondary sources put **B1 (1 core / 1.75 GB) ≈ $13.14/mo** —
  **UNVERIFIED**. Verified anchor from the retail API: Premium v4 P1mv4
  $0.278/hr ≈ $203/mo (proves the API path works; B1 meter simply wasn't
  returned under the queried sku filter). **Do not budget App Service on my word —
  read the number in the portal calculator.**
- **Fit notes:** single-tenant-ish plan hosts app + WAHA containers with Always On
  (plan-sharing and Always-On tier requirements **UNVERIFIED** — confirm in
  https://learn.microsoft.com/en-us/azure/app-service/overview-hosting-plans).
  Persistent `/app/.sessions` needs a mounted Files share or local disk that does
  not survive scale/rebuild the way a volume does — restore story weaker than
  Fly/Railway/Render volumes. Cron via WebJobs or an external trigger. Postgres =
  same B1MS as §2.6.
- **Total: UNVERIFIED, ≈$13 (plan) + $12.41 (PG) + extras ≈ $27–32/mo**, all but
  the PG compute unverified. Only interesting as "one plan, two apps" if the B1
  number confirms.

### 2.8 Azure VM — B1s Linux $0.0104/hr ≈ $7.59/mo (verified); AKS — dismissed

- **VM (verified, retail API eastus):** `Standard_B1s` Linux **$0.0104/hr =
  ≈$7.59/mo** + managed disk + public IP + 100 GB free egress then $0.087/GB
  (bandwidth page, verified). A B2s (2 vCPU, the WAHA vendor minimum shape) was
  not queried → **UNVERIFIED, ≈$15/mo by series**. Docker Compose with Caddy for
  TLS: app + WAHA + self-hosted Postgres + pgvector image on one box ≈ **$8–17/mo
  verified-compute + UNVERIFIED disk/IP**. Cheapest Azure shape, maximum burden
  (OS patching, backups, TLS, Postgres ops — you are the SRE).
- **AKS (verified as overkill):** Free tier control plane exists (pay nodes only);
  Standard/Premium control-plane fees render as `$-` placeholders (accessed
  2026-09-14). A cluster for one user + one bot is unjustifiable on cost and
  burden. Dismissed; revisit only past 10+ services.

### 2.9 Cheap VPS (Hetzner / DigitalOcean) — verified floor $24/mo at DO

- **DigitalOcean (verified):** Basic 2 vCPU / 4 GiB / 80 GB / 4 TB transfer =
  **$24/mo**; 2 vCPU / 2 GiB = **$18/mo**
  (https://www.digitalocean.com/pricing/droplets, accessed 2026-09-14).
- **Hetzner (mixed):** EU boxes include **20 TB traffic** (verified,
  https://www.hetzner.com/cloud/regular-performance/, accessed 2026-09-14) but
  plan prices render via JS — CX22 (2 vCPU / 4 GB) commonly €3.79–5.49/mo across
  secondary sources → **UNVERIFIED, budget ≈€5/mo**. Matches the 002-research
  finding (DO $24 verified, Hetzner secondary-only).
- **Fit:** identical to an Azure VM operationally (Compose + Caddy + self-hosted
  Postgres), at 1/3–1/5 the Azure VM price on Hetzner. WAHA vendor minimum
  (2 vCPU / 4 GB per 002 §8) is natively satisfiable. Burden is the product: you
  own patching, Postgres backups/PITR, TLS renewal, disk growth, and incident
  response.

---

## 3. Cost table — single-user steady state, per month

Verified rates; arithmetic shown so it can be re-run. Inference excluded
(host-independent).

| Shape | App compute | WAHA | Postgres | Cron | Egress/volumes | **Total** | Status |
|---|---|---|---|---|---|---|---|
| **A. Vercel Hobby + Neon Free + WAHA on Fly** (recommended) | $0 (3% of Hobby allowance) | $1.94 + $0.15 vol | $0 (inside Free) | $0 (daily cron incl.) | ~$0 | **≈$2.10** | verified rates |
| B. Vercel Hobby + Neon Free + WAHA on Hetzner CX22 | $0 | ~€4.35 | $0 | $0 | incl. 20 TB | **≈€4.50** | WAHA price UNVERIFIED |
| C. Vercel Pro + Neon Launch + WAHA on Fly | $20 + ~$0 usage | $2.09 | $3.39 + $0.03 | $0 | ~$0 | **≈$25.50** | verified rates |
| D. Fly all-in + Neon Free (app 2x + WAHA 1x) | $3.89 + $0.30 | $1.94 + $0.15 | $0 | ~$0 (scheduled machine s) | ~$0 | **≈$6.30** | verified rates; cron mechanics UNVERIFIED |
| E. Railway + Neon Free | ~$15 usage + $5 fee | ~$5–7 usage | $0 | ordinary seconds | ~$0 | **≈$20–25** | verified rates; sizing arithmetic |
| F. Render honest shape + Neon Free (Standard $25 + WAHA $7 + disk) | $25 | $7.50 | $0 | $0.07 | ~$0 | **≈$32.50** | verified rates |
| G. Azure Container Apps + B1MS PG + Files | ~$12 idle | ~$12 idle | $12.41 + ~$2 | ~$0 | $0 (≤100 GB) | **≈$38–42** | compute/PG verified; Files + storage UNVERIFIED |
| H. App Service B1 + B1MS PG | ~$13 | shares plan (?) | $12.41 | ~$0 | ~$0 | **≈$27–32** | **mostly UNVERIFIED** |
| I. Single VPS (Hetzner CX22, self-hosted PG) | shares box | shares box | self-hosted $0 | $0 | incl. | **≈€5** | **price UNVERIFIED** |
| J. Azure VM B1s + self-hosted PG | shares box $7.59 | shares box | self-hosted $0 | $0 | + disk/IP | **≈$9–12** | compute verified; disk/IP UNVERIFIED |

Cold-start backfill shape (004 §4: one-off ≈384 NIM calls, ~75 MB, drainable via
24 manual distill POSTs/day): adds **no host cost** on A–F (inside allowances);
on G it is one night of active-rate burn ≈ **$0.50 UNVERIFIED arithmetic**; on
I/J it is free but slow (B1s/B1MS CPU at distill pace — throughput, not money).

---

## 4. WAHA fit per option (always-on + volume + webhook)

| Option | Always-on primitive | Volume primitive | Public URL + TLS | Webhook risk |
|---|---|---|---|---|
| A/B/C (Vercel + external WAHA) | Fly Machine min-1 / VPS systemd | Fly volume $0.15/GB / VPS disk | `*.fly.dev` auto-TLS / Caddy | none beyond 002 §5 baseline |
| D (Fly all-in) | same as above | same | same | none |
| E (Railway) | paid services don't sleep | Railway volume $0.15/GB | Railway domain auto-TLS | none |
| F (Render) | paid instances stay up | Render disk $0.25/GB | Render URL auto-TLS | none |
| G (ACA) | minReplicas 1, idle billing | **Azure Files mount only** — SMB/NFS share config, no plain volume | managed ingress + TLS | replica recycle loses in-flight webhook (no queue — 002 §5); Files latency on session restore **UNVERIFIED** |
| H (App Service) | Always On (tier-gated, UNVERIFIED) | Files mount or ephemeral local — weakest restore story | managed TLS | recycle during deploy drops in-flight events |
| I/J (VPS/VM) | systemd/Docker restart policy | local disk (backup = your snapshots) | Caddy/Traefik | none, fewest moving parts |

Engine choice interacts: GOWS/NOWEB (0.1 CPU / 200 MB) fit the $1.94 Fly slot
and Railway's small services; WEBJS (0.3 CPU / 400 MB + Chromium spikes) wants
the Hetzner/DO 2 vCPU shape or ACA 0.5+ vCPU. Vendor minimum stays 2 vCPU / 4 GB
regardless (002 §8). **Pin GOWS** for any container-platform placement.

---

## 5. Ease-of-use ranking (easiest first)

1. **A — Vercel Hobby + Neon Free + Fly WAHA.** Nothing moves; one new 2-file Fly
   app (`Dockerfile` + `fly.toml`) for the WAHA image with a 1 GB volume.
   Env changes only: `WAHA_BASE_URL`, `WAHA_API_KEY`, `WAHA_WEBHOOK_BASE_URL`.
2. **E — Railway.** `railway init` from the repo + WAHA template + volume; env via
   dashboard. Loses to A on price (~10×) and on Postgres (Neon still external or
   a self-managed template).
3. **F — Render.** Blueprint `render.yaml` for web + WAHA + disk; native cron is
   nicest here. Loses on the $25 honest-tier app cost and tight Starter RAM.
4. **D — Fly all-in.** Two apps + volumes via `fly launch`; Dockerfile the Next
   standalone output. Loses on cron DIY and on Postgres staying external anyway —
   if Neon stays, D is just A with the app moved for $4/mo more and no benefit.
5. **G — Azure Container Apps.** Subscription + billing setup dominates; then
   environment/registry/apps/Files/PG-allowlist/jobs. Best Azure-native answer,
   still 18× the cost of A.
6. **H — App Service.** Only if the B1 number confirms AND plan-sharing confirms;
   both UNVERIFIED today.
7. **I/J — VPS/VM.** Cheapest absolute (€5), full SRE burden: patching, Postgres
   backup/PITR (Neon's 6 h window and PITR are currently free features of staying),
   TLS, disk, on-call. Rational only as a cost-floor reference or a second life
   for existing hardware.
8. **AKS.** Dismissed (§2.8).

---

## 6. Recommendation

**Stay on Vercel Hobby + Neon Free. Put WAHA on Fly.io:**
`shared-cpu-1x · 256MB` ($1.94/mo, iad) + 1 GB volume ($0.15/mo), GOWS engine,
`WAHA_WEBHOOK_BASE_URL=https://<app>.vercel.app`, API key as the only auth
(dynamic Vercel egress can't be allowlisted — 002 §7). **Total ≈$2.10/mo, all
rates verified.** No code migration, no database move, no subscription paperwork,
cron and 60 s handlers already fit Hobby with headroom (§2.1), Neon Free has ~3×
compute and ~7× storage headroom left.

**Step 2, only if triggered (see kill criteria): Vercel Pro ($20) + Neon Launch
($3.39)** — same topology, removes every Hobby ceiling at ≈$25.50/mo. Never
re-platform to fix a quota; buy the next tier of the same platform first.

**Azure verdict:** do not move. The cheapest honest Azure shape (G, ≈$38–42/mo)
costs 18× the recommendation while adding a subscription, Files-share session
storage (weaker restore story than a plain volume), and allowlist-gated pgvector
— all to recreate what already runs. Azure becomes rational only if an external
constraint (org tenancy, compliance, credits) forces it; then choose **Container
Apps + B1MS**, never AKS, and confirm the Files + B1MS-storage numbers in the
portal first.

### Kill criteria — when to abandon the recommendation

| Signal | Tripwire | Fallback |
|---|---|---|
| Neon Free compute cap | CU-hours > 80/mo for 2 consecutive months (console Usage page) | Neon Launch ($3.39/mo at current volume) — not a migration |
| Neon Free storage cap | > 0.4 GB (console) | Neon Launch; same non-migration |
| Vercel Hobby invocation pressure | > 500 k/mo (dashboard) or cron precision visibly wrong | Vercel Pro, step 2 |
| Request-body ceiling | 4.5 MB `FUNCTION_PAYLOAD_TOO_LARGE` on import batches | shrink extension batch to 200, or Pro (same 4.5 MB cap — so batch shrink is the real fix) |
| WhatsApp session instability on Fly | `FAILED`/`SCAN_QR_CODE` loops correlated with host events (health `stale` + WAHA logs) | Hetzner CX22 single box (shape B) — vendor-minimum-shaped host |
| WhatsApp delivers nothing for > 75 s windows repeatedly | missed-message gaps the backfill can't close same-day | accept file-export importer as primary (`src/importers/whatsapp.js` per ticket 007), WAHA becomes optional |
| Azure forced externally | org/compliance mandate | shape G, re-verify Files + storage prices first |
| NVIDIA credits exhausted (004 §0.1) | balance near zero with no renewal path | host-independent — self-host NIM or change provider; no hosting move fixes it |

### Tradeoffs accepted by this recommendation

- **Two vendors instead of one** (Vercel + Fly + Neon = three). Mitigated: WAHA is
  a stock image with a volume; its config is four env vars and survives any
  re-host in an afternoon.
- **Fly free-transactional risk:** $1.94/mo computes are preemptible-adjacent
  shared CPU; a seized Machine restarts and WAHA autostart restores the session
  (`WAHA_WORKER_RESTART_SESSIONS` default true — 002 §2). Worst case is one QR
  re-scan, same as any host failure.
- **Hobby cron precision (±59 min)** on the 06:00 sweep. Immaterial for a nightly
  review; the internal 50 s budget dominates timing, not the trigger minute.
- **No staging parity:** Hobby preview deployments share the prod Neon branch
  unless branched. Unchanged from today; out of scope.

---

## 7. Gaps / UNVERIFIED list

| Item | Status |
|---|---|
| Azure App Service B1 Linux $/mo | **UNVERIFIED** — official page JS-rendered; $13.14 secondary only |
| App Service multi-app plan sharing + Always-On tier gate | **UNVERIFIED** — confirm in hosting-plans docs |
| Azure Files $/mo for a ~5 GB share; PG Flexible storage $/GB-mo | **UNVERIFIED** — pages JS-rendered |
| Azure B2s VM $/mo; managed disk + public IP $/mo | **UNVERIFIED** (B1s $7.59 verified; B2s not queried) |
| Hetzner CX22/CPX22 current €/mo | **UNVERIFIED** — hetzner.com renders prices via JS; 20 TB traffic verified |
| Fly `schedule:` machines GA + exact cron-machine UX | **UNVERIFIED** |
| Railway cron UX specifics; Render free-tier sleep specifics | **UNVERIFIED** (paid-tier behavior verified by pricing structure) |
| B1MS burstable throttling at backfill pace | **UNVERIFIED** — only matters if Azure chosen |
| All per-option sizing (0.5 vCPU app, GOWS RAM) | arithmetic on verified rates, not measurements — run one month and read the bills |

---

## Sources

Primary, all accessed 2026-09-14 unless noted:

- Repo: `package.json:6-8`, `vercel.json:4-6`, `README.md:37-39,103-116`,
  `src/lib/server/env.ts:3-49`, `src/app/api/*/route.ts` (`maxDuration = 60` × 8,
  via repo grep 2026-09-14)
- Prior research: `.wayfinder/research/004-cost-model.md` §2–§4 (Neon/Neon-compute
  arithmetic, pgvector migration refs), `.wayfinder/research/002-waha-facts.md`
  §2, §3, §5, §7, §8 (engines, footprint, volume, webhook, reachability, minimum host)
- https://vercel.com/pricing — Hobby $0 / Pro $20; function allowances
- https://vercel.com/docs/limits — 1M invocations / 4 CPU-h / 360 GB-h Hobby
- https://vercel.com/docs/functions/limitations — maxDuration table, 4.5 MB body,
  Active-CPU-excludes-I/O, 2 GB Hobby memory
- https://vercel.com/docs/fluid-compute — Fluid default since 2025-04-23; Hobby 300 s max
- https://vercel.com/docs/cron-jobs/usage-and-pricing — Hobby daily-only, ±59 min
- https://vercel.com/docs/functions/runtimes — 12-function note (non-framework),
  Next.js bundling, read-only FS + 500 MB /tmp
- https://vercel.com/docs/functions/runtimes/node-js/node-js-versions — 20.x/22.x/24.x
- https://neon.com/pricing — Free 100 CU-h + 0.5 GB; Launch $0.106/CU-h + $0.35/GB-mo; 5 min scale-to-zero
- https://neon.com/docs/extensions/pgvector — `CREATE EXTENSION vector` on all plans
- https://fly.io/pricing/ — Machines table, $0.15/GB volumes, $0.02/GB egress,
  Managed Postgres $38 + $0.28/GB
- https://fly.io/docs/launch/autostop-autostart/ — autostop exists (body JS-rendered)
- https://railway.com/pricing — Hobby $5 incl $5; $10/GB, $20/vCPU, $0.15/GB vol, $0.05/GB egress
- https://docs.railway.com/databases/postgresql — template Postgres; pgvector separate template
- https://render.com/pricing — Starter $7 / Standard $25; PG $6–$19+; disk $0.25/GB; cron/min rates
- https://nextjs.org/docs/app/getting-started/deploying — Node/Docker = all features; deploy templates
- Azure retail API `https://prices.azure.com/api/retail/prices` (primary, machine-readable):
  ACA vCPU-active $0.000024/s, mem-active $0.000003/GiB-s, vCPU-idle $0.000003/s,
  requests $0.40/M, B1MS PG $0.017/hr (≈$12.41/mo), B1s Linux VM $0.0104/hr
  (≈$7.59/mo), P1mv4 $0.278/hr — all eastus USD
- https://learn.microsoft.com/en-us/azure/container-apps/billing — free grants,
  scale-to-zero $0, idle conditions, job billing
- https://learn.microsoft.com/en-us/azure/container-apps/scale-app — KEDA rules, min/max replicas
- https://learn.microsoft.com/en-us/azure/container-apps/jobs — scheduled/event jobs, UTC cron
- https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts — Azure Files only persistent store
- https://learn.microsoft.com/en-us/azure/postgresql/extensions/how-to-use-pgvector
  + …/how-to-allow-extensions — `vector` allowlist + `CREATE EXTENSION vector`
- https://azure.microsoft.com/en-us/pricing/details/bandwidth/ — first 100 GB/mo egress free; $0.087/GB NA/EU after
- https://azure.microsoft.com/en-us/pricing/details/kubernetes-service/ — AKS tiers (control-plane fees placeholder)
- https://www.digitalocean.com/pricing/droplets — Basic 2vCPU/4GB $24/mo, 2vCPU/2GB $18/mo
- https://www.hetzner.com/cloud/regular-performance/ — 20 TB EU traffic (plan prices JS-rendered → UNVERIFIED)
