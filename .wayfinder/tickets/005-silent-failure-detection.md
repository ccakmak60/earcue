---
id: 5
title: "How you find out ingestion silently broke"
parent: map-1
labels: [wayfinder:grilling]
status: open
assignee:
blockedBy: []
---

## Question

Silent data loss is the #1 named failure. Today nothing reports it: `extension/background.js`
swallows sync errors into `console.error` in a service worker nobody watches, the WhatsApp webhook
writes `last_error` to a `connections` row nobody reads, and email delivery was deliberately
removed in migration `011_drop_email_prefs.sql`. `/api/health` only checks env vars.

Decide the detection-and-notification design:

- **What counts as broken?** Freshness thresholds per source (WhatsApp session not `WORKING`,
  no browser sync in N hours, no distillation pass overnight, `imports` stuck in a non-terminal
  status) — or something coarser.
- **Where does the check run?** There is exactly one Vercel cron entry (`api/cron/review-sweep.js`)
  and all 12 serverless function slots are used, so a new checker is an action on an existing
  dispatcher or a step inside the existing cron — not a new function.
- **How does it reach you?** Email is gone. Options include an in-app surface in `app.html`, a
  push channel, extending `/api/health` for external uptime polling, or reinstating a narrow
  notification path. Pick one and say why the others lose.
- **What do you do about it?** A detection with no repair action next to it is noise.

Resolution should be specific enough to implement without re-deciding: the thresholds, the
storage for last-seen-per-source, the surface, and the repair affordance.
