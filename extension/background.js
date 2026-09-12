const IMPORT_LOOKBACK_DAYS = 180; // must match server IMPORT_LOOKBACK_DAYS default
const SYNC_ALARM = "earcue-sync";
const BOOKMARK_INTERVAL_MS = 7 * 86400000;
const HISTORY_PAGE = 5000;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 60 });
  syncAll();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncAll();
});

// Copies of src/history-paging.js (the extension imports nothing from src/); app.js selfCheck() covers them there.
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
}
