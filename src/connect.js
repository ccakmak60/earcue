import { get, post } from "./api.js";

let connectionCount = 0;
let currentRefresh = null;

export function hasConnections() {
  return connectionCount > 0;
}

export async function refreshConnections() {
  if (currentRefresh) return currentRefresh();
}

const PROVIDER_LABEL = { google: "Google", slack: "Slack", upload: "Uploads" };

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

  for (const btn of document.querySelectorAll("[data-connect-provider]")) {
    btn.addEventListener("click", () => {
      location.href = `/api/connect/start?provider=${btn.dataset.connectProvider}`;
    });
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
