import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDiagnosticRecorder,
  type DiagnosticSnapshot,
  MAX_DIAGNOSTIC_EVENTS,
  recordDiagnostic,
  setDiagnosticRecorder,
} from "../connection-diagnostics";

function memoryStore(initial?: unknown) {
  let value = initial;
  return {
    read: vi.fn(async () => structuredClone(value)),
    write: vi.fn(async (snapshot: DiagnosticSnapshot) => {
      value = structuredClone(snapshot);
    }),
    value: () => value as DiagnosticSnapshot,
  };
}
const options = (bootId = "boot-a") => ({ bootId, build: "issue395.1" });
afterEach(() => {
  setDiagnosticRecorder(null);
  vi.restoreAllMocks();
});

describe("connection diagnostic recorder", () => {
  it("ignores unknown fields that share names with object prototype properties", async () => {
    const storage = memoryStore();
    const recorder = createDiagnosticRecorder(storage, options());
    recorder.record("controller.request", {
      constructor: "PRIVATE",
      toString: "PRIVATE",
      state: "connecting",
    });
    await recorder.flush();
    expect(storage.value().events.at(-1)?.details).toEqual({ state: "connecting" });
  });

  it("does not report a worker restart when recording is enabled later", async () => {
    const storage = memoryStore();
    const recorder = createDiagnosticRecorder(storage, {
      ...options(),
      initialEvent: "diagnostics.enabled",
    });
    await recorder.flush();
    expect(storage.value().events.map((event) => event.type)).toEqual(["diagnostics.enabled"]);
  });

  it("continues retained sequence numbers when recording restarts in the same worker", async () => {
    const storage = memoryStore();
    const first = createDiagnosticRecorder(storage, options());
    first.record("socket.open");
    await first.flush();
    const second = createDiagnosticRecorder(storage, {
      ...options(),
      initialEvent: "diagnostics.enabled",
    });
    second.record("socket.close");
    await second.flush();
    expect(storage.value().events.map((event) => event.sequence)).toEqual([0, 1, 2, 3]);
  });

  it("preserves earlier boot events when a new recorder reads persisted storage", async () => {
    const storage = memoryStore();
    const first = createDiagnosticRecorder(storage, options());
    first.record("socket.open", { generation: 1 });
    await first.flush();
    const second = createDiagnosticRecorder(storage, options("boot-b"));
    await second.flush();
    expect(
      second
        .snapshot()
        .events.filter((e) => e.type === "worker.start")
        .map((e) => e.bootId),
    ).toEqual(["boot-a", "boot-b"]);
    expect(
      storage.value().events.some((e) => e.type === "socket.open" && e.bootId === "boot-a"),
    ).toBe(true);
  });

  it("bounds the buffer and counts discarded events across a restart", async () => {
    const storage = memoryStore();
    const recorder = createDiagnosticRecorder(storage, options());
    for (let i = 0; i < MAX_DIAGNOSTIC_EVENTS + 5; i++)
      recorder.record("socket.attempt", { generation: i });
    await recorder.flush();
    expect(recorder.snapshot().events).toHaveLength(MAX_DIAGNOSTIC_EVENTS);
    expect(recorder.snapshot().droppedEvents).toBe(6);
    const second = createDiagnosticRecorder(storage, options("boot-b"));
    await second.flush();
    expect(second.snapshot().droppedEvents).toBe(7);
    expect(second.snapshot().events.at(-1)?.type).toBe("worker.start");
  });

  it("retains events produced while the asynchronous initial read is pending", async () => {
    let finishRead!: (value: unknown) => void;
    const storage = memoryStore();
    storage.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const recorder = createDiagnosticRecorder(storage, options());
    recorder.record("socket.attempt", { generation: 1 });
    await Promise.resolve();
    finishRead(undefined);
    await recorder.flush();
    expect(storage.value().events.map((e) => e.type)).toEqual(["worker.start", "socket.attempt"]);
  });

  it("serializes overlapping writes so a later event cannot be overwritten", async () => {
    let releaseWrite!: () => void;
    let signalWrite!: () => void;
    const started = new Promise<void>((resolve) => {
      signalWrite = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const storage = memoryStore();
    const originalWrite = storage.write.getMockImplementation()!;
    storage.write.mockImplementationOnce(async (snapshot) => {
      signalWrite();
      await blocked;
      await originalWrite(snapshot);
    });
    const recorder = createDiagnosticRecorder(storage, options());
    const pending = recorder.flush();
    await started;
    recorder.record("socket.open", { generation: 1 });
    releaseWrite();
    await pending;
    await recorder.flush();
    expect(storage.value().events.at(-1)?.type).toBe("socket.open");
    expect(storage.write).toHaveBeenCalledTimes(2);
  });

  it("merges a synchronous event burst into one storage write without timers", async () => {
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const interval = vi.spyOn(globalThis, "setInterval");
    const storage = memoryStore();
    const recorder = createDiagnosticRecorder(storage, options());
    for (let i = 0; i < 50; i++) recorder.record("alarm.tick", { state: "connecting" });
    await recorder.flush();
    expect(storage.write).toHaveBeenCalledTimes(1);
    expect(timeout).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
  });

  it("persists an event arriving between write completion and release of the writer", async () => {
    const storage = memoryStore();
    const recorder = createDiagnosticRecorder(storage, options());
    await recorder.flush();
    let release!: () => void;
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const originalWrite = storage.write.getMockImplementation()!;
    storage.write.mockImplementationOnce(
      (snapshot) =>
        new Promise<void>((resolve) => {
          void originalWrite(snapshot);
          release = resolve;
          started();
        }),
    );
    recorder.record("socket.open", { generation: 1 });
    const pending = recorder.flush();
    await writing;
    release();
    queueMicrotask(() => recorder.record("socket.close", { generation: 1, code: 1006 }));
    await pending;
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(storage.value().events.at(-1)?.type).toBe("socket.close");
  });

  it("isolates a failed read and still records this worker", async () => {
    const storage = memoryStore();
    storage.read.mockRejectedValueOnce(new Error("private storage error"));
    const recorder = createDiagnosticRecorder(storage, options());
    await expect(recorder.flush()).resolves.toBeUndefined();
    expect(recorder.snapshot().readFailures).toBe(1);
    expect(storage.value().events.at(-1)?.type).toBe("worker.start");
    expect(JSON.stringify(storage.value())).not.toContain("private storage error");
  });

  it("does not autonomously retry failed writes and reports failure on the next successful write", async () => {
    const storage = memoryStore();
    storage.write.mockRejectedValueOnce(new Error("quota"));
    const recorder = createDiagnosticRecorder(storage, options());
    await recorder.flush();
    expect(recorder.snapshot().writeFailures).toBe(1);
    expect(storage.write).toHaveBeenCalledTimes(1);
    recorder.record("socket.open", { generation: 1 });
    await recorder.flush();
    expect(storage.value().writeFailures).toBe(1);
    expect(storage.value().events.at(-1)?.type).toBe("socket.open");
  });

  it("drops arbitrary payload fields and invalid values from new and persisted events", async () => {
    const storage = memoryStore();
    const recorder = createDiagnosticRecorder(storage, options());
    recorder.record("socket.close", {
      code: 1006,
      generation: 2,
      reason: "PRIVATE",
      url: "PRIVATE",
      token: "PRIVATE",
      gate: "PRIVATE",
      payload: { secret: "PRIVATE" },
    });
    await recorder.flush();
    const poisoned = storage.value();
    Object.assign(poisoned.events[0], { payload: "PRIVATE" });
    Object.assign(poisoned.events[0].details, { token: "PRIVATE" });
    storage.read.mockResolvedValue(poisoned);
    const second = createDiagnosticRecorder(storage, options("boot-b"));
    await second.flush();
    expect(JSON.stringify(second.snapshot())).not.toContain("PRIVATE");
    expect(second.snapshot().events.find((e) => e.type === "socket.close")?.details).toEqual({
      code: 1006,
      generation: 2,
    });
  });

  it("returns detached snapshots and records per-boot ordering plus both clocks", async () => {
    const storage = memoryStore();
    const recorder = createDiagnosticRecorder(storage, {
      ...options(),
      clock: () => ({ at: "2026-10-17T00:00:00.000Z", monotonicMs: 42 }),
    });
    recorder.record("socket.open", { generation: 1 });
    const snapshot = recorder.snapshot();
    snapshot.events.at(-1)!.details.generation = 99;
    expect(recorder.snapshot().events.at(-1)).toMatchObject({
      sequence: 1,
      monotonicMs: 42,
      at: "2026-10-17T00:00:00.000Z",
      details: { generation: 1 },
    });
    await recorder.flush();
  });

  it("never lets an observer exception escape into the connection caller", () => {
    setDiagnosticRecorder({
      record() {
        throw new Error("observer failed");
      },
    });
    expect(() => recordDiagnostic("socket.open", { generation: 1 })).not.toThrow();
  });
});
