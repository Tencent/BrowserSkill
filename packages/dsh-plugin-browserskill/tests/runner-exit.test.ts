import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBskRunner } from "../src/runner";

/** Real streams, with process exit and stdio close deliberately independent. */
class DrainingChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn(() => true);

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
    else await vi.advanceTimersByTimeAsync(500);
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

  it.each([
    "timeout",
    "abort",
  ])("preserves %s while waiting for close after exit", async (cause) => {
    const { child, runner } = setup();
    const controller = new AbortController();
    const completed = vi.fn();
    const promise = runner.run(["snapshot"], {
      signal: controller.signal,
      timeoutMs: cause === "timeout" ? 50 : 120_000,
    });
    void promise.then(completed);
    child.stdout.write("{}");
    child.exit(0);
    if (cause === "abort") controller.abort();
    await vi.advanceTimersByTimeAsync(1000);

    expect(completed).toHaveBeenCalledExactlyOnceWith({
      code: 0,
      stdout: "{}",
      stderr: "",
      timedOut: cause === "timeout",
      aborted: cause === "abort",
    });
    await promise;
    expect(vi.getTimerCount()).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
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
