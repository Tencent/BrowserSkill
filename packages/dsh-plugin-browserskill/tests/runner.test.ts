import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { type BskRunResult, createBskRunner, isCommandNotFound, parseBskJson } from "../src/runner";

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
    expect(child.killedWith).toContain("SIGTERM");
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
    expect(child.killedWith).toContain("SIGTERM");
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
