---
id: 9
title: "The cost ceiling and where it's enforced"
parent: map-1
labels: [wayfinder:grilling]
status: open
assignee:
blockedBy: [4]
---

## Question

Given the three cost numbers, decide the budget and the enforcement mechanism.

- **The ceiling**: a monthly figure you are willing to spend, split across NIM, Gemini, Neon, and
  the WAHA host. State the number.
- **Enforcement point**: `api/_lib/quota.js` already enforces per-metric daily call caps via
  `consume(user, metric, n)` and `usage_daily`. Decide whether call-count caps recalibrated
  against real prices are sufficient, or whether spend needs tracking directly — which means
  recording token counts, which means touching every NIM/Gemini call site.
- **Backfill vs steady state**: a cold-start backfill is a legitimate one-time spike that a daily
  cap would block. Decide how it is authorised — a manual override, a separate metric, or a
  chunked backfill spread across days.
- **Runaway protection**: what stops the worst-case loop the research ticket identified.
  `api/_lib/nim.js` already has retry/deadline handling — decide whether the fix belongs there
  rather than in a new layer.
- **Visibility**: whether you need to see current spend, and if so where (`src/budget.js` and the
  `earcue:budget` event already exist for quota; reuse or replace).

Resolution: the ceiling, the per-metric caps that implement it, and the one place a runaway stops.
