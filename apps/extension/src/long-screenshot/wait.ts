import { ScreenshotError } from "./types";

/** Chrome APIs cannot be aborted, but a stuck call must not strand a page/job. */
export function waitForReply<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  timeoutMs = 8000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal?.reason ?? new ScreenshotError("interrupted"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new ScreenshotError("timeout"));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    // Install both handlers even after an abort, to consume late API rejections.
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
