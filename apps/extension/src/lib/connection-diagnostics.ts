/** Optional observations; no connection policy or timers live in this module. */
export const DIAGNOSTIC_STORAGE_KEY = "bsk_connection_diagnostics_v1";
export const MAX_DIAGNOSTIC_EVENTS = 2048;

const EVENT_TYPES = [
  "worker.start",
  "diagnostics.enabled",
  "socket.attempt",
  "socket.factory-failed",
  "socket.open",
  "socket.close",
  "socket.error",
  "socket.explicit-disconnect",
  "socket.retry-scheduled",
  "transport.state",
  "controller.request",
  "controller.state",
  "cleanup.begin",
  "cleanup.complete",
  "cleanup.failed",
  "handshake.begin",
  "handshake.complete",
  "handshake.failed",
  "handshake.cancel",
  "handshake.retry-scheduled",
  "alarm.tick",
  "alarm.skipped",
  "heartbeat.send-failed",
] as const;
export type DiagnosticEventType = (typeof EVENT_TYPES)[number];
type Details = Record<string, string | number | boolean>;
export interface DiagnosticEvent {
  bootId: string;
  build: string;
  sequence: number;
  at: string;
  monotonicMs: number;
  type: DiagnosticEventType;
  details: Details;
}
export interface DiagnosticSnapshot {
  schema: 1;
  capturedAt: string;
  events: DiagnosticEvent[];
  droppedEvents: number;
  readFailures: number;
  writeFailures: number;
}
export interface DiagnosticStorage {
  read(): Promise<unknown>;
  write(snapshot: DiagnosticSnapshot): Promise<void>;
}
export interface DiagnosticRecorder {
  record(type: DiagnosticEventType, details?: Record<string, unknown>): void;
  snapshot(): DiagnosticSnapshot;
  flush(): Promise<void>;
}

const strings: Record<string, readonly string[]> = {
  state: ["missing", "disconnected", "connecting", "connected", "version_skew"],
  gate: [
    "not-ready",
    "disabled",
    "transition",
    "cleanup",
    "handshake-retry",
    "no-transport",
    "transport-state",
    "connect",
    "connected",
    "predicate",
  ],
  outcome: ["success", "timeout", "aborted", "error", "rejected"],
  phase: ["before-disconnect", "after-disconnect"],
};
const numbers = new Set(["generation", "attempt", "delayMs", "code", "elapsedMs"]);
const booleans = new Set([
  "enabled",
  "ready",
  "transition",
  "cleanupNeeded",
  "handshakeRetry",
  "current",
  "wasClean",
]);
function sanitizeDetails(input: unknown): Details {
  const result: Details = {};
  if (!input || typeof input !== "object") return result;
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && Object.hasOwn(strings, key) && strings[key].includes(value))
      result[key] = value;
    if (typeof value === "number" && numbers.has(key) && Number.isFinite(value) && value >= 0)
      result[key] = value;
    if (typeof value === "boolean" && booleans.has(key)) result[key] = value;
  }
  return result;
}
function count(input: unknown): number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : 0;
}
function sanitizeEvent(input: unknown): DiagnosticEvent | null {
  if (!input || typeof input !== "object") return null;
  const e = input as DiagnosticEvent;
  if (
    !EVENT_TYPES.includes(e.type) ||
    typeof e.bootId !== "string" ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(e.bootId) ||
    typeof e.build !== "string" ||
    !/^[a-zA-Z0-9._@+-]{1,96}$/.test(e.build) ||
    !Number.isSafeInteger(e.sequence) ||
    e.sequence < 0 ||
    typeof e.at !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(e.at) ||
    !Number.isFinite(Date.parse(e.at)) ||
    !Number.isFinite(e.monotonicMs) ||
    e.monotonicMs < 0
  )
    return null;
  return {
    bootId: e.bootId,
    build: e.build,
    sequence: e.sequence,
    at: e.at,
    monotonicMs: e.monotonicMs,
    type: e.type,
    details: sanitizeDetails(e.details),
  };
}

export function createDiagnosticRecorder(
  storage: DiagnosticStorage,
  options: {
    bootId: string;
    build: string;
    initialEvent?: "worker.start" | "diagnostics.enabled";
    clock?: () => { at: string; monotonicMs: number };
  },
): DiagnosticRecorder {
  const clock =
    options.clock ?? (() => ({ at: new Date().toISOString(), monotonicMs: performance.now() }));
  let events: DiagnosticEvent[] = [];
  let droppedEvents = 0;
  let readFailures = 0;
  let writeFailures = 0;
  let sequence = 0;
  let revision = 0;
  let savedRevision = -1;
  let initialized = false;
  let queued = false;
  let writing: Promise<void> | null = null;
  function bound() {
    if (events.length > MAX_DIAGNOSTIC_EVENTS) {
      droppedEvents += events.length - MAX_DIAGNOSTIC_EVENTS;
      events = events.slice(-MAX_DIAGNOSTIC_EVENTS);
    }
  }
  function schedule() {
    if (!initialized || queued || writing) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      void flush();
    });
  }
  function record(type: DiagnosticEventType, details: Record<string, unknown> = {}) {
    if (!EVENT_TYPES.includes(type)) return;
    events.push({
      ...clock(),
      bootId: options.bootId,
      build: options.build,
      sequence: sequence++,
      type,
      details: sanitizeDetails(details),
    });
    bound();
    revision++;
    schedule();
  }
  function snapshot(): DiagnosticSnapshot {
    return {
      schema: 1,
      capturedAt: clock().at,
      events: events.map((event) => ({ ...event, details: { ...event.details } })),
      droppedEvents,
      readFailures,
      writeFailures,
    };
  }
  const ready = Promise.resolve()
    .then(() => storage.read())
    .then((raw) => {
      if (raw === undefined) return;
      const previous = raw as Partial<DiagnosticSnapshot> | null;
      if (!previous || previous.schema !== 1 || !Array.isArray(previous.events)) {
        readFailures++;
        return;
      }
      const history = previous.events
        .map(sanitizeEvent)
        .filter((event): event is DiagnosticEvent => event !== null);
      droppedEvents += count(previous.droppedEvents) + previous.events.length - history.length;
      readFailures += count(previous.readFailures);
      writeFailures += count(previous.writeFailures);
      const offset = history.reduce(
        (next, event) =>
          event.bootId === options.bootId ? Math.max(next, event.sequence + 1) : next,
        0,
      );
      for (const event of events) event.sequence += offset;
      sequence += offset;
      events = [...history, ...events];
      bound();
    })
    .catch(() => {
      readFailures++;
    })
    .then(() => {
      initialized = true;
      schedule();
    });

  async function flush(): Promise<void> {
    await ready;
    if (writing) return writing;
    let failed = false;
    writing = (async () => {
      while (savedRevision !== revision) {
        const target = revision;
        try {
          await storage.write(snapshot());
          savedRevision = target;
        } catch {
          writeFailures++;
          failed = true;
          break;
        } // A later real event may retry; never install a retry timer.
      }
    })().finally(() => {
      writing = null;
      if (!failed && savedRevision !== revision) schedule();
    });
    return writing;
  }
  record(options.initialEvent ?? "worker.start");
  return { record, snapshot, flush };
}

let recorder: Pick<DiagnosticRecorder, "record"> | null = null;
export function setDiagnosticRecorder(next: Pick<DiagnosticRecorder, "record"> | null): void {
  recorder = next;
}
export function recordDiagnostic(
  type: DiagnosticEventType,
  details?: Record<string, unknown>,
): void {
  try {
    recorder?.record(type, details);
  } catch {
    /* Observations must not alter connection control flow. */
  }
}
