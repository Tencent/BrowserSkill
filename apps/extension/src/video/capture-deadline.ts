import { VideoError } from "./errors";

/** Chrome cannot cancel an already dispatched screenshot. Stop waiting for it
 * on cancellation/deadline and ignore its late result before opening an encoder. */
export async function captureReply<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason ?? new Error("Video capture cancelled"));
        timer = setTimeout(
          () =>
            reject(
              new VideoError({
                code: "timeout",
                message: "Video capture did not respond within 10s",
              }),
            ),
          10_000,
        );
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}
