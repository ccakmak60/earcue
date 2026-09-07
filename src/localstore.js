// IndexedDB local store: raw audio chunks (rolling retention), pending trace rows, and meta settings.

const DB_NAME = "earcue";
const DB_VERSION = 2;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (db.objectStoreNames.contains("chunks") && event.oldVersion < 2) {
        // Stale local audio under the old `transcribed` flag semantics is
        // disposable; recreate the store rather than migrate it.
        db.deleteObjectStore("chunks");
      }
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
  putsSinceSweep += 1;
  if (putsSinceSweep >= 30) {
    putsSinceSweep = 0;
    await sweep();
  }
}

export async function getPendingChunks(limit) {
  const store = await tx("chunks", "readonly");
  return new Promise((resolve, reject) => {
    const results = [];
    const req = store.index("startedAt").openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || results.length >= limit) return resolve(results);
      results.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteChunk(id) {
  const store = await tx("chunks", "readwrite");
  await reqToPromise(store.delete(id));
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
  const store = await tx("chunks", "readwrite");
  await new Promise((resolve, reject) => {
    const req = store.index("startedAt").openCursor(IDBKeyRange.upperBound(cutoff));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      cursor.delete();
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });

  if (navigator.storage && navigator.storage.estimate) {
    const { usage, quota } = await navigator.storage.estimate();
    if (quota > 0 && usage / quota > 0.8) {
      const pressureStore = await tx("chunks", "readwrite");
      await new Promise((resolve, reject) => {
        const req = pressureStore.index("startedAt").openCursor();
        const step = async () => {
          const est = await navigator.storage.estimate();
          if (est.quota > 0 && est.usage / est.quota <= 0.7) return resolve();
          req.result.delete();
          req.result.continue();
        };
        req.onsuccess = () => {
          if (!req.result) return resolve();
          step();
        };
        req.onerror = () => reject(req.error);
      });
    }
  }
}

export async function persistBoot() {
  if (navigator.storage && navigator.storage.persist) {
    const granted = await navigator.storage.persist();
    console.log("storage.persist:", granted);
  }
}
