import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBskRunner, parseBskJson } from "../src/runner";

/** Real streams, with process exit and stdio close deliberately independent. */
class DrainingChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn(() => true);
  unref = vi.fn();

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

describe.each(["win32", "linux"])("exited child output draining on %s", (platform) => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    vi.useFakeTimers();
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    vi.useRealTimers();
  });

  function setup() {
    const child = new DrainingChild();
    const runner = createBskRunner("bsk", () => child as unknown as ChildProcess);
    return { child, runner };
  }

  it.each(["close", "drain deadline"])("collects trailing output until %s", async (completion) => {
    const { child, runner } = setup();
    const completed = vi.fn();
    const promise = runner.run(["session", "start"], { tag: "start", timeoutMs: 120_000 });
    void promise.then(completed);
    child.stdout.write('{"session_id":');
    child.exit(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(completed).not.toHaveBeenCalled();
    child.stdout.write('"owned"}');
    child.stderr.write("trailing diagnostic");
    if (completion === "close") child.emit("close", 0);
    else await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();

    expect(completed).toHaveBeenCalledExactlyOnceWith({
      code: 0,
      stdout: '{"session_id":"owned"}',
      stderr: "trailing diagnostic",
      timedOut: false,
      aborted: false,
    });
    await promise;
    expect(vi.getTimerCount()).toBe(0);
    expect(runner.killFor("start")).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
    if (completion === "drain deadline") {
      expect(child.stdin.destroyed).toBe(true);
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
    }
    child.emit("close", 0);
    child.emit("error", new Error("late child error"));
    expect(completed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows trailing output to finish beyond the execution timeout", async () => {
    const { child, runner } = setup();
    const completed = vi.fn();
    const promise = runner.run(["snapshot"], { timeoutMs: 1400 });
    void promise.then(completed);
    child.stdout.write('{"ok":');
    child.exit(0);
    await vi.advanceTimersByTimeAsync(500);
    child.stdout.write("true}");
    await vi.advanceTimersByTimeAsync(900); // execution deadline, still inside the drain window
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100); // one second since the trailing chunk

    const result = await promise;
    expect(result).toMatchObject({ code: 0, timedOut: false, aborted: false });
    expect(parseBskJson(result, "snapshot")).toEqual({ ok: true });
    expect(completed).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors an explicit abort immediately while output is still draining", async () => {
    const { child, runner } = setup();
    const controller = new AbortController();
    const promise = runner.run(["snapshot"], { signal: controller.signal, timeoutMs: 120_000 });
    child.stdout.write('{"ok":');
    child.exit(0);
    controller.abort();

    // No timer advancement: explicit cancellation must not wait for the drain.
    expect(await promise).toMatchObject({ code: 0, timedOut: false, aborted: true });
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.stdin.destroyed).toBe(true);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["killFor", "killAll"])("preserves an exited child's output during %s", async (kind) => {
    const { child, runner } = setup();
    const completed = vi.fn();
    const promise = runner.run(["snapshot"], { tag: "owned", timeoutMs: 120_000 });
    void promise.then(completed);
    child.stdout.write('{"ok":');
    child.exit(0);
    if (kind === "killFor") expect(runner.killFor("owned")).toBe(0);
    else runner.killAll();
    await vi.advanceTimersByTimeAsync(50);
    expect(completed).not.toHaveBeenCalled();
    expect(child.stdout.destroyed).toBe(false);
    child.stdout.write("true}");
    child.emit("close", 0);

    const result = await promise;
    expect(result).toMatchObject({ code: 0, timedOut: false, aborted: false });
    expect(parseBskJson(result, "snapshot")).toEqual({ ok: true });
    expect(child.kill).not.toHaveBeenCalled();
    expect(completed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts only running children with the requested tag", async () => {
    const [draining, active, other] = [
      new DrainingChild(),
      new DrainingChild(),
      new DrainingChild(),
    ];
    const children = [draining, active, other];
    const runner = createBskRunner("bsk", () => children.shift() as unknown as ChildProcess);
    const first = runner.run(["snapshot"], { tag: "owned" });
    const second = runner.run(["snapshot"], { tag: "owned" });
    const third = runner.run(["snapshot"], { tag: "other" });
    draining.stdout.write("{}");
    draining.exit(0);

    expect(runner.killFor("owned")).toBe(1);
    expect(draining.stdin.writableEnded).toBe(false);
    expect(draining.kill).not.toHaveBeenCalled();
    expect(other.stdin.writableEnded).toBe(false);
    expect(other.kill).not.toHaveBeenCalled();
    if (platform === "win32") expect(active.stdin.writableEnded).toBe(true);
    else expect(active.kill).toHaveBeenCalledWith("SIGINT");

    draining.emit("close", 0);
    active.exit(2);
    active.emit("close", 2);
    other.exit(0);
    other.emit("close", 0);
    await Promise.all([first, second, third]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for process exit after timeout, then bounds missing close", async () => {
    const { child, runner } = setup();
    const completed = vi.fn();
    const promise = runner.run(["snapshot"], { timeoutMs: 50 });
    void promise.then(completed);
    await vi.advanceTimersByTimeAsync(50);
    const grace = platform === "win32" ? 15_000 : 3000;
    await vi.advanceTimersByTimeAsync(grace - 1);
    expect(completed).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(completed).not.toHaveBeenCalled();
    child.exit(null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(1000);

    expect(completed).toHaveBeenCalledExactlyOnceWith({
      code: null,
      stdout: "",
      stderr: "",
      timedOut: true,
      aborted: false,
    });
    await promise;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up cancellation timers when the child exits without close", async () => {
    const { child, runner } = setup();
    const controller = new AbortController();
    const completed = vi.fn();
    const promise = runner.run(["snapshot"], { signal: controller.signal, timeoutMs: 120_000 });
    void promise.then(completed);
    controller.abort();
    child.stdout.write('{"code":"cancelled"}');
    child.exit(2);
    await vi.advanceTimersByTimeAsync(1000);

    expect(completed).toHaveBeenCalledOnce();
    expect(await promise).toMatchObject({ code: 2, aborted: true, timedOut: false });
    expect(vi.getTimerCount()).toBe(0);
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
  });

  it("clears the drain deadline when the child reports an error", async () => {
    const { child, runner } = setup();
    const completed = vi.fn();
    const failed = vi.fn();
    const promise = runner.run(["snapshot"], { timeoutMs: 120_000 });
    void promise.then(completed, failed);
    child.exit(0);
    const error = new Error("pipe failure");
    child.emit("error", error);
    await expect(promise).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
    child.emit("exit", 0);
    child.emit("close", 0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(failed).toHaveBeenCalledExactlyOnceWith(error);
    expect(completed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
