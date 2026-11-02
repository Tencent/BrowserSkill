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
