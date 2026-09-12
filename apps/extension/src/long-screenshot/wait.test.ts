import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForReply } from "./wait";

afterEach(() => vi.useRealTimers());
describe("bounded browser API calls", () => {
  it("times out an API that never calls back", async () => {
    vi.useFakeTimers();
    const promise = waitForReply(new Promise(() => {}), undefined, 100);
    const assertion = expect(promise).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it("cancels immediately and consumes a later API rejection", async () => {
    const controller = new AbortController();
    let rejectApi: (error: Error) => void = () => {};
    const promise = waitForReply(
      new Promise((_, reject) => {
        rejectApi = reject;
      }),
      controller.signal,
    );
    const assertion = expect(promise).rejects.toBeDefined();
    controller.abort();
    await assertion;
    rejectApi(new Error("late browser failure"));
    await Promise.resolve();
  });
});
