---
id: 10
title: "Publish the extension, and what has to change first"
parent: map-1
labels: [wayfinder:grilling]
status: open
assignee:
blockedBy: [3]
---

## Question

Given the Chrome Web Store gate list, decide whether `extension/` gets published and what
changes to make it pass.

- **Listing type**: public, unlisted, or abandon the store and stay side-loaded. The stated intent
  is a listing; if the research says a `history`-permission extension shipping full history
  off-device will not survive review, say so and re-decide here rather than pushing on.
- **Manifest changes**: permission narrowing, `host_permissions` scoped to the earcue origin, and
  whether `history` can be requested optionally at runtime instead of at install.
- **Consent + disclosure**: what the options page must show before the first sync, and what
  clauses `privacy.html` gains. The extension is a fully independent codebase that imports nothing
  from `src/` — its consent copy lives with it.
- **Auth**: whether the pasted bearer token stays. It is issued from `ingest_tokens` and never
  expires; a store listing may force a real auth flow, which is a much larger change — price it
  before accepting it.
- **Release process**: how a version ships and what re-review it costs, given there is no CI.

Resolution: publish or not, and the ordered change list for `extension/` and `privacy.html`.
