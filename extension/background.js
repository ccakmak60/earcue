const IMPORT_LOOKBACK_DAYS = 180; // must match server IMPORT_LOOKBACK_DAYS default
const SYNC_ALARM = "earcue-sync";
const BOOKMARK_INTERVAL_MS = 7 * 86400000;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 60 });
  syncAll();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncAll();
});

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

  const items = await chrome.history.search({ text: "", startTime, endTime, maxResults: 5000 });
  if (items.length === 0) {
    await chrome.storage.local.set({ lastSyncMs: endTime });
    return;
  }

  try {
    const { importId } = await postJson(baseUrl, token, "/api/knowledge/begin", {
      source: "browser_history",
      label: "extension",
    });

    for (const rows of chunk(items, 300)) {
      await postJson(baseUrl, token, "/api/knowledge/browser", {
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
    }

    await postJson(baseUrl, token, "/api/knowledge/finish", { importId, status: "complete" });
    await chrome.storage.local.set({ lastSyncMs: endTime });
  } catch (err) {
    // lastSyncMs stays unchanged; the next alarm retries the same window (server upserts are idempotent).
    console.error("earcue history sync failed", err);
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
    const { importId } = await postJson(baseUrl, token, "/api/knowledge/begin", {
      source: "browser_bookmarks",
      label: "extension",
    });

    for (const part of chunk(rows, 300)) {
      await postJson(baseUrl, token, "/api/knowledge/browser", { importId, kind: "bookmarks", rows: part });
    }

    await postJson(baseUrl, token, "/api/knowledge/finish", { importId, status: "complete" });
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
