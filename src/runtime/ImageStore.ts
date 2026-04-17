const DB_NAME    = "patchnet-images";
const STORE_NAME = "images";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess       = () => resolve(req.result);
    req.onerror         = () => reject(req.error);
  });
  return dbPromise;
}

export interface StoredImage {
  data: ArrayBuffer;
  mimeType: string;
}

export const ImageStore = {
  async save(key: string, data: ArrayBuffer, mimeType: string): Promise<void> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({ data, mimeType }, key);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  },

  async load(key: string): Promise<StoredImage | null> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve((req.result as StoredImage | undefined) ?? null);
      req.onerror   = () => reject(req.error);
    });
  },

  async remove(key: string): Promise<void> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  },
};
