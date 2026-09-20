import {
  JOURNAL_BYTES,
  JOURNAL_PINS,
  JOURNAL_REQUESTS,
  jsonBytes,
  mergeRequest,
  retentionPriority,
} from "./journal";
import { interruptPerformance } from "./performance";
import { matchesRequest, projectFields } from "./query";
import type { DebugParams, DebugRecording, DebugRequest, DebugResult, DebugRun } from "./types";

const STORES = ["runs", "recordings", "requests", "request_index"];
interface StoredRequest {
  entry: DebugRequest;
  bytes: number;
  priority: number;
}
function metadata(entry: DebugRequest): DebugRequest {
  const { text: _request, ...request_body } = entry.request_body;
  const { text: _response, ...response_body } = entry.response_body;
  const {
    request_headers: _headers,
    response_headers: _responseHeaders,
    timing: _timing,
    ...rest
  } = entry;
  return { ...rest, request_body, response_body };
}

export const HISTORY_LIMIT = 50;
export const HISTORY_BYTES = 50 * 1024 * 1024;
export const HISTORY_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface DebugArchive {
  list(): Promise<DebugRun[]>;
  get(id: string, bodies?: boolean): Promise<DebugRecording | undefined>;
  query?(runId: string, params: DebugParams): Promise<DebugResult | undefined>;
  retain?(run: DebugRun, entries: DebugRequest[]): Promise<void>;
  request?(runId: string, id: string): Promise<DebugRequest | undefined>;
  pin?(runId: string, id: string, pinned: boolean, sequence?: number): Promise<void>;
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
  recording.run.active_rules = 0;
  for (const rule of recording.rules ?? [])
    if (["enabled", "disabled"].includes(rule.state)) rule.state = "stopped";
  for (const replay of recording.replays ?? [])
    if (replay.state === "running") replay.state = "interrupted";
  recording.run.stopped_at = recording.saved_at;
  recording.run.stop_reason = "browser_restarted";
  recording.run.coverage = [...new Set([...recording.run.coverage, "interrupted_checkpoint"])];
  for (const request of recording.requests) {
    if (request.intervention?.state === "pending") {
      request.intervention.state = "cancelled";
      request.intervention.error = "browser restarted before control completed";
    }
    if (request.state === "pending") request.state = "interrupted";
    for (const body of [request.request_body, request.response_body]) {
      if (body.state === "pending") {
        body.state = "unavailable";
        body.reason = "browser_restarted";
      }
    }
  }
  for (const entry of recording.performance ?? []) interruptPerformance(entry, "browser_restarted");
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
      const request = factory.open("bsk-debug-history", 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("runs"))
          db.createObjectStore("runs", { keyPath: "run.id" });
        if (!db.objectStoreNames.contains("recordings"))
          db.createObjectStore("recordings", { keyPath: "run.id" });
        const requests = db.createObjectStore("requests", {
          keyPath: ["entry.run_id", "entry.id"],
        });
        requests.createIndex("run", "entry.run_id");
        requests.createIndex("retention", [
          "entry.run_id",
          "priority",
          "entry.started_at",
          "entry.id",
        ]);
        const index = db.createObjectStore("request_index", { keyPath: ["run_id", "id"] });
        index.createIndex("run", "run_id");
        index.createIndex("sequence", ["run_id", "sequence"]);
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
        const tx = db.transaction(STORES, "readwrite");
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
                recording.run.storage = value.run.storage;
                cursor.update({ ...value, run: recording.run });
                const evidence = tx
                  .objectStore("requests")
                  .index("run")
                  .openCursor(IDBKeyRange.only(recording.run.id));
                evidence.onsuccess = () => {
                  const item = evidence.result;
                  if (!item) return;
                  const saved = item.value as StoredRequest;
                  const recovered = interrupted({
                    ...recording,
                    run: { ...recording.run, state: "capturing" },
                    requests: [saved.entry],
                  }).requests[0];
                  item.update({ ...saved, entry: recovered });
                  tx.objectStore("request_index").put(metadata(recovered));
                  item.continue();
                };
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
      this.deleteRequests(tx, id);
    }
  }

  private deleteRequests(tx: IDBTransaction, id: string): void {
    for (const name of ["requests", "request_index"]) {
      const read = tx.objectStore(name).index("run").openCursor(IDBKeyRange.only(id));
      read.onsuccess = () => {
        const item = read.result;
        if (item) {
          item.delete();
          item.continue();
        }
      };
    }
  }

  async list(): Promise<DebugRun[]> {
    const db = await this.open();
    const tx = db.transaction(STORES, "readwrite");
    const done = complete(tx);
    const all = tx.objectStore("runs").getAll();
    all.onsuccess = () => this.prune(tx, all.result as StoredRun[]);
    await done;
    const read = db.transaction("runs");
    return ((await result(read.objectStore("runs").getAll())) as StoredRun[])
      .map(({ run }) => run)
      .sort((a, b) => b.started_at - a.started_at);
  }

  async get(id: string, bodies = true): Promise<DebugRecording | undefined> {
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
    if (!recording) return undefined;
    const tx = db.transaction(["runs", bodies ? "requests" : "request_index"]);
    const [saved, requests] = await Promise.all([
      result<StoredRun | undefined>(tx.objectStore("runs").get(id)),
      result(
        tx
          .objectStore(bodies ? "requests" : "request_index")
          .index("run")
          .getAll(IDBKeyRange.only(id)),
      ),
    ]);
    const merged = new Map(
      recording.requests.map((entry) => [entry.id, bodies ? entry : metadata(entry)]),
    );
    for (const value of requests) {
      const entry = bodies ? (value as StoredRequest).entry : (value as DebugRequest);
      merged.set(entry.id, mergeRequest(merged.get(entry.id), entry));
    }
    recording.requests = [...merged.values()].sort(
      (a, b) => a.started_at - b.started_at || a.sequence - b.sequence,
    );
    if (saved?.run.storage) {
      recording.run.storage = saved.run.storage;
      recording.run.dropped_requests = saved.run.storage.dropped;
    }
    recording.run.requests = recording.requests.length;
    if (recording.run.storage?.dropped)
      recording.run.coverage = [...new Set([...recording.run.coverage, "evidence_storage_limit"])];
    return recording;
  }

  async query(runId: string, params: DebugParams): Promise<DebugResult | undefined> {
    const db = await this.open();
    const tx = db.transaction(["runs", "request_index"]);
    const runRead = tx.objectStore("runs").get(runId);
    const entries: DebugRequest[] = [];
    const limit = params.limit ?? 30;
    const since = params.since ?? 0;
    let seen = since,
      more = false;
    const request = tx
      .objectStore("request_index")
      .index("sequence")
      .openCursor(IDBKeyRange.bound([runId, since], [runId, Number.MAX_SAFE_INTEGER], true));
    const done = complete(tx);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const entry = cursor.value as DebugRequest;
      if (matchesRequest(entry, params)) {
        if (entries.length === limit) {
          more = true;
          return;
        }
        entries.push(projectFields(entry, params.fields));
      }
      seen = entry.sequence;
      cursor.continue();
    };
    await done;
    const saved = runRead.result as StoredRun | undefined;
    if (!saved?.run.storage) return undefined;
    if (
      saved.run.state !== "capturing" &&
      (saved.run.stopped_at ?? saved.run.started_at) < this.now() - HISTORY_AGE_MS
    ) {
      await this.delete(runId);
      return undefined;
    }
    return {
      session_id: saved.run.session_id,
      run: {
        ...saved.run,
        requests: saved.run.storage.requests,
        dropped_requests: saved.run.storage.dropped,
        coverage: [
          ...new Set([
            ...saved.run.coverage,
            ...(saved.run.storage.dropped ? ["evidence_storage_limit"] : []),
          ]),
        ],
      },
      requests: entries,
      next_since: more ? (entries.at(-1)?.sequence ?? since) : Math.max(seen, saved.run.next_since),
      truncated: more || saved.run.storage.dropped > 0,
    };
  }

  async request(runId: string, id: string): Promise<DebugRequest | undefined> {
    const db = await this.open();
    const saved = await result<StoredRequest | undefined>(
      db.transaction("requests").objectStore("requests").get([runId, id]),
    );
    if (saved) return saved.entry;
    // v1 stored requests inside the recording. Keep the indexed v2 fast path,
    // but resolve old details here so every caller gets the same complete data.
    const recording = await result<DebugRecording | undefined>(
      db.transaction("recordings").objectStore("recordings").get(runId),
    );
    return recording?.requests.find((entry) => entry.id === id);
  }

  async put(recording: DebugRecording): Promise<void> {
    const db = await this.open();
    const bytes = new TextEncoder().encode(JSON.stringify(recording)).byteLength;
    if (bytes > HISTORY_BYTES) throw new Error("debug recording exceeds storage limit");
    const tx = db.transaction(STORES, "readwrite");
    const done = complete(tx);
    const runs = tx.objectStore("runs");
    const previous = runs.get(recording.run.id);
    previous.onsuccess = () => {
      const storage = (previous.result as StoredRun | undefined)?.run.storage;
      const run = {
        ...recording.run,
        ...(storage
          ? { storage, requests: storage.requests, dropped_requests: storage.dropped }
          : {}),
      };
      tx.objectStore("recordings").put({ ...recording, run });
      runs.put({ run, bytes: bytes + (storage?.bytes ?? 0) } satisfies StoredRun);
      const all = runs.getAll();
      all.onsuccess = () => this.prune(tx, all.result as StoredRun[]);
    };
    await done;
  }

  async delete(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORES, "readwrite");
    const done = complete(tx);
    tx.objectStore("runs").delete(id);
    tx.objectStore("recordings").delete(id);
    this.deleteRequests(tx, id);
    await done;
  }

  async retain(run: DebugRun, entries: DebugRequest[]): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORES, "readwrite");
    const done = complete(tx);
    const runs = tx.objectStore("runs"),
      requests = tx.objectStore("requests"),
      index = tx.objectStore("request_index");
    const read = runs.get(run.id);
    read.onsuccess = () => {
      const old = read.result as StoredRun | undefined;
      const stats = { requests: 0, bytes: 0, dropped: 0, pins: 0, ...old?.run.storage };
      const baseBytes = old ? old.bytes - (old.run.storage?.bytes ?? 0) : 0;
      let remaining = entries.length;
      const finish = () => {
        const save = () => {
          runs.put({
            run: {
              ...(old?.run ?? run),
              storage: stats,
              requests: stats.requests,
              dropped_requests: stats.dropped,
            },
            bytes: baseBytes + stats.bytes,
          });
          if (!old)
            tx.objectStore("recordings").put({
              version: 1,
              saved_at: this.now(),
              run,
              requests: [],
              operations: [],
              console: [],
              pages: [],
            } satisfies DebugRecording);
          const all = runs.getAll();
          all.onsuccess = () => this.prune(tx, all.result as StoredRun[]);
        };
        if (stats.bytes <= JOURNAL_BYTES && stats.requests <= JOURNAL_REQUESTS) {
          save();
          return;
        }
        const cursor = requests
          .index("retention")
          .openCursor(IDBKeyRange.bound([run.id, 0], [run.id, 9]));
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item || (stats.bytes <= JOURNAL_BYTES && stats.requests <= JOURNAL_REQUESTS)) {
            save();
            return;
          }
          const value = item.value as StoredRequest;
          stats.bytes -= value.bytes;
          stats.requests--;
          stats.dropped++;
          index.delete([run.id, value.entry.id]);
          item.delete();
          item.continue();
        };
      };
      if (!remaining) {
        finish();
        return;
      }
      for (const current of entries) {
        const previous = requests.get([run.id, current.id]);
        previous.onsuccess = () => {
          const saved = previous.result as StoredRequest | undefined;
          const entry = mergeRequest(saved?.entry, current);
          const bytes = jsonBytes(entry);
          stats.bytes += bytes - (saved?.bytes ?? 0);
          if (!saved) stats.requests++;
          requests.put({
            entry,
            bytes,
            priority: retentionPriority(entry),
          } satisfies StoredRequest);
          index.put(metadata(entry));
          if (--remaining === 0) finish();
        };
      }
    };
    await done;
  }

  async pin(runId: string, id: string, pinned: boolean, sequence?: number): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORES, "readwrite");
    const done = complete(tx);
    const request = tx.objectStore("requests").get([runId, id]);
    const read = tx.objectStore("runs").get(runId);
    let failure = "";
    read.onsuccess = () => {
      const saved = request.result as StoredRequest | undefined;
      const run = read.result as StoredRun | undefined;
      if (!saved || !run?.run.storage) {
        failure = "request is not saved";
        return;
      }
      if (
        pinned &&
        (saved.entry.state === "pending" || saved.entry.response_body.state === "pending")
      ) {
        failure = "wait for request capture to complete before pinning";
        return;
      }
      if (pinned && !saved.entry.pinned && run.run.storage.pins >= JOURNAL_PINS) {
        failure = "pin limit reached (20)";
        return;
      }
      if (pinned && !saved.entry.pinned && saved.bytes > JOURNAL_BYTES / JOURNAL_PINS) {
        failure = "request too large to pin";
        return;
      }
      run.run.storage.pins += Number(pinned) - Number(!!saved.entry.pinned);
      saved.entry.pinned = pinned;
      if (sequence !== undefined) {
        saved.entry.sequence = sequence;
        run.run.next_since = Math.max(run.run.next_since, sequence);
      }
      const bytes = jsonBytes(saved.entry);
      run.bytes += bytes - saved.bytes;
      run.run.storage.bytes += bytes - saved.bytes;
      saved.bytes = bytes;
      saved.priority = retentionPriority(saved.entry);
      tx.objectStore("requests").put(saved);
      tx.objectStore("request_index").put(metadata(saved.entry));
      tx.objectStore("runs").put(run);
    };
    await done;
    if (failure) throw new Error(failure);
  }
}
