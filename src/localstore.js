// IndexedDB local store: raw audio chunks (rolling retention), pending trace rows, and meta settings.

const DB_NAME = "earcue";
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("chunks")) {
        const chunks = db.createObjectStore("chunks", { keyPath: "id" });
        chunks.createIndex("startedAt", "startedAt");
      }
      if (!db.objectStoreNames.contains("pending")) {
        db.createObjectStore("pending", { keyPath: "clientId" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDb().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------- meta ----------
export async function getMeta(key, fallback) {
  const store = await tx("meta", "readonly");
  const row = await reqToPromise(store.get(key));
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  const store = await tx("meta", "readwrite");
  await reqToPromise(store.put({ key, value }));
}

export async function getSessionId() {
  let id = await getMeta("sessionId");
  if (!id) {
    id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await setMeta("sessionId", id);
  }
  return id;
}

export async function getRetentionDays() {
  return getMeta("retentionDays", 3);
}

export async function setRetentionDays(days) {
  return setMeta("retentionDays", days);
}

export async function getBlocklist() {
  return getMeta("blocklist", []);
}

export async function setBlocklist(list) {
  return setMeta("blocklist", list);
}

// ---------- chunks ----------
export async function putChunk(chunk) {
  const store = await tx("chunks", "readwrite");
  await reqToPromise(store.put(chunk));
  await sweep();
}

export async function getUntranscribedChunks() {
  const store = await tx("chunks", "readonly");
  const all = await reqToPromise(store.getAll());
  return all.filter((c) => !c.transcribed).sort((a, b) => a.startedAt - b.startedAt);
}

export async function markTranscribed(id) {
  const store = await tx("chunks", "readwrite");
  const row = await reqToPromise(store.get(id));
  if (row) {
    row.transcribed = 1;
    await reqToPromise(store.put(row));
  }
}

async function deleteChunk(id) {
  const store = await tx("chunks", "readwrite");
  await reqToPromise(store.delete(id));
}

async function allChunksByAge() {
  const store = await tx("chunks", "readonly");
  const all = await reqToPromise(store.getAll());
  return all.sort((a, b) => a.startedAt - b.startedAt);
}

// ---------- pending trace rows ----------
export async function addPending(rows) {
  const store = await tx("pending", "readwrite");
  for (const row of rows) await reqToPromise(store.put(row));
}

export async function getPending() {
  const store = await tx("pending", "readonly");
  return reqToPromise(store.getAll());
}

export async function clearPending(clientIds) {
  const store = await tx("pending", "readwrite");
  for (const id of clientIds) await reqToPromise(store.delete(id));
}

// ---------- retention sweep ----------
export async function sweep() {
  const retentionDays = await getRetentionDays();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const chunks = await allChunksByAge();
  for (const c of chunks) {
    if (c.startedAt < cutoff) await deleteChunk(c.id);
  }

  if (navigator.storage && navigator.storage.estimate) {
    const { usage, quota } = await navigator.storage.estimate();
    if (quota > 0 && usage / quota > 0.8) {
      const remaining = await allChunksByAge();
      for (const c of remaining) {
        const est = await navigator.storage.estimate();
        if (est.usage / est.quota <= 0.7) break;
        await deleteChunk(c.id);
      }
    }
  }
}

export async function persistBoot() {
  if (navigator.storage && navigator.storage.persist) {
    const granted = await navigator.storage.persist();
    console.log("storage.persist:", granted);
  }
}
