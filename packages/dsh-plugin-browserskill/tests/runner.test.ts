import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BskRunResult,
  createBskRunner,
  isCommandNotFound,
  isSessionBusyResult,
  parseBskJson,
  runWithSessionBusyRetry,
} from "../src/runner";

/** Minimal fake stdio pipe recording whether the runner closed its end. */
class FakeStream extends EventEmitter {
  destroyed = false;

  destroy(): void {
    this.destroyed = true;
  }
}

/** Minimal fake ChildProcess driven by the test. */
class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  exitCode: number | null = null;
  signalCode: string | null = null;
  killedWith: string[] = [];
  unrefs = 0;

  unref(): void {
    this.unrefs += 1;
  }

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
    // Settling is not enough: our ends of the pipes have to go too, or a process
    // still holding the other ends keeps the host alive.
    expect([child.stdout.destroyed, child.stderr.destroyed]).toEqual([true, true]);
    expect(child.unrefs).toBe(1);
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

  it("closes its ends of the pipes after settling without close", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const runner = createBskRunner("bsk", fakeSpawn([child]));
    let result: BskRunResult | undefined;
    void runner.run(["session", "start"]).then((r) => {
      result = r;
    });
    child.stdout.emit("data", '{"session":"dfhj"}');
    child.exitCode = 0;
    child.emit("exit", 0, null); // process gone; a grandchild still holds the pipes
    await vi.advanceTimersByTimeAsync(300);
    expect(result).toMatchObject({ code: 0 });
    expect([child.stdout.destroyed, child.stderr.destroyed]).toEqual([true, true]);
    expect(child.unrefs).toBe(1);
  });

  it("keeps draining while the exited child's buffered output still arrives", async () => {
    // Bytes that land after `exit` are not necessarily someone else's: they can
    // be the child's own output, still buffered in the pipe. Each chunk reopens
    // the window so a delayed tail is not cut off.
    vi.useFakeTimers();
    const child = new FakeChild();
    const runner = createBskRunner("bsk", fakeSpawn([child]));
    let result: BskRunResult | undefined;
    void runner.run(["session", "start"], { timeoutMs: 120_000 }).then((r) => {
      result = r;
    });
    child.exitCode = 0;
    child.emit("exit", 0, null);
    child.stdout.emit("data", '{"session":');
    await vi.advanceTimersByTimeAsync(200);
    child.stdout.emit("data", '"dfhj"}'); // the tail, 200ms after the head
    await vi.advanceTimersByTimeAsync(200);
    expect(result).toBeUndefined(); // a fixed 250ms deadline would have cut here
    await vi.advanceTimersByTimeAsync(100); // 250ms of silence closes the window
    expect(result).toMatchObject({ code: 0, stdout: '{"session":"dfhj"}' });
  });

  it("settles at the drain cap when output keeps arriving after exit", async () => {
    // The other side of the boundary: output that never stops must not hold the
    // caller forever, so the cap ends the drain and collection stops with it.
    vi.useFakeTimers();
    const child = new FakeChild();
    const runner = createBskRunner("bsk", fakeSpawn([child]));
    let result: BskRunResult | undefined;
    void runner.run(["session", "start"]).then((r) => {
      result = r;
    });
    child.exitCode = 0;
    child.emit("exit", 0, null);
    // 200ms apart, so every chunk reopens the 250ms window; the last one before
    // the 2s cap lands at 1.8s.
    for (let elapsed = 0; elapsed < 2_000; elapsed += 200) {
      child.stdout.emit("data", "x");
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(result).toMatchObject({ code: 0, stdout: "x".repeat(10) });
    child.stdout.emit("data", "later");
    expect(result?.stdout).toBe("x".repeat(10));
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

  it("settles killAll and killFor children that never report back", async () => {
    // Both kill entry points take the same bounded path as a timeout, so a child
    // that answers neither the signal nor the pipes still releases its caller.
    vi.useFakeTimers();
    const children = [new FakeChild(), new FakeChild()];
    for (const child of children) {
      child.kill = (signal: string) => {
        child.killedWith.push(signal);
        return true; // no exit, no close, ever
      };
    }
    const runner = createBskRunner("bsk", fakeSpawn([...children]));
    const results: (BskRunResult | undefined)[] = [undefined, undefined];
    void runner.run(["snapshot"], { tag: "s1" }).then((r) => {
      results[0] = r;
    });
    void runner.run(["snapshot"]).then((r) => {
      results[1] = r;
    });
    expect(runner.killFor("s1")).toBe(1);
    runner.killAll();
    await vi.advanceTimersByTimeAsync(4_000); // SIGKILL at +3s, settle at +4s
    expect(results[0]).toMatchObject({ code: null });
    expect(results[1]).toMatchObject({ code: null });
    expect(children.map((c) => c.stdout.destroyed)).toEqual([true, true]);
  });
});

describe("createBskRunner against real processes", () => {
  // Node 22.18 and later strip types by default; earlier 22.x needs the flag to
  // load the runner's own TypeScript source in the host process below.
  const typeStripping = process.allowedNodeEnvironmentFlags.has("--experimental-strip-types")
    ? ["--experimental-strip-types"]
    : [];
  const runnerUrl = new URL("../src/runner.ts", import.meta.url).href;
  // Stands in for `bsk`: prints its JSON and exits, leaving a detached grandchild
  // that inherited the stdio pipes and holds them open (issue #180), so the
  // parent's `close` never fires.
  const fakeBsk = [
    'import { spawn } from "node:child_process";',
    'const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {',
    "  detached: true,",
    '  stdio: ["ignore", "inherit", "inherit"],',
    "});",
    "grandchild.unref();",
    "process.stdout.write(JSON.stringify({ ok: true, grandchild: grandchild.pid }));",
  ].join("\n");
  const hostSource = (bskPath: string) =>
    [
      `import { createBskRunner } from ${JSON.stringify(runnerUrl)};`,
      "const runner = createBskRunner(process.execPath);",
      `const result = await runner.run([${JSON.stringify(bskPath)}]);`,
      "process.stdout.write(JSON.stringify({ code: result.code, stdout: result.stdout }));",
    ].join("\n");

  it("settles and lets the host exit while a grandchild still holds the pipes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bsk-runner-"));
    let grandchild: number | undefined;
    try {
      const bskPath = join(dir, "bsk.mjs");
      await writeFile(bskPath, fakeBsk);
      const hostPath = join(dir, "host.mts");
      await writeFile(hostPath, hostSource(bskPath));
      // A separate process, because the claim is about the host staying alive:
      // it must run the command and then exit on its own.
      const host = spawn(process.execPath, [...typeStripping, "--no-warnings", hostPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      host.stdout.on("data", (chunk) => {
        out += chunk;
      });
      host.stderr.on("data", (chunk) => {
        err += chunk;
      });
      const guard = setTimeout(() => host.kill("SIGKILL"), 10_000);
      const code = await new Promise<number | null>((resolve) => host.on("close", resolve));
      clearTimeout(guard);
      expect(err).toBe("");
      expect(code).toBe(0); // null here means the guard had to kill a live host
      const settled = JSON.parse(out) as { code: number | null; stdout: string };
      expect(settled.code).toBe(0);
      const reply = JSON.parse(settled.stdout) as { ok: boolean; grandchild: number };
      expect(reply.ok).toBe(true);
      const pid = reply.grandchild;
      grandchild = pid;
      // Still running, so it still held the pipes: the host exited without
      // waiting for the `close` that the grandchild was suppressing.
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      if (grandchild !== undefined) {
        try {
          process.kill(grandchild, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("Windows parent cancellation", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  beforeEach(() => Object.defineProperty(process, "platform", { value: "win32" }));
  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    vi.useRealTimers();
  });

  it("opts in to stdin cancellation and waits for CLI reconciliation", async () => {
    const child = Object.assign(new FakeChild(), { stdin: new PassThrough() });
    const spawn = vi.fn(() => child as unknown as ChildProcess);
    const runner = createBskRunner("bsk", spawn);
    const abort = new AbortController();
    const result = runner.run(["snapshot"], { signal: abort.signal });
    expect(spawn.mock.calls[0]).toEqual([
      "bsk",
      ["snapshot", "--json"],
      {
        windowsHide: true,
        env: { ...process.env, BSK_CANCEL_ON_STDIN_CLOSE: "1" },
      },
    ]);
    abort.abort();
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.killedWith).toEqual([]);
    // Closing an already-exited child's pipe must not crash the host.
    child.stdin.emit("error", Object.assign(new Error("closed"), { code: "EPIPE" }));
    child.finish(2, '{"code":"cancelled"}');
    expect(await result).toMatchObject({ code: 2, aborted: true });
  });

  it("bounds cancellation of an old or unresponsive CLI", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new FakeChild(), { stdin: new PassThrough() });
    const runner = createBskRunner("bsk", fakeSpawn([child]));
    const result = runner.run(["snapshot"], { timeoutMs: 5 });
    await vi.advanceTimersByTimeAsync(5);
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.killedWith).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.killedWith).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.killedWith).toEqual(["SIGKILL"]);
    expect(await result).toMatchObject({ timedOut: true });
  });

  it("cancels only the requested tag and clears the fallback after exit", async () => {
    vi.useFakeTimers();
    const a = Object.assign(new FakeChild(), { stdin: new PassThrough() });
    const b = Object.assign(new FakeChild(), { stdin: new PassThrough() });
    const runner = createBskRunner("bsk", fakeSpawn([a, b]));
    const first = runner.run(["snapshot"], { tag: "a" });
    const second = runner.run(["snapshot"], { tag: "b" });
    expect(runner.killFor("a")).toBe(1);
    expect(a.stdin.writableEnded).toBe(true);
    expect(b.stdin.writableEnded).toBe(false);
    a.finish(2);
    b.finish(0);
    await Promise.all([first, second]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start work for an already-aborted call", async () => {
    const spawn = vi.fn();
    const runner = createBskRunner("bsk", spawn);
    const signal = AbortSignal.abort();
    expect(await runner.run(["snapshot"], { signal })).toMatchObject({ aborted: true });
    expect(spawn).not.toHaveBeenCalled();
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

  it("surfaces fill recovery guidance to the model without retrying", async () => {
    const hint =
      "observe the field before retrying; the page may have formatted the value. Continue if the visible result satisfies the user's intent";
    const reply = {
      ...base,
      code: 3,
      stdout: JSON.stringify({
        code: "cdp_failed",
        message: "fill could not verify the expected value",
        data: { reason: "fill_value_mismatch" },
        hint,
      }),
    };
    let calls = 0;
    const result = await runWithSessionBusyRetry(async () => {
      calls++;
      return reply;
    });
    expect(calls).toBe(1);
    expect(() => parseBskJson(result, "fill")).toThrow(hint);
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
