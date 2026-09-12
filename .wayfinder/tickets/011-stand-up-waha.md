---
id: 11
title: "Stand up WAHA and link the real session"
parent: map-1
labels: [wayfinder:task]
status: open
assignee:
blockedBy: [7]
---

## Question

Manual work, not a decision. The WhatsApp reliability questions still in the fog — session-drop
detection, re-link flow, webhook dedup, whether media matters — cannot be answered against a
container that has never run. This ticket makes one exist.

Per the hosting decision: provision the host, run WAHA with the chosen engine and volume, set
`WAHA_BASE_URL` / `WAHA_API_KEY` / `WAHA_WEBHOOK_BASE_URL` in the Vercel project env **and**
`.env.example`, `npm run env:pull`, then drive the real flow end to end —
`POST /api/connect/whatsapp-link`, scan the QR, poll `GET /api/connect/whatsapp-status` to
`WORKING`, send yourself a message and confirm a `context_items` row lands via the webhook, then
run a bounded `whatsapp-backfill`.

Record as the answer, because later tickets depend on these facts:

- The real `session.status` sequence observed, and how long the QR stayed valid.
- Whether the webhook actually reached the Vercel deployment, and its latency.
- The exact webhook payload shape versus what `normalizeWahaMessage()` expects — especially
  `msg.id`, `msg.timestamp`, `msg._data.notifyName`, and group-chat `from`/`to`.
- Row counts: chats in `chatsOverview`, messages a bounded backfill produced, `context_items`
  inserted, duplicates if any.
- What broke. Every mismatch between the code as written and WAHA as it actually behaves.
- Where the credentials live, and the restart/restore procedure that was verified, not assumed.
