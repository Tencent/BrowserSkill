import { afterEach, expect, it, vi } from "vitest";
import { captureReply } from "./capture-deadline";

afterEach(() => vi.useRealTimers());

it("bounds a stalled capture and consumes a late Chrome failure", async () => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const chrome = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const result = captureReply(chrome, new AbortController().signal);
  const expired = expect(result).rejects.toThrow("within 10s");
  await vi.advanceTimersByTimeAsync(10_000);
  await expired;
  reject(new Error("late browser reply"));
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
});
