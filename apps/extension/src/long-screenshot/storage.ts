export interface SavedScreenshot {
  id: string;
  title: string;
  createdAt: number;
  width: number;
  height: number;
  blob: Blob;
}

const DATABASE = "bsk-long-screenshots";
const STORE = "screenshots";
const MAX_AGE = 24 * 60 * 60 * 1000;

async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result
        .createObjectStore(STORE, { keyPath: "id" })
        .createIndex("createdAt", "createdAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveScreenshot(value: SavedScreenshot) {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      let retained = 0;
      const cursor = store.index("createdAt").openCursor(null, "prev");
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        if ((entry.value as SavedScreenshot).createdAt < Date.now() - MAX_AGE || retained++ >= 4)
          entry.delete();
        entry.continue();
      };
      store.put(value);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function readScreenshot(id: string): Promise<SavedScreenshot | undefined> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(id);
      request.onsuccess = () => resolve(request.result as SavedScreenshot | undefined);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export function screenshotFilename(title: string, createdAt: number) {
  const name =
    title
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "Screenshot";
  return `${name}-${new Date(createdAt).toISOString().replace(/[:.]/g, "-")}.png`;
}
