import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DIAGNOSTIC_STORAGE_KEY,
  type DiagnosticSnapshot,
  recordDiagnostic,
  setDiagnosticRecorder,
} from "../connection-diagnostics";
import {
  DIAGNOSTIC_CONTROL_KIND,
  DIAGNOSTIC_ENABLED_KEY,
  handleDiagnosticMessage,
  startConnectionDiagnostics,
} from "../connection-diagnostics-runtime";

function store(enabled?: unknown) {
  const values: Record<string, unknown> = { [DIAGNOSTIC_ENABLED_KEY]: enabled };
  return {
    values,
    get: vi.fn(async (keys: string | string[]) =>
      Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(values[key])]),
      ),
    ),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(values, structuredClone(items));
    }),
    remove: vi.fn(async (key: string) => {
      delete values[key];
    }),
  };
}
const options = { bootId: "worker-a", build: "0.3.3@commit" };
const saved = (storage: ReturnType<typeof store>) =>
  storage.values[DIAGNOSTIC_STORAGE_KEY] as DiagnosticSnapshot;
const enable = { kind: DIAGNOSTIC_CONTROL_KIND, action: "set-enabled", enabled: true } as const;
const disable = { ...enable, enabled: false } as const;
const clear = { kind: DIAGNOSTIC_CONTROL_KIND, action: "clear" } as const;
async function drain() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
afterEach(() => setDiagnosticRecorder(null));

describe("opt-in connection diagnostics runtime", () => {
  it("isolates synchronous preference API failures from background startup", async () => {
    const storage = store();
    storage.get.mockImplementationOnce(() => {
      throw new Error("storage unavailable");
    });
    const runtime = startConnectionDiagnostics(storage, options);
    await expect(runtime.ready).resolves.toBeUndefined();
    expect(storage.set).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    false,
    "true",
    1,
  ])("does not read/write events while preference is %s", async (enabled) => {
    const storage = store(enabled);
    const runtime = startConnectionDiagnostics(storage, options);
    await runtime.ready;
    recordDiagnostic("alarm.tick", { state: "connecting" });
    await drain();
    expect(storage.get).toHaveBeenCalledExactlyOnceWith(DIAGNOSTIC_ENABLED_KEY);
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("starts a worker observation only when opt-in was persisted", async () => {
    const storage = store(true);
    const runtime = startConnectionDiagnostics(storage, options);
    await runtime.ready;
    const events = saved(storage).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "worker.start",
      bootId: options.bootId,
      build: options.build,
    });
    await runtime.control(disable);
  });

  it("enables explicitly, stops future observations, and resumes the same boot sequence", async () => {
    const storage = store();
    const runtime = startConnectionDiagnostics(storage, options);
    await runtime.control(enable);
    recordDiagnostic("socket.open");
    await runtime.control(disable);
    const stopped = structuredClone(saved(storage));
    recordDiagnostic("socket.close");
    await drain();
    expect(storage.values[DIAGNOSTIC_STORAGE_KEY]).toEqual(stopped);
    expect(stopped.events.map((e) => e.type)).toEqual(["diagnostics.enabled", "socket.open"]);
    await runtime.control(enable);
    await runtime.control(enable);
    await runtime.control(disable);
    expect(saved(storage).events.map((e) => e.sequence)).toEqual([0, 1, 2]);
    expect(storage.values[DIAGNOSTIC_ENABLED_KEY]).toBe(false);
  });

  it("drains an already-issued write before clear removes the log", async () => {
    const storage = store();
    const write = storage.set.getMockImplementation()!;
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((yes) => {
      release = yes;
    });
    const writing = new Promise<void>((yes) => {
      started = yes;
    });
    storage.set.mockImplementation(async (items) => {
      if (DIAGNOSTIC_STORAGE_KEY in items) {
        started();
        await blocked;
      }
      await write(items);
    });
    const runtime = startConnectionDiagnostics(storage, options);
    const enabling = runtime.control(enable);
    await writing;
    recordDiagnostic("socket.open");
    const clearing = runtime.control(clear);
    await drain();
    expect(storage.remove).not.toHaveBeenCalled();
    release();
    await Promise.all([enabling, clearing]);
    expect(storage.values[DIAGNOSTIC_STORAGE_KEY]).toBeUndefined();
    expect(storage.values[DIAGNOSTIC_ENABLED_KEY]).toBe(false);
    const calls = storage.set.mock.calls.length;
    recordDiagnostic("alarm.tick");
    await drain();
    expect(storage.set).toHaveBeenCalledTimes(calls);
    expect(storage.values[DIAGNOSTIC_STORAGE_KEY]).toBeUndefined();
  });

  it("keeps startup disabled after a preference read error", async () => {
    const storage = store(true);
    storage.get.mockRejectedValueOnce(new Error("private storage error"));
    const runtime = startConnectionDiagnostics(storage, options);
    await runtime.ready;
    recordDiagnostic("socket.attempt");
    await drain();
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("does not let a failed settings write poison subsequent controls", async () => {
    const storage = store();
    storage.set.mockRejectedValueOnce(new Error("private error"));
    const runtime = startConnectionDiagnostics(storage, options);
    await expect(runtime.control(enable)).rejects.toThrow("private error");
    recordDiagnostic("socket.open");
    await drain();
    expect(storage.values[DIAGNOSTIC_STORAGE_KEY]).toBeUndefined();
    await runtime.control(enable);
    expect(saved(storage).events).toHaveLength(1);
    await runtime.control(clear);
  });

  it("only accepts valid controls from this extension and replies generically on failure", async () => {
    const runtime = { control: vi.fn(async () => {}) };
    const reply = vi.fn();
    expect(handleDiagnosticMessage(runtime, enable, "other", "self", reply)).toBe(false);
    expect(
      handleDiagnosticMessage(runtime, { ...enable, enabled: "yes" }, "self", "self", reply),
    ).toBe(false);
    expect(handleDiagnosticMessage(runtime, { kind: "unrelated" }, "self", "self", reply)).toBe(
      false,
    );
    expect(runtime.control).not.toHaveBeenCalled();
    runtime.control.mockRejectedValueOnce(new Error("PRIVATE"));
    expect(handleDiagnosticMessage(runtime, enable, "self", "self", reply)).toBe(true);
    await drain();
    expect(reply).toHaveBeenLastCalledWith({ ok: false });
    expect(handleDiagnosticMessage(runtime, clear, "self", "self", reply)).toBe(true);
    await drain();
    expect(reply).toHaveBeenLastCalledWith({ ok: true });
  });
});
