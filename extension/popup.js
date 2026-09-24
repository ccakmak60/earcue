const captureToggle = document.getElementById("captureToggle");
const pauseBtn = document.getElementById("pauseBtn");
const neverBtn = document.getElementById("neverBtn");
const statusEl = document.getElementById("status");

async function postJson(baseUrl, token, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

async function currentTabHost() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  try {
    return new URL(tab.url).hostname;
  } catch {
    return null;
  }
}

async function load() {
  const { capturePages } = await chrome.storage.local.get(["capturePages"]);
  captureToggle.checked = capturePages !== false;

  const host = await currentTabHost();
  if (!host) {
    neverBtn.disabled = true;
    neverBtn.title = "No page URL available";
  }
}

async function requireCreds() {
  const { baseUrl, token } = await chrome.storage.local.get(["baseUrl", "token"]);
  if (!baseUrl || !token) {
    statusEl.textContent = "Not connected yet. Open earcue, go to Sources and click Connect this browser.";
    return null;
  }
  return { baseUrl, token };
}

async function onToggleCapture() {
  const next = captureToggle.checked;
  const creds = await requireCreds();
  if (!creds) {
    captureToggle.checked = !next;
    return;
  }
  const { baseUrl, token } = creds;

  if (next) {
    const granted = await chrome.permissions.request({ origins: ["http://*/*", "https://*/*"] });
    if (!granted) {
      captureToggle.checked = false;
      statusEl.textContent = "Permission to read page content was denied.";
      return;
    }
    try {
      await chrome.scripting.registerContentScripts([
        {
          id: "earcue-page",
          matches: ["http://*/*", "https://*/*"],
          js: ["page-capture.js"],
          runAt: "document_idle",
          allFrames: false,
          persistAcrossSessions: true,
        },
      ]);
    } catch {
      // already registered
    }
  }

  try {
    await postJson(baseUrl, token, "/api/assist/excludes", { capturePages: next });
    await chrome.storage.local.set({ capturePages: next });
    statusEl.textContent = next ? "Capture enabled." : "Capture disabled.";
  } catch (err) {
    captureToggle.checked = !next;
    statusEl.textContent = `Failed to save: ${err.message}`;
  }
}

async function onPause() {
  await chrome.storage.local.set({ pausedUntil: Date.now() + 3600000 });
  statusEl.textContent = "Paused for 1 hour.";
}

async function onNeverIndex() {
  const creds = await requireCreds();
  if (!creds) return;
  const { baseUrl, token } = creds;

  const host = await currentTabHost();
  if (!host) return;

  try {
    const { excludedDomains, purged } = await postJson(baseUrl, token, "/api/assist/excludes", { add: host });
    await chrome.storage.local.set({ skip: excludedDomains || [] });
    statusEl.textContent = `Never indexing ${host}. Removed ${purged || 0} captured item(s).`;
  } catch (err) {
    statusEl.textContent = `Failed: ${err.message}`;
  }
}

captureToggle.addEventListener("change", onToggleCapture);
pauseBtn.addEventListener("click", onPause);
neverBtn.addEventListener("click", onNeverIndex);
load();
