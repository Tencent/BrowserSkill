import type { DebugRecording, DebugRun } from "./types";

export const HISTORY_LIMIT = 50;
export const HISTORY_BYTES = 50 * 1024 * 1024;
export const HISTORY_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface DebugArchive {
  list(): Promise<DebugRun[]>;
  get(id: string): Promise<DebugRecording | undefined>;
  put(recording: DebugRecording): Promise<void>;
  delete(id: string): Promise<void>;
}

interface StoredRun {
  run: DebugRun;
  bytes: number;
}

export function expiredHistory(values: StoredRun[], now: number): string[] {
  const active = values.filter(({ run }) => run.state === "capturing");
  let count = active.length;
  let bytes = active.reduce((sum, item) => sum + item.bytes, 0);
  return values
    .filter(({ run }) => run.state !== "capturing")
    .sort((a, b) => b.run.started_at - a.run.started_at)
    .filter((value) => {
      const expired = (value.run.stopped_at ?? value.run.started_at) < now - HISTORY_AGE_MS;
      if (expired || count >= HISTORY_LIMIT || bytes + value.bytes > HISTORY_BYTES) return true;
      count += 1;
      bytes += value.bytes;
      return false;
    })
    .map(({ run }) => run.id);
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("debug history read failed"));
  });
}
function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("debug history write failed"));
    transaction.onerror = () => {}; // The abort handler owns the terminal result.
  });
}

/** Recover a checkpoint without representing an interrupted request as completed. */
export function interrupted(recording: DebugRecording): DebugRecording {
  if (recording.run.state !== "capturing") return recording;
  recording.run.state = "stopped";
  recording.run.stopped_at = recording.saved_at;
  recording.run.stop_reason = "browser_restarted";
  recording.run.coverage = [...new Set([...recording.run.coverage, "interrupted_checkpoint"])];
  for (const request of recording.requests) {
    if (request.state === "pending") request.state = "interrupted";
    for (const body of [request.request_body, request.response_body]) {
      if (body.state === "pending") {
        body.state = "unavailable";
        body.reason = "browser_restarted";
      }
    }
  }
  for (const operation of recording.operations) {
    if (operation.state === "running") operation.state = "interrupted";
  }
  return recording;
}

/** One bounded database per extension/browser profile. No remote daemon dependency. */
export class LocalDebugArchive implements DebugArchive {
  private database?: Promise<IDBDatabase>;
  constructor(
    private readonly factory?: IDBFactory,
    private readonly now = Date.now,
  ) {}

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    this.database = new Promise<IDBDatabase>((resolve, reject) => {
      const factory = this.factory ?? globalThis.indexedDB;
      if (!factory) {
        reject(new Error("debug history storage unavailable"));
        return;
      }
      const request = factory.open("bsk-debug-history", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("runs", { keyPath: "run.id" });
        request.result.createObjectStore("recordings", { keyPath: "run.id" });
      };
      request.onerror = () => reject(request.error ?? new Error("debug history unavailable"));
      request.onblocked = () => reject(new Error("debug history database is blocked"));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          this.database = undefined;
        };
        resolve(db);
      };
    })
      .then(async (db) => {
        const tx = db.transaction(["runs", "recordings"], "readwrite");
        const done = complete(tx);
        // Recovery runs once for this service worker. Old capture IDs are never resumed.
        const runs = tx.objectStore("runs");
        const records = tx.objectStore("recordings");
        const request = runs.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const value = cursor.value as StoredRun;
          if (value.run.state === "capturing") {
            const read = records.get(value.run.id);
            read.onsuccess = () => {
              if (read.result) {
                const recording = interrupted(read.result as DebugRecording);
                records.put(recording);
                cursor.update({ ...value, run: recording.run });
              }
              cursor.continue();
            };
          } else cursor.continue();
        };
        await done;
        return db;
      })
      .catch((error) => {
        this.database = undefined;
        throw error;
      });
    return this.database;
  }

  private prune(tx: IDBTransaction, values: StoredRun[]): void {
    for (const id of expiredHistory(values, this.now())) {
      tx.objectStore("runs").delete(id);
      tx.objectStore("recordings").delete(id);
    }
  }

  async list(): Promise<DebugRun[]> {
    const db = await this.open();
    const tx = db.transaction(["runs", "recordings"], "readwrite");
    const done = complete(tx);
    const all = tx.objectStore("runs").getAll();
    all.onsuccess = () => this.prune(tx, all.result as StoredRun[]);
    await done;
    const read = db.transaction("runs");
    return ((await result(read.objectStore("runs").getAll())) as StoredRun[])
      .map(({ run }) => run)
      .sort((a, b) => b.started_at - a.started_at);
  }

  async get(id: string): Promise<DebugRecording | undefined> {
    const db = await this.open();
    const recording = await result<DebugRecording | undefined>(
      db.transaction("recordings").objectStore("recordings").get(id),
    );
    if (
      recording &&
      recording.run.state !== "capturing" &&
      (recording.run.stopped_at ?? recording.run.started_at) < this.now() - HISTORY_AGE_MS
    ) {
      await this.delete(id);
      return undefined;
    }
    return recording;
  }

  async put(recording: DebugRecording): Promise<void> {
    const db = await this.open();
    const bytes = new TextEncoder().encode(JSON.stringify(recording)).byteLength;
    if (bytes > HISTORY_BYTES) throw new Error("debug recording exceeds storage limit");
    const tx = db.transaction(["runs", "recordings"], "readwrite");
    const done = complete(tx);
    tx.objectStore("recordings").put(recording);
    tx.objectStore("runs").put({ run: recording.run, bytes } satisfies StoredRun);
    const all = tx.objectStore("runs").getAll();
    all.onsuccess = () => this.prune(tx, all.result as StoredRun[]);
    await done;
  }

  async delete(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(["runs", "recordings"], "readwrite");
    const done = complete(tx);
    tx.objectStore("runs").delete(id);
    tx.objectStore("recordings").delete(id);
    await done;
  }
}
