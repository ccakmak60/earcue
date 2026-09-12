---
id: map-1
title: "Production-ready: knowledge base, WhatsApp, Chrome ingestion"
labels: [wayfinder:map]
status: open
---

# Production-ready: knowledge base, WhatsApp, Chrome ingestion

## Destination

A **locked hardening spec** for three already-built features — the pgvector knowledge base
(`api/_lib/knowledge.js`, informed by supermemory's architecture), the WhatsApp connector via
WAHA (`api/_lib/waha.js` + `api/connect/[action].js`), and Chrome ingestion (`extension/`) —
detailed enough that implementation is one execution pass with nothing left to decide.

"Production" here = **single user (the repo owner), running daily on their own real data**.
Trustworthy enough to depend on, not multi-tenant-hardened. The three failures that define
"trustworthy": **silent data loss**, **bad recall**, **cost blowout** — in that order.

**Draft spec:** [Hardening spec](spec-production-ready.md) — everything the four research tickets
settled, written up as one implementation pass. Five decisions in it are still marked OPEN and map
to the five remaining grilling tickets; it is not locked until those land.

## Notes

- **Plan, don't do.** Tickets produce decisions, not code. The one exception is
  `wayfinder:task` tickets, which do manual work that a decision waits on.
- Domain: Vercel serverless + Neon Postgres + pgvector, unbundled ESM, no test framework, no CI.
  Read `AGENTS.md` before any ticket — it is the architecture reference and it is current.
- Hard constraint every ticket inherits: **Vercel Hobby caps the deployment at 12 serverless
  functions and all 12 are used.** Any new endpoint must be a new `action` on an existing
  dispatcher, not a new file.
- Verification story is `app.js`'s `selfCheck()` (pure functions only) plus `/api/health`.
  A spec that assumes a test suite is not implementable here.
- Skills: `/grilling` and `/domain-modeling` for grilling tickets; `/research` subagent for
  research tickets; `context7` for library/API docs.
- Standing preference: laziest thing that holds. This is a hardening map — deleting a feature
  is a legitimate resolution to a ticket about hardening it.

## Decisions so far

<!-- one line per closed ticket: gist + link -->

- [What a day and a backfill actually cost](tickets/004-ingest-cost-model.md) —
  NVIDIA publishes no per-token price; the real meter is a finite non-renewable credit allowance,
  ~13 days at steady state. Backfill is cheap (under 1.5 days of inference) but takes 4.3 months of
  nightly crons to drain. Runaway is `api/factcheck.js` — ungated, and `chatJson` bills up to 6 HTTP
  requests per decremented counter. Biggest driver: one NIM call per 20 s of audio. Quota is
  non-binding today (owner is `unlimited`).
- [What supermemory does that earcue’s knowledge base doesn’t](tickets/001-supermemory-architecture-delta.md) —
  the engine is closed source, so internals are doc claims only; earcue already clones the public
  model. 20 deltas, 8 adopt-worthy — top three: documents are never chunked or embedded, ingest is
  one bulk 300-item LLM call, and recall has no similarity threshold.
- [What it actually takes to keep a WAHA session alive](tickets/002-waha-self-host-facts.md) —
  WAHA is fully free since 2026.6.1, nothing we call is paywalled; ~$5-25/mo for 2 vCPU / 4 GB.
  Webhooks are in-memory best-effort with no dead-letter, so gaps must be closed by backfill, not
  by WAHA; duplicates are real; four payload mismatches in `normalizeWahaMessage()`.
- [Chrome Web Store gates for a history-reading extension](tickets/003-chrome-web-store-gates.md) —
  a listing is plausible (no policy bans off-device history transmission); 5 blocking gates, all
  documentation plus one manifest line, no architectural change. Unlisted relaxes nothing; the
  pasted token is not itself a review problem.

## Not yet specified

- **WhatsApp reliability spec** — session-drop detection, re-link flow when the QR expires,
  webhook idempotency/dedup (`externalId: waha:<id>` is the current handle), and what happens to
  media: `chatMessages()` sends `downloadMedia: false`, so voice notes and images are silently
  dropped today. Sharpens once WAHA is actually running (see the WAHA task ticket).
- **Backfill depth and re-backfill semantics**, uniformly across all three sources —
  `IMPORT_LOOKBACK_DAYS` is 180 and duplicated between server default and `extension/background.js`.
  What a second backfill of the same window should do. Blocked on the cost ceiling.
- **Extension sync gaps** — `chrome.history.search` caps at `maxResults: 5000` per window, and
  `lastSyncMs` advances on success of the whole batch; a heavy day plus an interrupted sync can
  drop visits. Also per-URL vs per-visit granularity. Sharpens once the silent-data-loss detection
  mechanism is decided.
- **Data durability** — Neon backup/restore posture, and what losing the DB actually costs given
  that WhatsApp/browser sources can be re-backfilled but captured traces cannot.
- **Privacy posture** — WhatsApp bodies and full browser history leave the machine to NVIDIA NIM
  and Gemini. Encryption at rest today covers connector OAuth tokens only (`secretbox.js`).
  Not ranked as a top failure, but the Chrome Web Store listing may force parts of it.
- **How "production ready" gets verified** with no test framework — which of the new logic is
  pure enough to land in `selfCheck()`, and what the manual pre-flight checklist is.

## Out of scope

- Multi-tenant hardening: per-user rate limiting, abuse prevention, tenant isolation beyond what
  exists. Destination is single-user.
- Billing / Polar / entitlement work. `assertEntitled` already gates these endpoints and the
  owner account is comped.
- The capture pipeline (`api/ingest/*`, `src/capture.js`, traces, teleprompter, day review).
  Real, load-bearing, and not one of the three named features.
