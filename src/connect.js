import { get, post } from "./api.js";

let connectionCount = 0;
let currentRefresh = null;

export function hasConnections() {
  return connectionCount > 0;
}

export async function refreshConnections() {
  if (currentRefresh) return currentRefresh();
}

const PROVIDER_LABEL = { google: "Google", slack: "Slack", upload: "Uploads", whatsapp: "WhatsApp" };

function renderConnection(container, conn, onDisconnect) {
  const row = document.createElement("div");
  row.className = "field-group";
  const label = PROVIDER_LABEL[conn.provider] || conn.provider;
  const synced = conn.lastSyncedAt ? new Date(conn.lastSyncedAt).toLocaleString() : "never";

  const info = document.createElement("div");
  info.textContent = `${label}${conn.accountLabel ? ` \u2014 ${conn.accountLabel}` : ""} \u2014 ${conn.itemCount} items \u2014 last synced ${synced}`;
  if (conn.lastError) info.textContent += ` \u2014 error: ${conn.lastError}`;
  row.appendChild(info);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-ghost";
  btn.textContent = "Disconnect";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await post("/api/connect/disconnect", { provider: conn.provider });
      onDisconnect();
    } catch (err) {
      console.error("disconnect failed", err);
      btn.disabled = false;
    }
  });
  row.appendChild(btn);
  container.appendChild(row);
}

const WHATSAPP_POLL_MS = 3000;
const WHATSAPP_POLL_MAX = 100; // ~5 minutes, longer than a QR's validity

async function linkWhatsapp(els, refresh) {
  const panel = els.whatsappPanel;
  const statusEl = els.whatsappStatus;
  const qrEl = els.whatsappQr;
  if (panel) panel.hidden = false;
  if (statusEl) statusEl.textContent = "Starting WhatsApp session\u2026";

  try {
    await post("/api/connect/whatsapp-link", {});
  } catch (err) {
    if (statusEl) statusEl.textContent = `Could not reach WAHA: ${err.message}`;
    return;
  }

  for (let i = 0; i < WHATSAPP_POLL_MAX; i++) {
    await new Promise((r) => setTimeout(r, WHATSAPP_POLL_MS));
    let state;
    try {
      state = await get("/api/connect/whatsapp-status");
    } catch (err) {
      if (statusEl) statusEl.textContent = `Status check failed: ${err.message}`;
      return;
    }
    if (state.qr && qrEl) {
      qrEl.src = `data:${state.qr.mimetype};base64,${state.qr.data}`;
      qrEl.hidden = false;
    }
    if (statusEl) {
      statusEl.textContent =
        state.status === "SCAN_QR_CODE"
          ? "Scan this QR in WhatsApp \u2192 Settings \u2192 Linked devices."
          : `WhatsApp session: ${state.status}`;
    }
    if (state.status === "WORKING") {
      if (qrEl) qrEl.hidden = true;
      if (statusEl) statusEl.textContent = `WhatsApp linked${state.me?.id ? ` \u2014 ${state.me.id}` : ""}.`;
      await refresh();
      return;
    }
    if (state.status === "FAILED") {
      if (qrEl) qrEl.hidden = true;
      if (statusEl) statusEl.textContent = "WhatsApp session failed. Disconnect and try again.";
      return;
    }
  }
  if (statusEl) statusEl.textContent = "Timed out waiting for the QR scan. Try again.";
}

export function wireConnections(els) {
  const list = els.connectionList;
  if (!list) return;

  async function refresh() {
    let data;
    try {
      data = await get("/api/connect/list");
    } catch (err) {
      console.error("connect list failed", err);
      return;
    }
    connectionCount = data.connections.length;
    list.innerHTML = "";
    if (data.connections.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No connections yet.";
      list.appendChild(empty);
    } else {
      for (const conn of data.connections) renderConnection(list, conn, refresh);
    }
    if (els.contextChip) {
      const total = data.connections.reduce((sum, c) => sum + c.itemCount, 0);
      els.contextChip.querySelector("span")?.replaceChildren(document.createTextNode(String(total)));
    }
    return data;
  }

  fetch("/api/health")
    .then((r) => r.json())
    .then((health) => {
      const supported = health?.features?.connectors || {};
      for (const btn of document.querySelectorAll("[data-connect-provider]")) {
        btn.hidden = !supported[btn.dataset.connectProvider];
      }
      if (els.connectWhatsapp) els.connectWhatsapp.hidden = !supported.whatsapp;
    })
    .catch(() => {});

  for (const btn of document.querySelectorAll("[data-connect-provider]")) {
    btn.addEventListener("click", () => {
      location.href = `/api/connect/start?provider=${btn.dataset.connectProvider}`;
    });
  }

  if (els.connectWhatsapp) {
    els.connectWhatsapp.addEventListener("click", () => linkWhatsapp(els, refresh));
  }

  if (els.uploadDoc) {
    els.uploadDoc.addEventListener("change", async () => {
      const file = els.uploadDoc.files[0];
      if (!file) return;
      const text = await file.text();
      try {
        await post("/api/connect/upload", { name: file.name, text });
        await refresh();
      } catch (err) {
        console.error("upload failed", err);
      } finally {
        els.uploadDoc.value = "";
      }
    });
  }

  currentRefresh = refresh;
  refresh();
  return refresh;
}
