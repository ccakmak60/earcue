---
id: 2
title: "What it actually takes to keep a WAHA session alive"
parent: map-1
labels: [wayfinder:research]
status: closed
assignee: ccakmak60
blockedBy: []
---

## Question

Read the WAHA docs (https://waha.devlike.pro/) and surface the operational facts a hosting
decision waits on. `api/_lib/waha.js` already calls `/api/sessions`, `/api/sessions/{n}/start`,
`/api/{n}/auth/qr`, `/api/{n}/chats/overview`, `/api/{n}/chats/{id}/messages`, and registers a
webhook for `message` + `session.status` with exponential retry — so the client is written; only
the runtime is unknown.

Answer:

- **Licensing**: what WAHA Core gives free vs what requires WAHA Plus (paid), and whether any
  endpoint `waha.js` already calls is Plus-only. Price if so.
- **Engines** (WEBJS / NOWEB / GOWS): which the above endpoints support, memory/CPU footprint of
  each, and which survives restarts best.
- **Session persistence**: what must live on a Docker volume for a restart not to force a QR
  re-scan; how long an authenticated session survives untouched.
- **Failure modes**: what `session.status` values exist and which mean "the user must re-scan",
  what happens when the phone goes offline, and what WhatsApp itself does about unofficial clients.
- **Webhook semantics**: delivery guarantees, retry behaviour under the configured
  `exponential / 2s / 5 attempts` policy, whether duplicates are possible (bears on dedup by
  `externalId`), and the payload shape for `message`.
- **Reachability**: what the container needs to reach a Vercel deployment and what the deployment
  needs to reach the container — the exact constraint `WAHA_WEBHOOK_BASE_URL` exists to work around.
- **Minimum viable host**: RAM/CPU/disk for one session, and rough monthly cost on the cheapest
  plausible VPS tiers.

Output: facts only, with citations. The hosting choice is a separate ticket.

## Answer

Findings: [`research/002-waha-facts.md`](../research/002-waha-facts.md).

**Licensing is a non-issue.** Since version 2026.6.1 WAHA is 100% free and open source — no Plus
tier, one public image `devlikeapro/waha`. Nothing `api/_lib/waha.js` calls is paywalled. The only
paid thing left is a voluntary $5/mo community tier with, per the docs, "no perks."

**Persistence** = mount a volume at `/app/.sessions`. Local file storage is the documented,
well-tested default; PostgreSQL session storage is available and free if we'd rather not manage a
volume. `stop` is safe and idempotent; `logout` drops the pairing and forces a new QR — and
`waha.js#deleteSession()` correctly calls logout-then-DELETE.

**Session lifetime is a WhatsApp limit, not a WAHA one:** the primary phone must come online at
least every 14 days or linked devices are logged out. WAHA's own docs state no expiry.

**Webhooks are best-effort and in-memory — this is the load-bearing finding.**
`WebhookSender.send()` fires `axios.post()` with `.then()/.catch()` and never awaits or persists.
So:

- Retries exhausted, or the container killed/redeployed mid-flight → the event is **dropped
  silently**, logged only. No dead-letter, no replay. At-least-once *while retrying*, then nothing.
- `retryCondition: () => true` — a 401/404/500 from Vercel retries exactly as hard as a timeout.
  (The existing handler comment about returning `200` on quota-exceeded rather than `429` is right.)
- No client timeout is configured, so a hung Vercel function holds the connection open.
- **Duplicates do happen** — dedup on `externalId` is mandatory, not defensive.

Consequence for the map: **any webhook gap must be closed by the backfill path
(`chats/{id}/messages`), not by WAHA.** Webhook-only is a silent-data-loss design.

**Four mismatches between the live payload and `normalizeWahaMessage()`:** (1) the display-name
lookup is engine-specific and breaks on GOWS; (2) `message` vs `message.any` and the `fromMe`
contradiction in the docs; (3) group messages are not filtered; (4) newer `session.status` values
are unhandled. Chat-id formats (`@c.us` / `@g.us` / `@lid`) are enumerated in the findings.

**Minimum host:** vendor floor is 2 vCPU / 4 GB *even for one session*, though their own per-session
figures are far lower (GOWS/NOWEB 0.1 CPU / 200 MB). Roughly **$5–25/month**; only the DigitalOcean
$24/mo figure comes from a primary source, Hetzner/Vultr/Contabo prices are unverified.

Ten loose ends are flagged unverified at the end of the findings file — most of them resolve only
against a live container, which is what [the WAHA stand-up task](011-stand-up-waha.md) is for.
