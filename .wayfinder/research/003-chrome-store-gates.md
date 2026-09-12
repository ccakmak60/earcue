# 003 — Chrome Web Store gates for `extension/`

Research only. No publish decision here (that is a separate ticket).
Researched 2026-09-12 against the live Chrome for Developers policy pages.

## What the code actually does (baseline for scoring)

- `extension/manifest.json` — MV3. `permissions: ["history","bookmarks","storage","alarms"]`,
  `optional_host_permissions: ["http://localhost/*","https://*/*"]`, background service worker
  (module), `options_page`. **No `icons`, no `action`, version `1.0.0`.**
- `extension/background.js` — 60-minute alarm. `chrome.history.search({text:"", startTime: now-180d,
  endTime: now, maxResults: 5000})` on first run, then incremental from `lastSyncMs`. POSTs
  `{url,title,lastVisitTime,visitCount,typedCount}` in 300-row chunks to
  `${baseUrl}/api/assist/browser` with `authorization: Bearer <token>`. Full bookmark tree
  (url, title, dateAdded, folder path) weekly, same endpoint.
- `extension/options.js` — reads/writes `baseUrl` + `token` in `chrome.storage.local` (plaintext),
  calls `chrome.permissions.request({origins:[origin+"/*"]})` on save, then does a begin/finish
  round-trip as a connectivity check.
- `extension/options.html` — one sentence: *"Connect this extension to your earcue account so your
  browsing history and bookmarks feed your personal knowledge base."* Two inputs and a Save button.
  **No consent control, no enumeration of what is transmitted, no privacy-policy link.**
- `privacy.html` — covers audio, screen captions, Gemini/Polar/Neon sub-processors, accounts,
  Gmail/Calendar/Slack connectors. **Contains the words "history" and "bookmarks" nowhere. Zero
  mention of a browser extension. No Limited Use affirmative statement. No contact email address**
  (it says "reach us via the email address you signed up with").

## Headline answer to the ticket's framing questions

- **Is off-device transmission of full browsing history permitted at all?** Yes. There is no policy
  banning it. The bar is that it must be (a) strictly necessary to a narrow disclosed single
  purpose, (b) prominently disclosed in-UI with affirmative consent, (c) covered by a privacy
  policy, (d) transmitted over a secure connection, and (e) never used for ads/monetization/resale.
  Live precedent exists on the store today (e.g. *History-Sync*, which captures dwelled-on pages to
  a user-supplied server). earcue's use — feeding the user's own knowledge base — is exactly the
  "user-facing feature that is prominently described" carve-out the policy names.
- **Does unlisted/private relax anything?** No. Official wording: *"All visibility settings have the
  same policy requirements and will go through the same review process."* Unlisted only removes
  discoverability.
- **Is a pasted long-lived bearer token in `chrome.storage.local` itself a review problem?** No
  policy prohibits it, and it is not a listed rejection reason. It becomes a problem indirectly in
  three ways, all fixable — see G13/G14.

---

## Gate list

Legend: **BLOCKING** = submission will be rejected or cannot be evaluated as-is ·
**FIXABLE** = mechanical work, no design change · **SATISFIED** = current code already complies.

### G1 — In-extension prominent disclosure + affirmative consent · **BLOCKING**

Policy: *"the disclosure … must not be located only in a privacy policy, terms of service, or
similar document"*; it must appear *"within the Product's user interface"*, and *"the Product must
ask the user to agree to the prominent disclosure in a manner that requires them to take a specific
action clearly agreeing to the disclosure before collecting or handling user data."*
As of the **1 August 2026** policy update this now applies to *all* data collection *"regardless of
whether the data is closely related to the extension's single purpose."*

Scored: **fails.** `options.html`'s single descriptive sentence is not a disclosure (it does not
enumerate data types) and clicking "Save" is a configuration action, not an affirmative consent
action. Worse, `background.js` syncs on `onInstalled` before the options page is ever opened — the
only thing stopping it is that `baseUrl`/`token` are unset, which is an accident of implementation,
not consent.

Fix: a first-run/options consent block naming *URLs visited, page titles, visit and typed counts,
visit timestamps, bookmark URLs/titles/folders*, the destination (the user's own earcue server), and
a distinct checkbox or "I agree" button gating the first sync.

Cite: <https://developer.chrome.com/docs/webstore/program-policies/user-data-faq> ·
<https://developer.chrome.com/blog/cws-policy-updates-2026>

### G2 — Privacy policy must cover the extension · **BLOCKING**

Policy: products handling user data must *"Post a privacy policy in the Chrome Web Store Developer
Dashboard"* explaining what is collected, how it is used, and when it is disclosed. Reviewers
cross-check the policy text against the manifest permissions and the dashboard data disclosures; a
manifest requesting `history` against a policy that never mentions browsing history is a documented
rejection.

Scored: **fails.** `privacy.html` never mentions the extension, browsing history, bookmarks, or the
`/api/assist/*` ingest path.

Fix: add an extension section to `privacy.html` stating, at minimum: which permissions are used and
why; the exact fields transmitted (list above); that the destination server is the user's own earcue
deployment; retention; that data is never sold, never used for ads, and never shared with
sub-processors from the extension path; how to revoke (remove the extension / delete the ingest
token / account deletion, which already exists); and a real contact email. Ensure the same URL is
entered in the dashboard's Privacy Policy URL field.

Cite: <https://developer.chrome.com/docs/webstore/program-policies/user-data-faq> ·
<https://developer.chrome.com/docs/webstore/cws-dashboard-privacy>

### G3 — Limited Use affirmative statement on the extension's website · **BLOCKING**

Policy: *"An affirmative statement that your use of the data complies with the Limited Use
restrictions must be disclosed on a website belonging to your extension."*

Scored: **fails.** No such sentence exists in `privacy.html`.

Fix: one sentence, verbatim-ish: *"earcue's use and transfer of information received from Chrome
APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements."*

Cite: <https://developer.chrome.com/docs/webstore/program-policies/limited-use>

### G4 — `http://localhost/*` in `optional_host_permissions` · **BLOCKING**

Policy: extensions *"must transmit user data over a secure connection (e.g. HTTPS, WSS) and stored
at rest using a strong encryption method such as RSA or AES."* Cleartext HTTP shipment of a user's
full browsing history is the exact failure mode that clause exists for.

Scored: **fails.** The manifest permits, and `options.js` will happily accept, an `http://localhost`
base URL.

Fix: drop `http://localhost/*` from the store build and reject non-`https:` base URLs in
`options.js`. (Keep a dev-only manifest variant out of the uploaded zip.)

Cite: <https://developer.chrome.com/docs/webstore/program-policies/user-data-faq>

### G5 — Reviewer must be able to exercise the extension end-to-end · **BLOCKING (practical)**

The reviewer will install it, open the options page, and hit a form demanding a base URL and an
`ec_it_...` token they do not have. Without working credentials the standard outcome is rejection
for a non-functional item. Test instructions are formally *optional* ("This step is not required for
publishing") but exist precisely for items that *"require restricted credentials or a paid
account."*

Scored: **fails as-is.** Nothing in the repo provides a reviewer path.

Fix: stand up a reachable HTTPS earcue deployment, mint a throwaway ingest token, and put the base
URL + token + click-path in the Test Instructions tab. Do **not** ship the token inside the zip.

Cite: <https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions> ·
<https://developer.chrome.com/docs/webstore/review-process>

### G6 — `optional_host_permissions: ["https://*/*"]` · **FIXABLE (with a real trade-off)**

Policy: *"Request access to the narrowest permissions necessary"* and *"if more than one permission
could be used to implement a feature, you must request those with the least access."* Broad host
patterns (`*://*/*`, `<all_urls>`) are explicitly named as a review slowdown, scrutinised
specifically *"to prevent browsing history collection."* Combining `https://*/*` with `history` is
the worst-looking pair in the manifest.

Scored: **weak.** It is *optional* (not granted at install) and `options.js` narrows the actual
grant to one origin — genuinely better than a required host permission. But the declared pattern is
still all-of-HTTPS, because `chrome.permissions.request()` can only ask for patterns declared in
`optional_host_permissions`, and the "point it at your own server" design means the origin is not
known at build time.

Options: (a) keep `https://*/*` and justify it explicitly in the permission justification field —
survivable, expect slower review; (b) constrain to a known suffix (e.g. `https://*.earcue.app/*`)
and drop arbitrary self-hosting from the store build. Not blocking either way.

Cite: <https://developer.chrome.com/docs/webstore/program-policies/permissions> ·
<https://developer.chrome.com/docs/webstore/review-process>

### G7 — Single purpose statement · **FIXABLE**

Policy: *"a single purpose that is narrow and easy to understand"*; under the Aug 2026 Limited Use
update, collected data must be *"strictly necessary to the extension's disclosed single purpose."*

Scored: **not written yet, but the code is well-shaped for it.** The extension does exactly one
thing. Advantage: the field list is already minimal (no page content, no cookies, no tab
monitoring, no `<all_urls>` content scripts).

Fix: e.g. *"Syncs the user's Chrome browsing history and bookmarks to their own earcue account so
earcue can answer questions about what they have read."* Every collected field must be traceable to
that sentence — `typedCount` and `visitCount` are the weakest links; drop them if the server does
not actually use them.

Cite: <https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines> ·
<https://developer.chrome.com/blog/cws-policy-updates-2026>

### G8 — Per-permission justifications in the dashboard · **FIXABLE**

Policy: state why each permission is needed and remove any that are unnecessary.
Four justifications required: `history`, `bookmarks`, `storage`, `alarms`, plus the host permission.
All four are genuinely used in `background.js`/`options.js` — nothing speculative in the manifest,
which is the thing that most often sinks this field.

`history` justification must say what is read and where it goes; do not hide the off-device
transmission — reviewers read `background.js` and any mismatch is a rejection.

Cite: <https://developer.chrome.com/docs/webstore/cws-dashboard-privacy> ·
<https://developer.chrome.com/docs/webstore/program-policies/permissions>

### G9 — Dashboard data-type disclosure + three certifications · **FIXABLE**

The Privacy tab has a checkbox group for data types (personally identifiable information, health,
financial, authentication information, personal communications, location, **web history**, **user
activity**, website content) and a second group certifying compliance (not sold to third parties
outside approved use cases; not used for purposes unrelated to the single purpose; not used for
creditworthiness/lending).

Scored: must tick **Web history** and **User activity**; **Authentication information** is arguable
for the ingest token (tick it — over-disclosing costs nothing, under-disclosing is a violation).
Purpose = "app functionality" only. All three certifications are truthfully checkable given the
current code — nothing in `background.js` sells, ad-targets, or repurposes.

Cite: <https://developer.chrome.com/docs/webstore/cws-dashboard-privacy> ·
<https://developer.chrome.com/docs/webstore/program-policies/limited-use>

### G10 — Post-install change notification (new, Aug 2026) · **FIXABLE**

Policy: developers must *"proactively disclose to users if their data handling practices change at
any point after the initial installation."*

Scored: **no mechanism exists.** Nothing gates a future version that starts collecting more.
Not blocking for v1 (nothing has changed yet), but it becomes a gate the first time the field list
grows. Cheapest form: version the consent record in `chrome.storage.local` and re-prompt when the
disclosed field list changes.

Cite: <https://developer.chrome.com/blog/cws-policy-updates-2026>

### G11 — Data minimisation of the initial 180-day bulk pull · **FIXABLE (risk, not a rule)**

No policy caps a lookback window. But a first sync that vacuums 180 days × up to 5000 rows within
seconds of install is the shape reviewers are trained to flag, and it is what makes the difference
between "personal knowledge base" and "history exfiltration" in a reviewer's read of
`background.js`. Mitigate by gating it behind the G1 consent action and surfacing the window in the
UI. Lower risk than G1–G5; listed so it is not a surprise.

Cite: <https://developer.chrome.com/docs/webstore/review-process>

### G12 — No remote code · **SATISFIED**

MV3 forbids loading and executing remotely hosted files. `background.js` and `options.js` are local
modules, no `eval`, no injected `<script src>`, no remote config execution. `privacy.html` loads
Google Fonts, but that is the website, not the extension package. Declare "No, I am not using remote
code" in the dashboard. Also note the review-speed advantage: 121 + 61 lines of unminified,
unobfuscated, readable code is close to the ideal case the review-process doc describes.

Cite: <https://developer.chrome.com/docs/webstore/cws-dashboard-privacy> ·
<https://developer.chrome.com/docs/webstore/review-process>

### G13 — Bearer token in `chrome.storage.local` · **FIXABLE — not a policy violation**

There is no Chrome Web Store policy against storing an app-issued token in `chrome.storage.local`,
and it is not on any rejection list. Three real consequences, none blocking:

1. It is "Authentication information" for the dashboard disclosure (see G9).
2. `chrome.storage.local` is unencrypted on disk. The secure-handling clause's "encrypted at rest"
   language is aimed at *your servers*, not the client store, so this is a hardening point rather
   than a gate — but a long-lived, non-expiring, non-revocable-per-device token raises the blast
   radius if it is ever read. **Unverified:** I found no official page applying the at-rest
   encryption clause to client-side extension storage.
3. Hand-pasting a token is the direct cause of G5.

Accepted alternatives, in order of laziness: (a) keep the pasted token but make it scoped,
revocable per device, and expiring server-side; (b) `chrome.identity.launchWebAuthFlow()` against
earcue's existing auth for a proper OAuth code exchange, which also deletes the paste step and the
reviewer-credential problem; (c) short-lived access token + refresh token.

Cite: <https://developer.chrome.com/docs/webstore/program-policies/user-data-faq> ·
<https://developer.chrome.com/docs/webstore/cws-dashboard-privacy>

### G14 — Listing assets missing from the package · **FIXABLE**

`manifest.json` has no `icons` (a 128×128 is required for the store listing) and no `action`, so the
extension is invisible in the toolbar — the only entry point is chrome://extensions → Options, which
is also a reviewer-friction issue for G5. The listing itself needs at least one 1280×800 or 640×400
screenshot, a detailed description, and a category. Package = a zip of the `extension/` contents
(2 GB cap, irrelevant here).

Cite: <https://developer.chrome.com/docs/webstore/publish>

### G15 — Developer account · **FIXABLE (mechanical)**

One-time **US$5** registration fee per developer account; not recurring. Commonly reported cap of
**20 published items** per account (secondary sources — the official register page does not state
either figure, so treat both as **unverified against Google's own docs**). Requires a developer
email and acceptance of the developer agreement. Domain verification is only needed for the
verified-publisher badge, not to publish.

Cite: <https://developer.chrome.com/docs/webstore/register>

### G16 — Review timeline · **INFORMATIONAL**

Official: *"For most extensions, review is completed within a few days, but it can take up to a few
weeks."* Contact developer support past three weeks. Named slowdown factors that all apply here:
new developer, new extension, dangerous permissions, broad host patterns. Secondary sources place
`history` on the guaranteed-manual-review list alongside `tabs`, `cookies`, `downloads`,
`webRequest`, `debugger` — **unverified against an official page**, but consistent with the official
"dangerous permission requests" language. Plan for weeks, not days, on the first submission.

Cite: <https://developer.chrome.com/docs/webstore/review-process>

### G17 — Versioning and auto-update · **INFORMATIONAL**

Every new version needs a strictly larger `version` than the last, and *"all item submissions are
subject to the same review process"* — so **every bump is a full re-review**, with the old version
staying live and installed until the new one is approved. Percentage rollout is available above
10,000 active users and changing the rollout percentage does *not* trigger a new review; rollback to
a prior version is supported. Publishing can be deferred up to 30 days post-approval. Chrome's
client-side auto-update polling interval is **unverified** — I did not confirm a figure from an
official page.

Cite: <https://developer.chrome.com/docs/webstore/update>

### G18 — Unlisted / private visibility relaxes nothing · **INFORMATIONAL**

Public, Unlisted, Private (trusted testers list — account-level, not per-item — plus owned Google
Groups), and Workspace domain publishing. Official: *"All visibility settings have the same policy
requirements and will go through the same review process."* Unlisted still needs G1–G5, still gets
reviewed, still needs the $5 account. It only hides the listing from search and browse.

Sidebar, out of scope but relevant to the parent decision: self-hosted CRX auto-update is not a
route on Windows/macOS for non-managed Chrome — the store is effectively the only channel short of
enterprise force-install policy or unpacked dev-mode loading.

Cite: <https://developer.chrome.com/docs/webstore/cws-dashboard-distribution>

---

## Summary table

| # | Gate | Status |
|---|------|--------|
| G1 | In-extension prominent disclosure + affirmative consent | **BLOCKING** |
| G2 | Privacy policy covering history/bookmarks/extension | **BLOCKING** |
| G3 | Limited Use affirmative statement on the site | **BLOCKING** |
| G4 | `http://localhost/*` cleartext transmission | **BLOCKING** |
| G5 | Reviewer-usable server + token + test instructions | **BLOCKING** |
| G6 | `https://*/*` optional host permission | FIXABLE (trade-off) |
| G7 | Single purpose statement | FIXABLE |
| G8 | Per-permission justifications | FIXABLE |
| G9 | Data-type disclosure + 3 certifications | FIXABLE |
| G10 | Post-install change notification (Aug 2026) | FIXABLE |
| G11 | 180-day bulk first sync optics | FIXABLE (risk) |
| G12 | No remote code | **SATISFIED** |
| G13 | Pasted bearer token in `chrome.storage.local` | FIXABLE — not a violation |
| G14 | Icons / screenshots / listing assets | FIXABLE |
| G15 | $5 developer account | FIXABLE (mechanical) |
| G16 | Review timeline | informational |
| G17 | Versioning / re-review on every bump | informational |
| G18 | Unlisted/private relaxes nothing | informational |

## Unverified items

- $5 fee amount and the 20-item cap (secondary sources only; the official register page states
  neither).
- `history` being on a formal "guaranteed manual review" permission list (secondary sources; the
  official doc says only "dangerous permission requests" slow review).
- Whether the at-rest-encryption clause is ever applied by reviewers to `chrome.storage.local`.
- Chrome's extension auto-update polling interval.
- The exact verbatim text of the three dashboard certification checkboxes (paraphrased from the
  Limited Use policy and secondary sources; the policies page does not enumerate them).

## Sources

- [Limited Use — CWS Program Policies](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
- [Updated Privacy Policy & Secure Handling Requirements (User Data FAQ)](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Use of Permissions](https://developer.chrome.com/docs/webstore/program-policies/permissions)
- [Quality Guidelines / Single Purpose](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines)
- [Chrome Web Store Program Policies (index)](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [CWS policy updates 2026 (effective 1 Aug 2026)](https://developer.chrome.com/blog/cws-policy-updates-2026)
- [Fill out the privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [Provide test instructions](https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions)
- [Chrome Web Store review process](https://developer.chrome.com/docs/webstore/review-process)
- [Set visibility and distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)
- [Publish in the Chrome Web Store](https://developer.chrome.com/docs/webstore/publish)
- [Update your Chrome Web Store item](https://developer.chrome.com/docs/webstore/update)
- [Register your developer account](https://developer.chrome.com/docs/webstore/register)
- [History-Sync — live CWS listing (precedent)](https://chromewebstore.google.com/detail/history-sync/ojlbohecelachobghomlemeepgakkgbi)
