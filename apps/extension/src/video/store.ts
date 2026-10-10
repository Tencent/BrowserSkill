import { isVideoId, type StoredVideo, VIDEO_BUDGET_BYTES, VIDEO_MAX_BYTES } from "./types";

const DATABASE = "bsk-videos";
const DIRECTORY = "videos";

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("recordings", { keyPath: "recording_id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction("recordings", mode);
      const request = run(tx.objectStore("recordings"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("Video storage transaction aborted"));
    });
  } finally {
    db.close();
  }
}

export async function videoDirectory(id: string, create = false) {
  if (!isVideoId(id)) throw new Error("Invalid recording ID");
  const root = await navigator.storage.getDirectory();
  const videos = await root.getDirectoryHandle(DIRECTORY, { create });
  return videos.getDirectoryHandle(id, { create });
}

export class VideoArtifactStore {
  list(): Promise<StoredVideo[]> {
    return transaction("readonly", (store) => store.getAll());
  }

  get(id: string): Promise<StoredVideo | undefined> {
    if (!isVideoId(id)) return Promise.resolve(undefined);
    return transaction("readonly", (store) => store.get(id));
  }

  async put(value: StoredVideo): Promise<void> {
    await transaction("readwrite", (store) => store.put(value));
  }

  async file(id: string): Promise<File> {
    const directory = await videoDirectory(id);
    return (await directory.getFileHandle("video.mp4")).getFile();
  }

  async remove(id: string): Promise<void> {
    if (!isVideoId(id)) throw new Error("Invalid recording ID");
    try {
      const root = await navigator.storage.getDirectory();
      const videos = await root.getDirectoryHandle(DIRECTORY);
      await videos.removeEntry(id, { recursive: true });
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
    }
    await transaction("readwrite", (store) => store.delete(id));
  }

  async prepare(activeId?: string): Promise<void> {
    for (const recording of await this.list()) {
      if (recording.recording_id !== activeId && recording.expires_at <= Date.now())
        await this.remove(recording.recording_id);
    }
  }

  async reserve(): Promise<void> {
    await this.prepare();
    const values = await this.list();
    // Leave space for a full recording and its streaming remux. Never evict
    // unexpired evidence to make a new recording appear to succeed.
    let used = 0;
    for (const value of values) {
      // Failed or recovered recordings may still have a journal and an
      // unfinished remux. Charge actual bytes, including both copies.
      for (const filename of ["video.mp4", "fragments.mp4"]) {
        try {
          const directory = await videoDirectory(value.recording_id);
          used += (await (await directory.getFileHandle(filename)).getFile()).size;
        } catch (error) {
          if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
        }
      }
    }
    if (used + VIDEO_MAX_BYTES * 2 > VIDEO_BUDGET_BYTES)
      throw new Error("Video storage is full; save and delete an earlier recording");
    const estimate = await navigator.storage.estimate();
    if ((estimate.quota ?? Infinity) - (estimate.usage ?? 0) < VIDEO_MAX_BYTES * 2)
      throw new Error("Not enough browser storage for a video; free space and try again");
  }
}
