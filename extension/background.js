const IMPORT_LOOKBACK_DAYS = 180; // must match server IMPORT_LOOKBACK_DAYS default
const SYNC_ALARM = "earcue-sync";
const BOOKMARK_INTERVAL_MS = 7 * 86400000;
const HISTORY_PAGE = 5000;
const PAGE_CONTENT_SCRIPT_ID = "earcue-page";

// Per-pairing state: the history and bookmark cursors, the reused import ids and the last outcome.
// Pairing a different account (or another earcue origin) clears them, so its first sync starts
// from the lookback window again; unpairing clears them with the token.
const PAIRING_KEYS = [
  "lastSyncMs",
  "lastBookmarkMs",
  "historyImportId",
  "bookmarksImportId",
  "pageImportId",
  "pageImportDay",
  "syncedAt",
  "lastError",
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 60 });
  syncAll();
  maybeRegisterPageCapture();
  injectBridge();
});

chrome.runtime.onStartup?.addListener(() => {
  maybeRegisterPageCapture();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncAll();
});

// Declared content scripts only reach pages loaded after install, so an earcue tab that was open
// while the person installed the extension gets the bridge now and its Sources view sees it at once.
async function injectBridge() {
  const matches = chrome.runtime.getManifest().content_scripts?.[0]?.matches || [];
  const tabs = await chrome.tabs.query({ url: matches });
  for (const tab of tabs) {
    if (tab.id == null) continue;
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["bridge.js"] }).catch((err) => console.error("earcue bridge inject failed", err));
  }
}

// Copies of src/lib/shared/history-paging.ts (the extension imports nothing from src/); tests/unit/shared/history-paging.test.ts covers them there.
// ponytail: lastVisitTime is a URL's latest visit overall, so a full page made only of URLs already seen on newer
// pages cannot move endTime back and paging stops; needs 5000 distinct re-visited URLs in one window.
function nextHistoryEnd(page, maxResults, endTime) {
  if (page.length < maxResults) return null;
  const next = Math.min(...page.map((r) => r.lastVisitTime)) + 1;
  return next < endTime ? next : null;
}

function historyCursor(rowsOldestFirst, accepted, startTime) {
  return accepted > 0 ? rowsOldestFirst[accepted - 1].lastVisitTime : startTime;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function httpError(path, status) {
  const err = new Error(`${path} ${status}`);
  err.status = status;
  return err;
}

async function postJson(baseUrl, token, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw httpError(path, res.status);
  return res.json();
}

async function getJson(baseUrl, token, path) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw httpError(path, res.status);
  return res.json();
}

// One import per source for the life of a pairing: each sync appends its rows and finishes it
// again, so Sources lists one "Browsing history" row rather than one per hourly sync. A 404 means
// the person removed that import in Sources; the rows go to a new one.
async function importRows(baseUrl, token, { source, kind, rows, onAccepted }) {
  const key = `${kind}ImportId`;
  let { [key]: importId } = await chrome.storage.local.get([key]);
  async function begin() {
    ({ importId } = await postJson(baseUrl, token, "/api/assist/begin", { source, label: "extension" }));
    await chrome.storage.local.set({ [key]: importId });
  }
  if (!importId) await begin();

  try {
    for (const part of chunk(rows, 300)) {
      try {
        await postJson(baseUrl, token, "/api/assist/browser", { importId, kind, rows: part });
      } catch (err) {
        if (err.status !== 404) throw err;
        await begin();
        await postJson(baseUrl, token, "/api/assist/browser", { importId, kind, rows: part });
      }
      await onAccepted?.(part.length);
    }
    await postJson(baseUrl, token, "/api/assist/finish", { importId, status: "complete" });
  } catch (err) {
    await postJson(baseUrl, token, "/api/assist/finish", { importId, status: "failed" }).catch((e) => console.error(`earcue ${kind} finish failed`, e));
    throw err;
  }
}

async function syncHistory(baseUrl, token) {
  const { lastSyncMs } = await chrome.storage.local.get(["lastSyncMs"]);
  const startTime = lastSyncMs ?? Date.now() - IMPORT_LOOKBACK_DAYS * 86400000;
  const endTime = Date.now();

  // One search call caps at HISTORY_PAGE most-recent URLs; walk endTime back until a page comes up
  // short so a busy window never silently drops its oldest visits.
  const byUrl = new Map();
  for (let end = endTime; end != null; ) {
    const page = await chrome.history.search({ text: "", startTime, endTime: end, maxResults: HISTORY_PAGE });
    for (const r of page) if (!byUrl.has(r.url)) byUrl.set(r.url, r);
    end = nextHistoryEnd(page, HISTORY_PAGE, end);
  }
  if (byUrl.size === 0) {
    await chrome.storage.local.set({ lastSyncMs: endTime });
    return;
  }
  const items = [...byUrl.values()].sort((a, b) => a.lastVisitTime - b.lastVisitTime);

  let accepted = 0;
  try {
    await importRows(baseUrl, token, {
      source: "browser_history",
      kind: "history",
      rows: items.map((r) => ({
        url: r.url,
        title: r.title,
        lastVisitTime: r.lastVisitTime,
        visitCount: r.visitCount,
        typedCount: r.typedCount,
      })),
      onAccepted: (n) => {
        accepted += n;
      },
    });
    await chrome.storage.local.set({ lastSyncMs: endTime });
  } catch (err) {
    // Advance only over rows the server accepted; the next sync retries the rest (upserts are idempotent).
    await chrome.storage.local.set({ lastSyncMs: historyCursor(items, accepted, startTime) });
    throw err;
  }
}

function flattenBookmarks(nodes, pathParts) {
  const rows = [];
  for (const node of nodes) {
    if (node.url) {
      rows.push({
        url: node.url,
        title: node.title || "",
        addedAt: node.dateAdded ? new Date(node.dateAdded).toISOString() : undefined,
        folder: pathParts.join("/"),
      });
    }
    if (node.children) {
      const nextPath = node.title ? [...pathParts, node.title] : pathParts;
      rows.push(...flattenBookmarks(node.children, nextPath));
    }
  }
  return rows;
}

async function syncBookmarks(baseUrl, token) {
  const { lastBookmarkMs } = await chrome.storage.local.get(["lastBookmarkMs"]);
  if (lastBookmarkMs && Date.now() - lastBookmarkMs < BOOKMARK_INTERVAL_MS) return;

  const tree = await chrome.bookmarks.getTree();
  const rows = flattenBookmarks(tree, []);
  if (rows.length === 0) {
    await chrome.storage.local.set({ lastBookmarkMs: Date.now() });
    return;
  }

  await importRows(baseUrl, token, { source: "browser_bookmarks", kind: "bookmarks", rows });
  await chrome.storage.local.set({ lastBookmarkMs: Date.now() });
}

// Single-flight: the hourly alarm, a pairing and the Sources view's Sync now share one run.
let syncing = null;

function syncAll() {
  if (!syncing) syncing = runSync().finally(() => (syncing = null));
  return syncing;
}

async function runSync() {
  const { baseUrl, token } = await chrome.storage.local.get(["baseUrl", "token"]);
  if (!baseUrl || !token) return; // not paired yet
  try {
    await syncHistory(baseUrl, token);
    await syncBookmarks(baseUrl, token);
    await syncExcludes(baseUrl, token);
    await chrome.storage.local.set({ syncedAt: Date.now(), lastError: null });
  } catch (err) {
    console.error("earcue sync failed", err);
    await chrome.storage.local.set({ lastError: syncErrorCode(err) });
  }
}

// What the Sources view says about a failed sync. 401 means the token was revoked (disconnected
// from another browser, or the account deleted): the person connects again.
function syncErrorCode(err) {
  if (err?.status === 401) return "signed_out";
  if (err?.status === 402) return "payment_required";
  if (err?.status === 429) return "quota";
  return "failed";
}

// Caches the server's capture switch and skip list locally so page-capture.js enforces them
// without a network round trip on every page, and so the server check in handlePage stays a backstop.
async function syncExcludes(baseUrl, token) {
  try {
    const { excludedDomains, capturePages } = await getJson(baseUrl, token, "/api/assist/excludes");
    await chrome.storage.local.set({ skip: excludedDomains || [], capturePages: capturePages !== false });
  } catch (err) {
    console.error("earcue excludes sync failed", err);
  }
}

async function maybeRegisterPageCapture() {
  const granted = await chrome.permissions.contains({ origins: ["http://*/*", "https://*/*"] });
  if (!granted) return;
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [PAGE_CONTENT_SCRIPT_ID] });
  if (existing.length > 0) return;
  try {
    await chrome.scripting.registerContentScripts([
      {
        id: PAGE_CONTENT_SCRIPT_ID,
        matches: ["http://*/*", "https://*/*"],
        js: ["page-capture.js"],
        runAt: "document_idle",
        allFrames: false,
        persistAcrossSessions: true,
      },
    ]);
  } catch (err) {
    // Already registered from a previous session (race with getRegisteredContentScripts above).
    console.error("earcue page-capture registration failed", err);
  }
}

// Ensures a same-day "browser_pages" import row exists, retrying once on a stale cached id.
async function ensurePageImportId(baseUrl, token) {
  const today = new Date().toISOString().slice(0, 10);
  const { pageImportId, pageImportDay } = await chrome.storage.local.get(["pageImportId", "pageImportDay"]);
  if (pageImportId && pageImportDay === today) return pageImportId;

  if (pageImportId) {
    await postJson(baseUrl, token, "/api/assist/finish", { importId: pageImportId, status: "complete" }).catch((e) =>
      console.error("earcue page import finish failed", e)
    );
  }
  const { importId } = await postJson(baseUrl, token, "/api/assist/begin", { source: "browser_pages", label: "extension" });
  await chrome.storage.local.set({ pageImportId: importId, pageImportDay: today });
  return importId;
}

async function sendPage(message) {
  const { baseUrl, token } = await chrome.storage.local.get(["baseUrl", "token"]);
  if (!baseUrl || !token) return;

  let importId = await ensurePageImportId(baseUrl, token);
  const body = {
    importId,
    url: message.url,
    title: message.title,
    readMs: message.readMs,
    ts: message.ts,
    ...(message.text !== undefined ? { text: message.text } : {}),
  };
  try {
    await postJson(baseUrl, token, "/api/assist/page", body);
  } catch (err) {
    if (String(err.message || "").endsWith(" 404")) {
      // Cached import id is stale server-side; re-begin once and retry.
      await chrome.storage.local.remove(["pageImportId", "pageImportDay"]);
      try {
        importId = await ensurePageImportId(baseUrl, token);
        await postJson(baseUrl, token, "/api/assist/page", { ...body, importId });
        return;
      } catch (retryErr) {
        console.error("earcue page capture retry failed", retryErr);
        return;
      }
    }
    console.error("earcue page capture failed", err);
  }
}

// ---------- pairing with earcue's own pages (bridge.js) ----------

async function bridgeStatus(origin) {
  const state = await chrome.storage.local.get(["baseUrl", "token", "syncedAt", "lastError"]);
  return {
    ok: true,
    paired: Boolean(state.token) && state.baseUrl === origin,
    syncing: Boolean(syncing),
    syncedAt: state.syncedAt ?? null,
    lastError: state.lastError ?? null,
  };
}

// Revokes the token this extension holds (the server revokes the bearer it is called with), so a
// re-pair or an unpair leaves no live token behind. Best-effort: an unreachable server or an
// already revoked token changes nothing here.
async function revokeToken(baseUrl, token) {
  await postJson(baseUrl, token, "/api/assist/token-revoke", {}).catch((err) => console.error("earcue token revoke failed", err));
}

async function handleBridge(message, sender) {
  const origin = sender.origin || new URL(sender.url).origin;
  const state = await chrome.storage.local.get(["baseUrl", "token", "account"]);
  const paired = Boolean(state.token) && state.baseUrl === origin;

  if (message.action === "status") return bridgeStatus(origin);

  if (message.action === "pair") {
    if (typeof message.token !== "string" || !/^ec_it_\S+$/.test(message.token)) return { ok: false, error: "bad_token" };
    if (state.token && state.token !== message.token && state.baseUrl) await revokeToken(state.baseUrl, state.token);
    const sameAccount = state.baseUrl === origin && Boolean(state.account) && state.account === message.account;
    if (!sameAccount) await chrome.storage.local.remove(PAIRING_KEYS);
    await chrome.storage.local.set({ baseUrl: origin, token: message.token, account: message.account || null, lastError: null });
    syncAll();
    return bridgeStatus(origin);
  }

  if (message.action === "sync") {
    if (!paired) return { ok: false, error: "not_paired" };
    syncAll();
    return bridgeStatus(origin);
  }

  if (message.action === "unpair") {
    if (paired) {
      await revokeToken(state.baseUrl, state.token);
      await chrome.storage.local.remove(["token", "account", ...PAIRING_KEYS]);
    }
    return bridgeStatus(origin);
  }

  return { ok: false, error: "unknown_action" };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "page") sendPage(message);
  if (message?.type === "bridge" && sender.id === chrome.runtime.id) {
    handleBridge(message, sender).then(sendResponse, (err) => {
      console.error("earcue bridge request failed", err);
      sendResponse({ ok: false, error: "extension_error" });
    });
    return true; // answers asynchronously
  }
});
