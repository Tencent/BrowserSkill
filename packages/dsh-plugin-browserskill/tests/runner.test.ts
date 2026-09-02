import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
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
