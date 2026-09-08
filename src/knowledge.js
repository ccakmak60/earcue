import { get, post } from "./api.js";
import { parseBookmarksHtml } from "./importers/bookmarks.js";
import { parseTakeoutHistory } from "./importers/history.js";
import { parseWhatsappExport } from "./importers/whatsapp.js";

const MAX_FILE_BYTES = 40 * 1024 * 1024;

let knowledgeEls = null;
let cachedProfileSummary = "";

export function profileSummary() {
  return cachedProfileSummary;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function setStatus(text) {
  if (knowledgeEls?.importStatusKnowledge) knowledgeEls.importStatusKnowledge.textContent = text;
}

async function distillLoop() {
  for (let i = 0; i < 5; i++) {
    let result;
    try {
      result = await post("/api/knowledge/distill", {});
    } catch (err) {
      if (String(err.message).includes("429")) {
        setStatus("Daily learning limit reached \u2014 the nightly sweep will finish this.");
        return;
      }
      console.error("distill failed", err);
      return;
    }
    setStatus(`Learning\u2026 ${result.processed} of ${result.processed + result.remaining} items processed`);
    if (result.remaining <= 0) break;
  }
}

async function postBrowserChunks(importId, kind, rows) {
  let ingested = 0;
  let skipped = 0;
  let done = 0;
  const total = rows.length;
  for (const part of chunk(rows, 300)) {
    const result = await post("/api/knowledge/browser", { importId, kind, rows: part });
    ingested += result.ingested;
    skipped += result.skipped;
    done += part.length;
    setStatus(`Imported ${done.toLocaleString()} / ${total.toLocaleString()}\u2026`);
  }
  return { ingested, skipped };
}

async function postItemChunks(importId, items) {
  let ingested = 0;
  let skipped = 0;
  let done = 0;
  const total = items.length;
  for (const part of chunk(items, 300)) {
    const result = await post("/api/knowledge/items", { importId, items: part });
    ingested += result.ingested;
    skipped += result.skipped;
    done += part.length;
    setStatus(`Imported ${done.toLocaleString()} / ${total.toLocaleString()}\u2026`);
  }
  return { ingested, skipped };
}

async function runImport({ source, label, kind, rows, items }) {
  let importId;
  try {
    const begin = await post("/api/knowledge/begin", { source, label });
    importId = begin.importId;

    const result = rows ? await postBrowserChunks(importId, kind, rows) : await postItemChunks(importId, items);

    await post("/api/knowledge/finish", { importId, status: "complete" });
    setStatus(`Imported ${result.ingested} items (${result.skipped} skipped). Learning\u2026`);
    await distillLoop();
  } catch (err) {
    if (importId) await post("/api/knowledge/finish", { importId, status: "failed" }).catch(() => {});
    console.error("import failed", err);
    setStatus(`Import failed: ${err.message}`);
    return;
  }
  await refreshKnowledge();
}

async function runBookmarksImport(file) {
  if (file.size > MAX_FILE_BYTES) return setStatus("File too large (max 40MB).");
  const text = await file.text();
  const rows = parseBookmarksHtml(text);
  await runImport({ source: "browser_bookmarks", label: file.name, kind: "bookmarks", rows });
}

async function runHistoryImport(file) {
  if (file.size > MAX_FILE_BYTES) return setStatus("File too large (max 40MB).");
  const text = await file.text();
  const rows = parseTakeoutHistory(JSON.parse(text));
  await runImport({ source: "browser_history", label: file.name, kind: "history", rows });
}

async function runWhatsappImport(file) {
  if (file.size > MAX_FILE_BYTES) return setStatus("File too large (max 40MB).");
  const text = await file.text();
  const chatName = file.name.replace(/^WhatsApp Chat with /, "").replace(/\.txt$/i, "");
  const items = await parseWhatsappExport(text, chatName);
  await runImport({ source: "whatsapp", label: chatName, items });
}

async function runGmailBackfill() {
  setStatus("Starting Gmail backfill\u2026");
  let totalIngested = 0;
  for (let i = 0; i < 20; i++) {
    let result;
    try {
      result = await post("/api/knowledge/gmail-backfill", {});
    } catch (err) {
      if (String(err.message).includes("429")) {
        setStatus("Daily import limit reached \u2014 try again tomorrow.");
        return;
      }
      console.error("gmail backfill failed", err);
      setStatus(`Gmail backfill failed: ${err.message}`);
      return;
    }
    totalIngested += result.ingested;
    setStatus(`Gmail backfill: ${totalIngested.toLocaleString()} messages imported\u2026`);
    if (result.done) break;
  }
  setStatus(`Gmail backfill complete: ${totalIngested.toLocaleString()} messages. Learning\u2026`);
  await distillLoop();
  await refreshKnowledge();
}

// ---------- rendering ----------

function renderImportRow(container, imp, onRemove) {
  const row = document.createElement("div");
  row.className = "field-group";
  const info = document.createElement("div");
  info.textContent = `${imp.source} \u00b7 ${imp.status} \u00b7 ${imp.itemsIngested} items \u00b7 ${new Date(imp.createdAt).toLocaleString()}`;
  if (imp.error) info.textContent += ` \u2014 error: ${imp.error}`;
  row.appendChild(info);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-ghost";
  btn.textContent = "Remove";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await post("/api/knowledge/remove", { importId: imp.id });
      await onRemove();
    } catch (err) {
      console.error("remove import failed", err);
      btn.disabled = false;
    }
  });
  row.appendChild(btn);
  container.appendChild(row);
}

function renderMemoryRow(container, mem, onForget) {
  const row = document.createElement("div");
  row.className = "field-group";
  const info = document.createElement("div");
  info.textContent = `${mem.kind} \u00b7 ${mem.subject} \u2014 ${mem.text}`;
  row.appendChild(info);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-ghost";
  btn.textContent = "Forget";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await post("/api/knowledge/forget", { id: mem.id });
      await onForget();
    } catch (err) {
      console.error("forget failed", err);
      btn.disabled = false;
    }
  });
  row.appendChild(btn);
  container.appendChild(row);
}

export async function refreshKnowledge() {
  if (!knowledgeEls) return;

  let data;
  try {
    data = await get("/api/knowledge/imports");
  } catch (err) {
    console.error("knowledge imports failed", err);
    return;
  }

  cachedProfileSummary = data.profile?.summary || "";
  if (knowledgeEls.profileSummary) {
    knowledgeEls.profileSummary.textContent =
      cachedProfileSummary || "No standing profile yet \u2014 import something and let it learn.";
  }

  if (knowledgeEls.importList) {
    knowledgeEls.importList.innerHTML = "";
    if (data.imports.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No imports yet.";
      knowledgeEls.importList.appendChild(empty);
    } else {
      for (const imp of data.imports) renderImportRow(knowledgeEls.importList, imp, refreshKnowledge);
    }
  }

  if (knowledgeEls.excludedDomains && document.activeElement !== knowledgeEls.excludedDomains) {
    knowledgeEls.excludedDomains.value = (data.excludedDomains || []).join("\n");
  }

  let memData;
  try {
    memData = await get("/api/knowledge/memories");
  } catch (err) {
    console.error("knowledge memories failed", err);
    return data;
  }

  if (knowledgeEls.memoryList) {
    knowledgeEls.memoryList.innerHTML = "";
    if (memData.memories.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No memories yet.";
      knowledgeEls.memoryList.appendChild(empty);
    } else {
      for (const mem of memData.memories) renderMemoryRow(knowledgeEls.memoryList, mem, refreshKnowledge);
    }
  }

  return data;
}

export function wireKnowledge(els) {
  knowledgeEls = els;

  if (els.importBookmarks) {
    els.importBookmarks.addEventListener("change", async () => {
      const file = els.importBookmarks.files[0];
      els.importBookmarks.value = "";
      if (file) await runBookmarksImport(file);
    });
  }
  if (els.importHistory) {
    els.importHistory.addEventListener("change", async () => {
      const file = els.importHistory.files[0];
      els.importHistory.value = "";
      if (file) await runHistoryImport(file);
    });
  }
  if (els.importWhatsapp) {
    els.importWhatsapp.addEventListener("change", async () => {
      const file = els.importWhatsapp.files[0];
      els.importWhatsapp.value = "";
      if (file) await runWhatsappImport(file);
    });
  }
  if (els.gmailBackfill) {
    els.gmailBackfill.addEventListener("click", () => runGmailBackfill());
  }
  if (els.distillNow) {
    els.distillNow.addEventListener("click", async () => {
      setStatus("Learning\u2026");
      await distillLoop();
      await refreshKnowledge();
    });
  }
  if (els.mintIngestToken) {
    els.mintIngestToken.addEventListener("click", async () => {
      try {
        const result = await post("/api/knowledge/token", { label: "extension" });
        if (els.ingestToken) els.ingestToken.textContent = result.token;
        await refreshKnowledge();
      } catch (err) {
        console.error("mint token failed", err);
      }
    });
  }
  if (els.excludedDomains) {
    els.excludedDomains.addEventListener("change", async () => {
      try {
        await post("/api/knowledge/excludes", { domains: els.excludedDomains.value });
      } catch (err) {
        console.error("save excludes failed", err);
      }
    });
  }

  refreshKnowledge();
}
