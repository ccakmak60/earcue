---
id: 3
title: "Chrome Web Store gates for a history-reading extension"
parent: map-1
labels: [wayfinder:research]
status: closed
assignee: ccakmak60
blockedBy: []
---

## Question

`extension/` is a Manifest V3 extension that reads `chrome.history` and `chrome.bookmarks` and
ships them to a self-hosted server using a hand-pasted bearer token stored in
`chrome.storage.local`. The destination is a Chrome Web Store listing.

Research what publishing that actually requires:

- **Permission justification**: what Google demands for `history` (one of the most-scrutinised
  permissions), and whether reading full history for off-device transmission survives review at all.
- **Limited Use / User Data policy**: what the disclosure must say, whether an in-extension consent
  screen is required, and whether `privacy.html` (already in this repo) satisfies the
  privacy-policy requirement or needs specific clauses.
- **Review**: typical timeline for a history-permission extension, common rejection reasons,
  and what re-review a version bump triggers.
- **Mechanics**: developer account cost, packaging, versioning, auto-update channel, and whether
  an unlisted/private listing (visible only to the owner) avoids any of the above.
- **Token model**: whether a pasted long-lived bearer token in `chrome.storage.local` is a review
  problem, and what the accepted alternatives are.

Output: a gate list — each gate marked **blocking / fixable / already satisfied** against the
current `extension/manifest.json` and `privacy.html`.

## Answer

Full gate list with citations: [`.wayfinder/research/003-chrome-store-gates.md`](../research/003-chrome-store-gates.md).

**A listing is plausible.** No Chrome policy bans transmitting full browsing history off-device;
the bar is disclosure + consent + narrow single purpose + no ads/resale, and there is live
precedent on the store today (History-Sync). All five blockers are documentation plus one
manifest line — no architectural change to `extension/` is required.

**5 blocking gates**, 9 fixable, 1 already satisfied:

1. **No in-extension consent.** `options.html` carries one descriptive sentence; policy wants an
   in-UI disclosure enumerating the data types plus a distinct affirmative action before
   collection. Aggravated by `extension/background.js` calling `syncAll()` from
   `chrome.runtime.onInstalled` — only unset credentials currently stop it.
2. **`privacy.html` does not cover the extension.** The words "history" and "bookmarks" appear
   nowhere in it while the manifest requests `history`. That exact mismatch is a documented
   rejection reason.
3. **No Limited Use affirmative statement** on the site — one required sentence, currently absent.
4. **`http://localhost/*` in `optional_host_permissions`** violates the secure-transmission
   clause. Drop it from the store build.
5. **A reviewer cannot exercise the extension.** The options page demands a base URL and an
   `ec_it_...` token they do not have; the standard outcome is rejection as non-functional.
   Needs a live HTTPS deployment, a throwaway token, and test instructions.

Two sub-questions answered against expectation:

- **Unlisted/private relaxes nothing** — same review, same policy, per Google's own wording.
- **The pasted bearer token is not itself a review problem.** No policy forbids it. It matters
  only as a dashboard disclosure ("Authentication information"), as the cause of blocker 5, and
  as a hardening point. `chrome.identity.launchWebAuthFlow()` would remove the paste step and
  blocker 5 together.

Also flagged: `https://*/*` alongside `history` is the worst-looking pair in the manifest and will
slow review. Survivable with an explicit justification — it is the price of "point it at your own
server". Unverified items (the $5 developer fee, the 20-item cap, whether `history` sits on a
formal manual-review list, Chrome's auto-update interval) are listed separately in the findings.
