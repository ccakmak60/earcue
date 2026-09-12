# 002 — WAHA self-host facts

Research output for ticket `002-waha-self-host-facts`. Facts + citations only. No hosting
recommendation (separate ticket). Retrieved 2026-09-12.

Sources are WAHA's own docs (`waha.devlike.pro`) and the `devlikeapro/waha` source on the `core`
branch unless noted. Anything I could not confirm from a primary source is marked **unverified**.

---

## 1. Licensing — Core vs Plus

**Verdict: nothing `waha.js` calls is paywalled. WAHA Plus no longer exists.**

> "Yes! Starting from version **2026.6.1**, **WAHA** is 100% free and open source - all features are
> available for everyone, with no paid tiers and no separate "Plus" image."
> — [FAQ › Is WAHA free?](https://waha.devlike.pro/docs/overview/faq/)

Everything that used to be Plus is now in Core: unlimited sessions, unlimited text + multimedia
messages, all storages (PostgreSQL, S3, MongoDB), built-in security features.
([FAQ](https://waha.devlike.pro/docs/overview/faq/),
[WAHA Plus page](https://waha.devlike.pro/docs/how-to/waha-plus/))

- Docker image: **`devlikeapro/waha`** (single public image). `devlikeapro/waha-plus` and the Patron
  Portal authenticated pull are deprecated / obsolete since 2026.6.1.
  ([WAHA Plus](https://waha.devlike.pro/docs/how-to/waha-plus/))
- The only paid thing left is a voluntary **Community tier, $5/mo** on Patreon/Boosty/Crypto, which
  the docs describe as having "no perks."
  ([Support Us](https://waha.devlike.pro/pricing/), [FAQ](https://waha.devlike.pro/docs/overview/faq/))
- Historically (pre-2026.6.1) Plus was ~$5/mo on Patreon and gated unlimited sessions, media,
  Postgres/Mongo/S3 storage, API-key security, and metrics/health endpoints. Irrelevant now unless
  you pin an image older than 2026.6.1.

**Per-endpoint check of what `api/_lib/waha.js` calls** — all present in Core, all supported by all
four engines ([Engines feature matrix](https://waha.devlike.pro/docs/how-to/engines/)):

| Call in `waha.js` | Docs status | WEBJS | WPP | GOWS | NOWEB |
|---|---|---|---|---|---|
| `GET /api/sessions/{name}` | free | ✔ | ✔ | ✔ | ✔ |
| `POST /api/sessions` (create) | free | ✔ | ✔ | ✔ | ✔ |
| `POST /api/sessions/{name}` (update) | free | ✔ | ✔ | ✔ | ✔ |
| `POST /api/sessions/{name}/start` | free | ✔ | ✔ | ✔ | ✔ |
| `POST /api/sessions/{name}/logout` | free | ✔ | ✔ | ✔ | ✔ |
| `DELETE /api/sessions/{name}` | free | ✔ | ✔ | ✔ | ✔ |
| `GET /api/{session}/auth/qr` | free | ✔ | ✔ | ✔ | ✔ |
| `GET /api/{session}/chats/overview` | free | ✔ | ✔ | ✔ | ✔¹ |
| `GET /api/{session}/chats/{chatId}/messages` | free | ✔ | ✔ | ✔ | ✔¹ |

¹ NOWEB requires `config.noweb.store.enabled = true` — "you need to **Enable Store** to get chats,
contacts and messages." ([Engines › Chats](https://waha.devlike.pro/docs/how-to/engines/),
[NOWEB](https://waha.devlike.pro/docs/engines/noweb/))

**Doc typo worth knowing:** the engines matrix lists QR as `POST /api/{session}/auth/qr`, but the
Sessions page and all its code samples use `GET /api/{session}/auth/qr` (and `?format=raw`).
`waha.js` uses GET — correct.
([Sessions › Get QR](https://waha.devlike.pro/docs/how-to/sessions/))

---

## 2. Engines

Four engines, selected with `WHATSAPP_DEFAULT_ENGINE`. WEBJS is the default.
([Engines](https://waha.devlike.pro/docs/how-to/engines/))

| | Transport | Browser | Image |
|---|---|---|---|
| WEBJS (default) | Puppeteer → real WhatsApp Web | Chromium/Chrome | `devlikeapro/waha:latest`, `:chrome`, `:arm` |
| WPP | Puppeteer → real WhatsApp Web | Chromium/Chrome | same |
| NOWEB | WebSocket, Node/TS (Baileys) | none | `devlikeapro/waha:noweb`, `:noweb-arm` |
| GOWS | WebSocket, Golang (whatsmeow) | none | `devlikeapro/waha:gows` |

GOWS is described as "a new generation engine written in Golang, a **future replacement for NOWEB**."
NOWEB: "Not running Chromium saves you CPU and Memory, so you can run more instances on a single
server!" ([Engines](https://waha.devlike.pro/docs/how-to/engines/))

**Measured footprint** (WAHA's own table, [FAQ › How much CPU and Memory does WAHA need?](https://waha.devlike.pro/docs/overview/faq/)):

| Sessions in container | WEBJS | NOWEB | GOWS |
|---|---|---|---|
| 1 | 0.3 CPU / 400 MB | 0.1 CPU / 200 MB | 0.1 CPU / 200 MB |
| 10 | 3 CPU / 2.5 GB | 1 CPU / 2 GB | 0.5 CPU / 1 GB |
| 50 | 15 CPU / 20 GB | 2 CPU / 4 GB | 1.5 CPU / 3 GB |
| 100 | — | 4 CPU / 8 GB | 3–5 CPU / 5 GB |
| 500 | — | — | 5–8 CPU / 25 GB |

**Which survives restarts best** — the docs make no explicit ranking claim, so this is inference,
not a quote: GOWS/NOWEB hold only a WebSocket + auth creds on disk, whereas WEBJS/WPP must relaunch
Chromium and restore a browser profile, which is the heavier and more failure-prone path. Treat
"GOWS restarts most reliably" as **unverified** — WAHA does not state it. What the docs *do* say is
that autostart-after-restart is engine-independent: `WAHA_WORKER_RESTART_SESSIONS=True` (default) has
each worker restore its own sessions, and `WHATSAPP_RESTART_ALL_SESSIONS=True` (default **False**)
also starts `STOPPED` sessions on container restart.
([Config](https://waha.devlike.pro/docs/how-to/config/), [Sessions › Autostart](https://waha.devlike.pro/docs/how-to/sessions/))

**Engine caveat that matters for this codebase:**

> "**API responses** and **webhook payloads** may differ significantly, **test your system before
> changing the engine**!" — [Engines](https://waha.devlike.pro/docs/how-to/engines/)

Also: each engine has its own storage namespace (`WAHA_NAMESPACE` / `WAHA_SESSION_NAMESPACE`,
defaulting to the engine name), so **switching engines invalidates existing session auth and forces a
re-scan** unless you deliberately share namespaces. ([Engines](https://waha.devlike.pro/docs/how-to/engines/))

---

## 3. Session persistence

**What must be on a volume:** `/app/.sessions`.

```yaml
volumes:
  - ./.sessions:/app/.sessions
```
([Install › Docker](https://waha.devlike.pro/docs/how-to/install/),
[Storages](https://waha.devlike.pro/docs/how-to/storages/))

- Base dir overridable with `WAHA_LOCAL_STORE_BASE_DIR`.
- Local file storage is the default and is "a **well-tested solution** even for **production** with
  multiple sessions."
- Alternatives, all free: PostgreSQL (`WHATSAPP_SESSIONS_POSTGRESQL_URL`, one DB per session named
  `waha_{session_namespace}_{session}`) and MongoDB (`WHATSAPP_SESSIONS_MONGO_URL`, **deprecated**).
- Multi-instance against one DB needs a distinct `WAHA_WORKER_ID` per instance.
- NOWEB with store enabled additionally writes `.sessions/noweb/{sessionName}/store.sqlite3` holding
  chats/contacts/messages. Docs: "We don't recommend opening it manually when the session is
  running, even for reading, it can lead to the loss of the chat history."
  ([NOWEB](https://waha.devlike.pro/docs/engines/noweb/))
- Sessions doc, verbatim: "If you want to save your session and do not scan QR code everytime when
  you launch WAHA - connect the session storage to the container."
  ([Sessions](https://waha.devlike.pro/docs/how-to/sessions/))
- `POST /sessions/{s}/stop` is safe: "**Stop** doesn't **Log out** or **Delete** anything" and is
  idempotent. `POST /sessions/{s}/logout` *does* drop the WhatsApp pairing → next start needs a new
  QR. `waha.js#deleteSession()` calls logout then DELETE, which is the correct destructive pair.
  ([Sessions](https://waha.devlike.pro/docs/how-to/sessions/))

**How long an authenticated session survives untouched:** this is a WhatsApp limit, not a WAHA one.
WhatsApp logs out linked devices if the primary phone doesn't come online — you must "log in to
WhatsApp on your primary phone every 14 days to keep linked devices connected."
([WhatsApp Help Center › About linked devices](https://faq.whatsapp.com/378279804439436))
The exact WhatsApp help text is paywalled behind a JS-rendered page; the 14-day figure is
consistently reported but I could only retrieve it via search snippet — treat the *precise wording*
as **unverified**, the 14-day number as high confidence. WAHA's own docs state no expiry.

---

## 4. Failure modes

### `session.status` values
([Sessions › Session Status](https://waha.devlike.pro/docs/how-to/sessions/),
[Events › session.status](https://waha.devlike.pro/docs/how-to/events/))

| Status | Meaning | User must re-scan? |
|---|---|---|
| `STOPPED` | session is stopped | no — just start it |
| `STARTING` | session is starting | no |
| `SCAN_QR_CODE` | "session is required to scan QR code or login via phone number" | **yes** |
| `PASSKEY_REQUIRED` | WhatsApp asks for a passkey (WebAuthn) to finish pairing; `payload.data` holds the challenge | **yes — user action** |
| `PASSKEY_CONFIRMATION_REQUIRED` | user must check a code before pairing completes; `payload.data` holds the code. "Most pairings never reach this status" | **yes — user action** |
| `WORKING` | working and ready; `data` may carry Reachout Timelock / Message Capping info | no |
| `FAILED` | "likely either authorization is required again or device has been disconnected from that account." Docs: restart; if that doesn't help, logout + start again | **probably** |

QR expiry: "The first QR code expires in **60 seconds**, then **20 seconds for each subsequent one**,
up to **6 QR codes total**. After that, the session moves to the `FAILED` status and needs to be
restarted." `SCAN_QR_CODE` is re-emitted on every QR refresh, so you must refetch the QR each time.
([Sessions](https://waha.devlike.pro/docs/how-to/sessions/))

`session.status` events are supported on all four engines.
([Receive messages / Engines matrices](https://waha.devlike.pro/docs/how-to/engines/))

### Phone offline
WhatsApp multi-device means the phone need not be online for WAHA to receive messages, but the
14-day rule above applies. WAHA's docs do not document a distinct "phone offline" status — a
prolonged offline phone surfaces as WhatsApp unlinking the device, which WAHA reports as `FAILED`
(→ "device has been disconnected from that account") or a return to `SCAN_QR_CODE`.
The specific transition is **unverified**.

### What WhatsApp does about unofficial clients
Two documented soft-enforcement mechanisms *before* an outright ban
([How to Avoid Blocking](https://waha.devlike.pro/docs/overview/how-to-avoid-blocking/),
[Sessions › Reachout Timelock / Message Capping](https://waha.devlike.pro/docs/how-to/sessions/)):

- **Reachout Timelock** — WhatsApp "shadow-restricts" accounts messaging too many *new* contacts.
  Sends to new contacts fail with `server returned error 463`. Session stays `WORKING` and connected.
  "Do **NOT** restart, logout or re-pair the session - the restriction lifts automatically" at
  `timeEnforcementEnds`. Query with `GET /api/sessions/{session}/timelock`. Engines: GOWS, NOWEB, WEBJS.
- **Message Capping** — a per-cycle quota on how many new contacts an account may message.
  `cappingStatus` goes `FIRST_WARNING` → `SECOND_WARNING` → `CAPPED`; resets at `cycleEnd`.
  "Messaging **existing chats** still works." "**WAHA** does **NOT** block any API calls while capped
  - WhatsApp enforces the quota server-side." Query with `GET /api/sessions/{session}/capping`.

WAHA's own guidance: "you **should never initiate a conversation**… your bot **should only reply**",
avoid bulk sends, and send-seen / start-typing / stop-typing before replying.
([How to Avoid Blocking](https://waha.devlike.pro/docs/overview/how-to-avoid-blocking/))

Earcue is read-only (ingest + backfill, no sends), so timelock/capping should not bite — but they are
the mechanisms that exist, and neither produces a status change your webhook would see.

---

## 5. Webhook semantics

### Delivery guarantees — the important part

There is **no durable queue**. `WebhookSender.send()` fires `axios.post(...)` and attaches
`.then()/.catch()` without awaiting or persisting anything
([`src/modules/waha-webhook/WebhookPlugin.sender.ts`](https://github.com/devlikeapro/waha/blob/core/src/modules/waha-webhook/WebhookPlugin.sender.ts)):

```ts
this.axios.post(this.url, body, { headers })
  .then((response) => { this.logger.info(ctx, `POST request was sent with status code: ...`) })
  .catch((error)  => { this.logger.error(ctx, `POST request failed: ${error.message}`) })
```

Consequences, all read straight off that file:

- **Best-effort, in-memory.** If retries are exhausted, or the container is killed/redeployed mid-
  flight, the event is **dropped silently** (logged only). There is no dead-letter, no replay.
  Practically: **at-least-once while retrying, no-delivery-at-all after that.** Any gap has to be
  closed by the backfill path (`chats/{id}/messages`), not by WAHA.
- **Every failure retries**, including 4xx: `retryCondition: (error) => true`. So a 401/404/500 from
  the Vercel endpoint retries just as hard as a timeout. (This is exactly why the handler returns
  `200` on quota-exceeded rather than `429` — that comment in `api/connect/[action].js` is correct.)
- **No client timeout is configured** on the axios instance, so the Node default (no timeout) applies.
  A hung Vercel function holds the connection rather than failing fast. **Unverified** whether an
  agentkeepalive default caps this.
- Defaults if you omit `retries`: `DEFAULT_RETRY_ATTEMPTS = 15`, `DEFAULT_RETRY_DELAY_SECONDS = 2`,
  policy `constant`.

### Retry policies
([Events › Retries](https://waha.devlike.pro/docs/how-to/events/))

- `constant` — same delay each time (2, 2, 2, 2)
- `linear` — linear backoff (2, 4, 6, 8)
- `exponential` — "exponential backoff with **20% jitter** (2, 4.1, 8.4, 16.3)"

Source formula: `2 ** retryNumber * delayFactor`, plus `delay * 0.2 * Math.random()`, and floored by
any `Retry-After` header (`Math.max(calculatedDelay, retryAfter(error))`).

**Earcue's configured policy** (`exponential / delaySeconds 2 / attempts 5`) therefore gives 5 retries
after the initial POST, at roughly **2s, 4s, 8s, 16s, 32s** each +0–20% jitter — a total delivery
window of **~62–75 seconds**. After that the event is gone. (The exact off-by-one on the first delay
— whether it's 2s or 4s — depends on whether `axios-retry` passes `retryCount` starting at 0 or 1;
the docs' stated sequence starts at 2s. Minor, marked **unverified**.)

Global equivalents exist as env vars: `WHATSAPP_HOOK_URL`, `WHATSAPP_HOOK_EVENTS`,
`WHATSAPP_HOOK_HMAC_KEY`, `WHATSAPP_HOOK_RETRIES_POLICY`, `WHATSAPP_HOOK_RETRIES_DELAY_SECONDS`,
`WHATSAPP_HOOK_RETRIES_ATTEMPTS`, `WHATSAPP_HOOK_CUSTOM_HEADERS`. Note: "That webhook configuration
**does not appear** in `session.config` field in `GET /api/sessions/`" — a per-session config like
Earcue's is visible, a global one is not.
([Events](https://waha.devlike.pro/docs/how-to/events/))

### Duplicates — yes, they happen

1. **Retry duplicates.** If the Vercel handler processes an event and then fails to return 2xx
   (timeout, cold-start kill, 502 at the edge), WAHA retries the identical body. Dedup is required.
2. **Engine-level duplicates.** [Issue #1564](https://github.com/devlikeapro/waha/issues/1564)
   ("[GOWS] - Duplicate webhook events for first incoming message from new sender"): the *first*
   message from a new contact fires **two `message` events** with the **same `payload.id`** —
   one carrying `Message.extendedTextMessage.text` + `Info.VerifiedName`/`PushName`, the other
   carrying `Message.conversation` and `_data.SourceWebMsg`. Reporter's recommended mitigation is
   dedup by message ID. Issue is closed; no maintainer comment was retrievable — **fix status
   unverified.**
3. `group.v2.participants` is documented as possibly duplicating `group.v2.join`/`leave` — not
   subscribed here, noted only as evidence that WAHA does not promise exactly-once.

**Bearing on `externalId`:** `externalId = "waha:" + msg.id` is the right dedup key. `msg.id` is a
string and stable across both retry duplicates and the GOWS first-contact duplicate. The envelope
also carries a stable event id (`"id": "evt_1111…"`) and a per-request `X-Webhook-Request-Id` header
— the request id is generated once in `send()` and reused across retries, so it is *not* useful for
distinguishing a retry from a genuine second event.

### Headers
([Events › Headers](https://waha.devlike.pro/docs/how-to/events/))

- `X-Webhook-Request-Id` — unique per webhook request
- `X-Webhook-Timestamp` — unix ms
- `X-Webhook-Hmac` + `X-Webhook-Hmac-Algorithm: sha512` — only when `config.hmac.key` is set
  (hex digest of the raw body). Earcue uses `customHeaders` + a shared secret instead, which is
  functionally equivalent for authentication but not replay-resistant.
- `User-Agent: WAHA/{version}`, `content-type: application/json`
- Any `customHeaders` entries (Earcue's `X-Earcue-Waha-Token`)

### Envelope shape
([Events](https://waha.devlike.pro/docs/how-to/events/))

```json
{
  "id": "evt_1111111111111111111111111111",
  "timestamp": 1741249702485,
  "event": "message",
  "session": "default",
  "metadata": { "user.id": "123", "user.email": "email@example.com" },
  "me": { "id": "71111111111@c.us", "pushName": "~" },
  "payload": {},
  "engine": "WEBJS",
  "environment": { "tier": "CORE", "version": "2023.10.12" }
}
```

`api/connect/[action].js` reads `body.session`, `body.event`, `body.payload`, `body.me.id` — all
correct against this envelope. `metadata` carries `earcue.userId` but is unused (session-name lookup
is used instead); fine.

---

## 6. The `message` payload vs `normalizeWahaMessage()`

Documented payload ([Events › message](https://waha.devlike.pro/docs/how-to/events/), and the
authoritative DTO [`src/structures/responses.dto.ts`](https://github.com/devlikeapro/waha/blob/core/src/structures/responses.dto.ts)):

```json
{
  "id": "true_11111111111@c.us_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "timestamp": 1667561485,
  "from": "11111111111@c.us",
  "fromMe": true,
  "source": "app",
  "to": "11111111111@c.us",
  "body": "Hi there!",
  "hasMedia": false,
  "ack": 1,
  "participant": null,
  "vCards": [],
  "_data": { }
}
```

DTO field semantics worth quoting:

- `to`: "ID for who this message is for. If the message is sent by the current user, it will be the
  Chat to which the message is being sent. If the message is sent by another user, it will be the ID
  for the current user."
- `from`: "ID for the Chat that this message was sent to, except if the message was sent by the
  current user"
- `participant`: "For groups - participant who sent the message"
- `source`: "either API or APP. **Available in events (webhooks/websockets) only and only
  `fromMe: true` messages.**"
- `_data`: "**Message in a raw format that we get from WhatsApp. May be changed anytime, use it with
  caution! It depends a lot on the underlying backend.**"

### Field-by-field verdict

| `normalizeWahaMessage()` reads | Documented? | Verdict |
|---|---|---|
| `msg.id` | yes, `string` | ✅ OK. Stable dedup key. |
| `msg.timestamp` | yes, "Unix timestamp for when the message was created", example `1666943582` (**seconds**) | ✅ OK — `* 1000` is correct. |
| `msg.body` | yes | ✅ OK. Empty for media-only messages → normalizer returns `null`, so image/voice notes are silently dropped. Intentional? |
| `msg.from` | yes | ✅ OK |
| `msg.to` | yes | ✅ OK — the `fromMe ? to : from` chat-id pick matches the DTO exactly. |
| `msg.fromMe` | yes | ⚠️ see below |
| `msg._data.notifyName` | **no** | ❌ **undocumented, WEBJS-only** |
| `msg._data.pushName` | **no** | ⚠️ **NOWEB-only casing** |

### ❌ Mismatch 1 — the display name lookup is engine-specific and breaks on GOWS

`_data` is explicitly "raw format… depends a lot on the underlying backend." Neither `notifyName` nor
`pushName` appears anywhere in WAHA's documented `message` payload. What each engine actually puts
there:

- **WEBJS** — `_data` is the raw `whatsapp-web.js` message object, which carries `notifyName`.
  Not documented by WAHA; **unverified** against a live payload, but this is the only engine for
  which `_data.notifyName` is plausible and it is presumably where the code's author got it.
- **NOWEB** — `_data` is the raw Baileys message. Confirmed to contain **`pushName`** at the top
  level of `_data`, alongside `key`, `messageTimestamp`, `broadcast`, `status`.
  ([NOWEB › Get messages](https://waha.devlike.pro/docs/engines/noweb/), quoted example)
- **GOWS** — `_data` is the raw whatsmeow struct with Go-style capitalised fields. Issue #1564 shows
  `_data.Info.ID`, `_data.Info.VerifiedName`, `_data.Info.Type`, `_data.SourceWebMsg`, and a
  "filled `Info.VerifiedName` / `PushName`". So the path is **`_data.Info.PushName`**, not
  `_data.pushName`. ([Issue #1564](https://github.com/devlikeapro/waha/issues/1564))

**Impact:** on GOWS — the engine the memory table makes most attractive — both `_data.notifyName` and
`_data.pushName` are `undefined`, so every webhook-ingested item falls through to
`chatId.replace(/@.*$/, "")` and every WhatsApp title becomes `WhatsApp — 447700900123`. On NOWEB it
works via `pushName`. On WEBJS it works via `notifyName`. The exact GOWS casing is inferred from the
issue's payload dump and is **unverified** against a live GOWS webhook — verify before coding a fix.

Note this only affects the **webhook** path: the backfill calls `normalizeWahaMessage(msg, chatName)`
with a real chat name from `chats/overview`, which wins over `_data`. The webhook handler passes no
second argument.

Cheap fix if you want it engine-proof: also check `msg._data?.Info?.PushName` and `msg.participant`,
or resolve names once from `chats/overview` and cache by `chatId` rather than trusting `_data`.

### ⚠️ Mismatch 2 — `message` vs `message.any` and `fromMe`

The docs describe `message` as "**Incoming** message (text/audio/files)" and `message.any` as "Fired
on **all** message creations, **including your own**." That implies `fromMe: true` never arrives on
the `message` event — yet WAHA's own documented `message` example has `fromMe: true`, and `source`
is documented as present "only `fromMe: true` messages" in events.
([Events](https://waha.devlike.pro/docs/how-to/events/))

So the docs contradict themselves and I can't settle it from the docs alone — **unverified**. The
normalizer's `fromMe` branch is harmless either way (it's needed for the backfill regardless), but if
you expected to capture the user's own outgoing messages live, subscribing to `message` may not do
it; `message.any` would.

### ⚠️ Mismatch 3 — group messages are not filtered

Session config uses `ignore: { status: true, channels: true }`. `ignore` also supports **groups**
(docs list "status updates, groups, channels, and broadcasts"), which is not set — so group messages
arrive, and `chatId` becomes the `@g.us` group id while the actual sender sits in `participant`
(which the normalizer ignores). If group chatter is not wanted context, add `groups: true` to
`ignore`. ([Sessions › config.ignore](https://waha.devlike.pro/docs/how-to/sessions/))

### ⚠️ Mismatch 4 — new statuses not handled

`ensureSession()` only restarts on `STOPPED`/`FAILED`, and the webhook only special-cases `FAILED`.
`PASSKEY_REQUIRED` and `PASSKEY_CONFIRMATION_REQUIRED` are newer statuses that also require user
action and currently produce no `last_error` and no UI signal.

### Chat-id formats you may see in `from`/`to`/`participant`
([Receive messages › chatId, from, to, participant](https://waha.devlike.pro/docs/how-to/receive-messages/))

- `123123123@c.us` — user account (phone number, no `+`)
- `123123123@s.whatsapp.net` — "can also appear in internal `_data` field for **GOWS, NOWEB**.
  Convert it to `@c.us`… Kindly don't use it in `chatId` when sending messages"
- `123123123@lid` — hidden user ID (community feature); every user has one alongside the regular ID
- `12312312123133@g.us` — group
- `status@broadcast` — already filtered by the normalizer ✅

The `@lid` case is worth flagging: a `from` of `…@lid` would produce a title like
`WhatsApp — 123123123` and a `chatId` that won't match the `@c.us` id seen in the backfill, so the
same human could produce two chat identities. **Unverified** whether WAHA normalises `@lid` → `@c.us`
in the `message` payload's top-level `from`.

---

## 7. Reachability

Two independent directions; both must hold.

**Vercel → container (REST).** Every call in `waha.js` is Vercel-function-initiated, so the WAHA
container needs a **publicly resolvable HTTPS endpoint** reachable from Vercel's egress. That means a
domain + TLS in front of port 3000 (reverse proxy, or a panel that provisions certs — EasyPanel and
Coolify are both documented as doing SSL for you
([Install](https://waha.devlike.pro/docs/how-to/install/))), plus `WHATSAPP_API_KEY` set so the
endpoint is not open ([Security](https://waha.devlike.pro/docs/how-to/security/)).

- **You cannot IP-allowlist Vercel.** "By default, Vercel deployments can come from **any IP
  address**." Dedicated static egress IPs require **Secure Compute**, which "is available as an
  Enterprise feature." ([Vercel › Secure Compute](https://vercel.com/docs/networking/secure-compute))
  So the API key (and ideally `WHATSAPP_API_KEY_EXCLUDE_PATH` left tight) is the only access control
  available on a Hobby/Pro plan.

**Container → Vercel (webhooks).** WAHA POSTs to `webhookUrl()`, so the container needs **outbound
HTTPS to the public internet** and must be able to resolve the Vercel hostname. No inbound
requirement in this direction. Note the sender uses
`new HttpsAgent({ rejectUnauthorized: false })` — WAHA does **not** verify the TLS certificate of your
webhook endpoint ([`WebhookPlugin.sender.ts`](https://github.com/devlikeapro/waha/blob/core/src/modules/waha-webhook/WebhookPlugin.sender.ts)).

**What `WAHA_WEBHOOK_BASE_URL` exists to work around.** Per the comment in `waha.js`, it is separate
from `BETTER_AUTH_URL` "because WAHA usually runs in Docker and cannot reach the host's `localhost`
during local dev." Concretely: in dev, `BETTER_AUTH_URL` is `http://localhost:3000`, which inside the
WAHA container resolves to the *container's own* loopback (and collides with WAHA's own port 3000),
so the webhook POST never reaches your dev server. `WAHA_WEBHOOK_BASE_URL` lets you point WAHA at
`http://host.docker.internal:3000` or an ngrok/tunnel URL instead. The same variable is what you'd
use in production if the container should reach the deployment on a different hostname than the one
users see. This is a Docker-networking constraint, not a WAHA feature — the docs' own workaround
suggestion for the same problem is webhook.site.
([Events › Global webhooks](https://waha.devlike.pro/docs/how-to/events/))

**Related host-visibility knob:** media download URLs are built from
`{WHATSAPP_API_SCHEMA}://{WHATSAPP_API_HOSTNAME}:{WHATSAPP_API_PORT}` (default `localhost`), or
`WAHA_BASE_URL` if set. Earcue passes `downloadMedia=false` and drops media, so this is currently
moot — but set `WAHA_BASE_URL` to the public URL if media is ever ingested, or `media.url` will be
unfetchable from Vercel. ([Config](https://waha.devlike.pro/docs/how-to/config/))

---

## 8. Minimum viable host

**WAHA's stated floor, regardless of engine:**

> "We **strongly recommend** using a VPS or server with a minimum **2CPU** and **4GB RAM**
> configuration for the project **even for a single session**."
> — [FAQ](https://waha.devlike.pro/docs/overview/faq/)

Their own per-session numbers are far lower (1 session: WEBJS 0.3 CPU / 400 MB; NOWEB and GOWS
0.1 CPU / 200 MB), so 2 vCPU / 4 GB is headroom for Chromium spikes, restarts and OS overhead rather
than steady state. A 1 vCPU / 2 GB box running GOWS or NOWEB is very likely fine for one session but
contradicts the vendor's stated minimum — noted as a judgement call, not a fact.

**Disk.** No sizing figure is published. The only signal is the health-check default
`WHATSAPP_HEALTH_SESSIONS_FILES_THRESHOLD_MB = 100` (and `..._MEDIA_FILES_THRESHOLD_MB = 100`), i.e.
WAHA expects session files to sit under ~100 MB before it starts complaining
([Config › Health Check](https://waha.devlike.pro/docs/how-to/config/)). With NOWEB store enabled,
`store.sqlite3` grows with chat history (`fullSync=false` ≈ 3 months of history, `fullSync=true`
≈ 1 year, max 100K messages/chat — [NOWEB](https://waha.devlike.pro/docs/engines/noweb/)). Any
common 20–40 GB VPS disk is ample for one session; exact per-session disk is **unverified**.

**Rough monthly cost for 2 vCPU / 4 GB** (list prices, no host recommendation implied):

| Provider / plan | Spec | Price |
|---|---|---|
| DigitalOcean Basic Droplet | 2 vCPU / 4 GiB / 80 GiB SSD / 4,000 GiB transfer | **$24.00/mo** ([DO pricing](https://www.digitalocean.com/pricing/droplets)) |
| DigitalOcean Basic (one tier down) | 2 vCPU / 2 GiB / 60 GiB | $18.00/mo (same source) |
| Hetzner Cloud CX22 | 2 vCPU / 4 GB / 40 GB NVMe | ≈ **€4.35–4.59/mo** — **unverified**, secondary sources only; Hetzner's own page renders prices via JS and I could not read them |
| Contabo | 8 GB RAM / 200 GB SSD | ≈ $7/mo — **unverified**, secondary source; reported weak sustained CPU |
| Vultr Cloud Compute | entry tiers | from $2.50/mo — **unverified**, secondary source; the 2 vCPU / 4 GB tier price was not retrieved |

So: **roughly $5–25/month** depending on provider, for the vendor-recommended 2 vCPU / 4 GB. Only the
DigitalOcean numbers come from a primary source. WAHA's docs themselves plug `the.hosting` as a
vendor they use ([FAQ](https://waha.devlike.pro/docs/overview/faq/)) — noted for completeness, not
priced.

---

## Loose ends flagged as unverified

1. Exact GOWS `_data` path for the sender's display name (`_data.Info.PushName` inferred from issue
   #1564's payload dump, not from a live webhook or the docs).
2. Whether `_data.notifyName` actually exists on WEBJS webhook payloads (undocumented by WAHA;
   inherited from whatsapp-web.js).
3. Whether the `message` event ever carries `fromMe: true` — docs contradict themselves.
4. Whether `@lid` ids can appear in top-level `from`, and whether WAHA normalises them.
5. First retry delay under `exponential`: 2s (per docs) vs 4s (per the source formula if
   `retryCount` starts at 1).
6. Whether any HTTP timeout applies to webhook POSTs (none set explicitly; agentkeepalive defaults
   not checked).
7. Whether GOWS/NOWEB genuinely restart more reliably than WEBJS — plausible but not a doc claim.
8. Exact `session.status` transition when the phone is offline past 14 days.
9. Whether issue #1564's GOWS duplicate is actually fixed (issue closed, no maintainer comment
   retrievable).
10. Hetzner / Vultr / Contabo list prices (secondary sources only).
