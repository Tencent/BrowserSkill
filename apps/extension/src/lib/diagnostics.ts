import type { ProtocolFrame } from "@/transport/types";

const STORAGE_KEY = "bsk_diagnostic_events_v1";
const MAX_ENTRIES = 500;

export type DiagnosticFields = Record<string, unknown>;
export type DiagnosticSink = (event: string, fields?: DiagnosticFields) => void;

export interface DiagnosticEntry {
  id: string;
  sequence: number;
  timestamp: string;
  monotonic_ms: number;
  worker_boot_id: string;
  event: string;
  fields: DiagnosticFields;
}

interface DiagnosticStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function defaultStorage(): DiagnosticStorage | null {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  return {
    get: (key) => chrome.storage.local.get(key),
    set: (items) => chrome.storage.local.set(items),
  };
}

function makeBootId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `worker-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function normalise(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        normalise(child),
      ]),
    );
  }
  return value;
}

/**
 * Persistent diagnostics for the MV3 background worker.
 *
 * Events are first written to chrome.storage.local so a worker termination or
 * dead WebSocket does not erase the evidence. Once the post-handshake link is
 * ready, pending entries are forwarded to the daemon as one
 * `browser.diagnostic` event and removed from the local queue.
 */
export class DiagnosticLogger {
  readonly workerBootId: string;
  readonly sink: DiagnosticSink;

  private sequence = 0;
  private storageQueue: Promise<void> = Promise.resolve();
  private flushPromise: Promise<void> | null = null;
  private flushRequested = false;
  private send: ((frame: ProtocolFrame) => void) | null = null;
  private transportReady = false;
  private readonly storage: DiagnosticStorage | null;

  constructor(storage: DiagnosticStorage | null = defaultStorage()) {
    this.workerBootId = makeBootId();
    this.storage = storage;
    this.sink = (event, fields = {}) => this.record(event, fields);
  }

  bindTransport(send: (frame: ProtocolFrame) => void): void {
    this.send = send;
  }

  setTransportReady(ready: boolean): void {
    this.transportReady = ready;
    if (ready) void this.flush();
  }

  record(event: string, fields: DiagnosticFields = {}): void {
    const sequence = ++this.sequence;
    const entry: DiagnosticEntry = {
      id: `${this.workerBootId}:${sequence}`,
      sequence,
      timestamp: new Date().toISOString(),
      monotonic_ms: Math.round(performance.now()),
      worker_boot_id: this.workerBootId,
      event,
      fields: normalise(fields) as DiagnosticFields,
    };
    console.info("[bsk diagnostic]", entry);
    this.storageQueue = this.storageQueue
      .then(async () => {
        if (!this.storage) return;
        const stored = await this.storage.get(STORAGE_KEY);
        const previous = Array.isArray(stored[STORAGE_KEY])
          ? (stored[STORAGE_KEY] as DiagnosticEntry[])
          : [];
        await this.storage.set({
          [STORAGE_KEY]: [...previous, entry].slice(-MAX_ENTRIES),
        });
      })
      .catch((error) => {
        console.warn("[bsk diagnostic] failed to persist event", error);
      });
    if (this.transportReady) void this.flush();
  }

  flush(): Promise<void> {
    if (this.flushPromise) {
      this.flushRequested = true;
      return this.flushPromise;
    }
    const running = (async () => {
      await this.storageQueue;
      if (!this.transportReady || !this.send || !this.storage) return;
      const stored = await this.storage.get(STORAGE_KEY);
      const entries = Array.isArray(stored[STORAGE_KEY])
        ? (stored[STORAGE_KEY] as DiagnosticEntry[])
        : [];
      if (entries.length === 0) return;
      try {
        this.send({
          event: "browser.diagnostic",
          payload: {
            schema_version: 1,
            worker_boot_id: this.workerBootId,
            entries,
          },
        });
      } catch (error) {
        console.warn("[bsk diagnostic] daemon flush failed", error);
        return;
      }
      const sentIds = new Set(entries.map((entry) => entry.id));
      // Serialize acknowledgement behind every record write that may have
      // started while send() was in progress. Without this, a concurrent
      // record can read the pre-ack queue and write an already-sent entry
      // back into storage, causing the next batch to duplicate it.
      this.storageQueue = this.storageQueue
        .then(async () => {
          const current = await this.storage?.get(STORAGE_KEY);
          const currentEntries = Array.isArray(current?.[STORAGE_KEY])
            ? (current[STORAGE_KEY] as DiagnosticEntry[])
            : [];
          await this.storage?.set({
            [STORAGE_KEY]: currentEntries.filter((entry) => !sentIds.has(entry.id)),
          });
        })
        .catch((error) => {
          console.warn("[bsk diagnostic] failed to acknowledge event batch", error);
        });
      await this.storageQueue;
    })().catch((error) => {
      console.warn("[bsk diagnostic] flush failed", error);
    });
    this.flushPromise = running.finally(() => {
      this.flushPromise = null;
      if (this.flushRequested && this.transportReady) {
        this.flushRequested = false;
        void this.flush();
      }
    });
    return this.flushPromise;
  }
}
