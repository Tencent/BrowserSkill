import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BskRunResult,
  createBskRunner,
  isCommandNotFound,
  isSessionBusyResult,
  parseBskJson,
  runWithSessionBusyRetry,
} from "../src/runner";

/** Minimal fake ChildProcess driven by the test. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: string | null = null;
  killedWith: string[] = [];

  kill(signal: string): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.killedWith.push(signal);
    this.signalCode = signal;
    queueMicrotask(() => this.emit("close", null));
    return true;
  }

  finish(code: number, stdout = "", stderr = ""): void {
    if (stdout) this.stdout.emit("data", stdout);
    if (stderr) this.stderr.emit("data", stderr);
    this.exitCode = code;
    this.emit("close", code);
  }
}

function fakeSpawn(children: FakeChild[]) {
  return () => {
    const child = children.shift();
    if (child === undefined) throw new Error("no fake child queued");
    return child as unknown as ChildProcess;
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createBskRunner", () => {
  it("appends --json and collects stdout", async () => {
    const child = new FakeChild();
    const seen: string[][] = [];
    const runner = createBskRunner("bsk", (cmd: string, args: string[]) => {
      seen.push([cmd, ...args]);
      return child as unknown as ChildProcess;
    });
    const promise = runner.run(["session", "list"]);
    child.finish(0, '{"ok":true}');
    const result = await promise;
    expect(seen).toEqual([["bsk", "session", "list", "--json"]]);
    expect(result).toMatchObject({
      code: 0,
      stdout: '{"ok":true}',
      aborted: false,
      timedOut: false,
    });
  });

  it("kills the child when the abort signal fires", async () => {
    const child = new FakeChild();
    const runner = createBskRunner("bsk", fakeSpawn([child]));
    const controller = new AbortController();
    const promise = runner.run(["snapshot"], { signal: controller.signal });
    controller.abort();
    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(child.killedWith).toContain("SIGINT");
  });

  it("kills the child on timeout", async () => {
    const child = new FakeChild();
    const runner = createBskRunner("bsk", fakeSpawn([child]));
    const result = await runner.run(["snapshot"], { timeoutMs: 5 });
    expect(result.timedOut).toBe(true);
    expect(child.killedWith.length).toBeGreaterThan(0);
  });

  it("settles on timeout even when close never fires", async () => {
    // When something else still holds the stdio pipes (issue #180: the daemon
    // `bsk` auto-spawned), `exit` fires but `close` never follows.
    const child = new FakeChild();
    child.kill = (signal: string) => {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      child.killedWith.push(signal);
      child.signalCode = signal;
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    };
    const runner = createBskRunner("bsk", fakeSpawn([child]));
    const result = await Promise.race([
      runner.run(["session", "start"], { timeoutMs: 5 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("run() never settled")), 2_000),
      ),
    ]);
    expect(result).toMatchObject({ code: null, timedOut: true });
    expect(child.killedWith).toContain("SIGINT");
  });

  it("settles on abort even when close never fires", async () => {
    const child = new FakeChild();
    child.kill = (signal: string) => {
      child.killedWith.push(signal);
      child.signalCode = signal;
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    };
    const runner = createBskRunner("bsk", fakeSpawn([child]));
    const controller = new AbortController();
    const promise = runner.run(["snapshot"], { signal: controller.signal });
    controller.abort();
    const result = await Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("run() never settled")), 2_000),
      ),
    ]);
    expect(result).toMatchObject({ code: null, aborted: true });
  });

  it("settles after the kill grace when neither exit nor close ever fires", async () => {
    // The kill lands but the child reports nothing back at all: no `exit`, no
    // `close`. The caller must still be released.
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill = (signal: string) => {
      // The signal is delivered but the process never dies, so Node never
      // populates signalCode and SIGKILL must escalate after the grace period.
      child.killedWith.push(signal);
      return true; // no exit, no close, ever
    };
    const runner = createBskRunner("bsk", fakeSpawn([child]));
    let result: BskRunResult | undefined;
    void runner.run(["session", "start"], { timeoutMs: 100 }).then((r) => {
      result = r;
    });
    await vi.advanceTimersByTimeAsync(100); // timeout fires -> SIGINT
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(4_000); // SIGKILL at +3s, settle at +4s
    expect(result).toMatchObject({ code: null, timedOut: true });
    expect(child.killedWith).toEqual(["SIGINT", "SIGKILL"]);
  });

  it("returns the output after a normal exit even when close never fires", async () => {
    // The shape of issue #180: `bsk session start` prints its JSON and exits, but
    // the daemon it auto-spawned still holds the stdio pipes, so `close` never fires.
    vi.useFakeTimers();
    const child = new FakeChild();
    const runner = createBskRunner("bsk", fakeSpawn([child]));
    let result: BskRunResult | undefined;
    void runner.run(["session", "start"], { timeoutMs: 120_000 }).then((r) => {
      result = r;
    });
    child.stdout.emit("data", '{"session":"dfhj"}');
    child.exitCode = 0;
    child.emit("exit", 0, null); // process gone; pipes still held open
    await vi.advanceTimersByTimeAsync(200);
    expect(result).toBeUndefined(); // still inside the drain grace
    await vi.advanceTimersByTimeAsync(100);
    expect(result).toMatchObject({ code: 0, stdout: '{"session":"dfhj"}', timedOut: false });
  });

  it("settles immediately on timeout when the process already exited", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const runner = createBskRunner("bsk", fakeSpawn([child]));
    let result: BskRunResult | undefined;
    void runner.run(["snapshot"], { timeoutMs: 100 }).then((r) => {
      result = r;
    });
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(100); // timeout lands before the drain grace ends
    expect(result).toMatchObject({ code: 0, timedOut: true });
    expect(child.killedWith).toEqual([]); // nothing to kill
  });

  it("still waits for close on a normal exit so stdout is fully drained", async () => {
    const child = new FakeChild();
    const runner = createBskRunner("bsk", fakeSpawn([child]));
    const promise = runner.run(["session", "list"]);
    child.exitCode = 0;
    child.emit("exit", 0, null); // process gone, pipes still open
    child.stdout.emit("data", '{"late":true}');
    child.emit("close", 0); // now the pipes shut
    const result = await promise;
    expect(result).toMatchObject({ code: 0, stdout: '{"late":true}' });
  });

  it("killAll terminates in-flight children", async () => {
    const child = new FakeChild();
    const runner = createBskRunner("bsk", fakeSpawn([child]));
    const promise = runner.run(["session", "list"]);
    runner.killAll();
    const result = await promise;
    expect(child.killedWith).toContain("SIGINT");
    expect(result.code).toBeNull();
  });
});

describe("parseBskJson", () => {
  const base: BskRunResult = { code: 0, stdout: "", stderr: "", timedOut: false, aborted: false };

  it("parses stdout JSON on success", () => {
    expect(parseBskJson({ ...base, stdout: '{"a":1}' }, "status")).toEqual({ a: 1 });
  });

  it("maps the JSON error envelope on non-zero exit", () => {
    const body = JSON.stringify({
      code: "no_browser",
      message: "no browser connected",
      hint: "open Chrome",
    });
    try {
      parseBskJson({ ...base, code: 3, stdout: body }, "session start");
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        name: "BskError",
        code: "no_browser",
        hint: "open Chrome",
        exitCode: 3,
      });
      expect((error as Error).message).toContain("no browser connected");
      expect((error as Error).message).toContain("hint: open Chrome");
    }
  });

  it("falls back to stderr when the error body is not JSON", () => {
    expect(() => parseBskJson({ ...base, code: 1, stderr: "boom" }, "x")).toThrow(/boom/);
  });

  it("reports killed-by-interrupt children (null exit code) as interrupted", () => {
    expect(() => parseBskJson({ ...base, code: null }, "navigate")).toThrow(/interrupted/);
  });

  it("reports timeouts distinctly", () => {
    expect(() => parseBskJson({ ...base, timedOut: true }, "x")).toThrow(/timed out/);
  });

  it("rejects non-JSON success output", () => {
    expect(() => parseBskJson({ ...base, stdout: "not json" }, "x")).toThrow(
      /did not produce JSON/,
    );
  });
});

describe("isCommandNotFound", () => {
  it("detects ENOENT spawn failures", () => {
    expect(
      isCommandNotFound(Object.assign(new Error("spawn bsk ENOENT"), { code: "ENOENT" })),
    ).toBe(true);
    expect(isCommandNotFound(new Error("other"))).toBe(false);
  });
});

describe("session busy reconciliation", () => {
  const busy: BskRunResult = {
    code: 4,
    stdout: JSON.stringify({
      code: "timeout",
      message: "session already has an unfinished command",
      data: { reason: "session_busy" },
    }),
    stderr: "",
    timedOut: false,
    aborted: false,
  };
  const ok: BskRunResult = {
    code: 0,
    stdout: "{}",
    stderr: "",
    timedOut: false,
    aborted: false,
  };

  it("recognizes only the structured session_busy reason", () => {
    expect(isSessionBusyResult(busy)).toBe(true);
    expect(isSessionBusyResult({ ...busy, stdout: '{"code":"timeout"}' })).toBe(false);
    expect(isSessionBusyResult(ok)).toBe(false);
  });

  it("retries one transient busy result and returns the settled response", async () => {
    const replies = [busy, ok];
    let calls = 0;
    const result = await runWithSessionBusyRetry(async () => {
      calls += 1;
      return replies.shift() ?? ok;
    });
    expect(result).toBe(ok);
    expect(calls).toBe(2);
  });

  it("does not loop on a persistent busy result", async () => {
    let calls = 0;
    const result = await runWithSessionBusyRetry(async () => {
      calls += 1;
      return busy;
    });
    expect(result).toBe(busy);
    expect(calls).toBe(2);
  });
});
