const baseUrlInput = document.getElementById("baseUrl");
const tokenInput = document.getElementById("token");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");

async function load() {
  const { baseUrl, token } = await chrome.storage.local.get(["baseUrl", "token"]);
  if (baseUrl) baseUrlInput.value = baseUrl;
  if (token) tokenInput.value = token;
}

async function save() {
  statusEl.textContent = "Saving\u2026";
  const baseUrl = baseUrlInput.value.trim().replace(/\/+$/, "");
  const token = tokenInput.value.trim();

  if (!baseUrl || !token) {
    statusEl.textContent = "Base URL and token are both required.";
    return;
  }

  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    statusEl.textContent = "Base URL is not a valid URL.";
    return;
  }

  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    statusEl.textContent = "Permission to access that origin was denied.";
    return;
  }

  await chrome.storage.local.set({ baseUrl, token });

  try {
    const beginRes = await fetch(`${baseUrl}/api/knowledge/begin`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ source: "browser_history", label: "extension" }),
    });
    if (!beginRes.ok) throw new Error(`${beginRes.status}`);
    const { importId } = await beginRes.json();

    const finishRes = await fetch(`${baseUrl}/api/knowledge/finish`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ importId, status: "complete" }),
    });
    if (!finishRes.ok) throw new Error(`${finishRes.status}`);

    statusEl.textContent = "Connected.";
  } catch (err) {
    statusEl.textContent = `Failed to connect: ${err.message}`;
  }
}

saveBtn.addEventListener("click", save);
load();
