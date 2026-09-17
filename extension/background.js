const IMPORT_LOOKBACK_DAYS = 180; // must match server IMPORT_LOOKBACK_DAYS default
const SYNC_ALARM = "earcue-sync";
const BOOKMARK_INTERVAL_MS = 7 * 86400000;
const HISTORY_PAGE = 5000;
const PAGE_CONTENT_SCRIPT_ID = "earcue-page";

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 60 });
  syncAll();
  maybeRegisterPageCapture();
});

chrome.runtime.onStartup?.addListener(() => {
  maybeRegisterPageCapture();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncAll();
});

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

async function postJson(baseUrl, token, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

async function getJson(baseUrl, token, path) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
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

  let importId = null;
  let accepted = 0;
  try {
    ({ importId } = await postJson(baseUrl, token, "/api/assist/begin", {
      source: "browser_history",
      label: "extension",
    }));

    for (const rows of chunk(items, 300)) {
      await postJson(baseUrl, token, "/api/assist/browser", {
        importId,
        kind: "history",
        rows: rows.map((r) => ({
          url: r.url,
          title: r.title,
          lastVisitTime: r.lastVisitTime,
          visitCount: r.visitCount,
          typedCount: r.typedCount,
        })),
      });
      accepted += rows.length;
    }

    await postJson(baseUrl, token, "/api/assist/finish", { importId, status: "complete" });
    await chrome.storage.local.set({ lastSyncMs: endTime });
  } catch (err) {
    // Advance only over rows the server accepted; the next alarm retries the rest (upserts are idempotent).
    console.error("earcue history sync failed", err);
    await chrome.storage.local.set({ lastSyncMs: historyCursor(items, accepted, startTime) });
    if (importId) {
      await postJson(baseUrl, token, "/api/assist/finish", { importId, status: "failed" }).catch((e) => console.error("earcue history finish failed", e));
    }
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

  try {
    const { importId } = await postJson(baseUrl, token, "/api/assist/begin", {
      source: "browser_bookmarks",
      label: "extension",
    });

    for (const part of chunk(rows, 300)) {
      await postJson(baseUrl, token, "/api/assist/browser", { importId, kind: "bookmarks", rows: part });
    }

    await postJson(baseUrl, token, "/api/assist/finish", { importId, status: "complete" });
    await chrome.storage.local.set({ lastBookmarkMs: Date.now() });
  } catch (err) {
    console.error("earcue bookmarks sync failed", err);
  }
}

async function syncAll() {
  const { baseUrl, token } = await chrome.storage.local.get(["baseUrl", "token"]);
  if (!baseUrl || !token) return; // not configured yet; options page hasn't been saved
  await syncHistory(baseUrl, token);
  await syncBookmarks(baseUrl, token);
  await syncExcludes(baseUrl, token);
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

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "page") sendPage(message);
});
