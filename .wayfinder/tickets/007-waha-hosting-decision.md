---
id: 7
title: "Where WAHA runs"
parent: map-1
labels: [wayfinder:grilling]
status: open
assignee:
blockedBy: [2]
---

## Question

Nothing is running today. `api/_lib/waha.js` is written against a `WAHA_BASE_URL` that points
nowhere, and the WhatsApp connector is hidden whenever `WAHA_BASE_URL`/`WAHA_API_KEY` are unset
(`api/_lib/env.js` `whatsapp` flag), so the feature is currently dark in production.

Given the facts from the WAHA operational research ticket, decide the runtime:

- **Placement**: a cheap always-on VPS, a container platform (Fly/Railway/Render), the local
  Windows box plus a tunnel, or a home server. The container holds a live WhatsApp Web session,
  so "runs only when my laptop is open" is a real option with a real cost — name that cost.
- **Reachability both directions**: Vercel functions must reach WAHA's HTTP API, and WAHA must
  reach `/api/connect/whatsapp-webhook`. Decide whether the WAHA API is public-with-an-API-key
  or private-behind-a-tunnel, and what `WAHA_WEBHOOK_BASE_URL` becomes.
- **Persistence**: what lives on a volume, and the restore procedure after the host is rebuilt.
- **Budget**: the monthly number you accept for keeping this alive, and whether WAHA Plus gets
  bought if the research says a needed endpoint sits behind it.
- **Kill criterion**: what would make you drop live WhatsApp ingestion and fall back to the
  existing file-export importer (`src/importers/whatsapp.js`), which already works and costs
  nothing to operate.

Resolution must be concrete enough to provision from: host, plan, engine, volume, DNS/tunnel,
and the exact values the three `WAHA_*` env vars take in production.
