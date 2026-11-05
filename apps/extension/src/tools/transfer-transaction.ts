// Shared time boundary for browser-side transactions. Concrete operations
// own their state machines and effect semantics.

export class BoundedWaitError extends Error {
  constructor(
    readonly kind: "timeout" | "aborted",
    message: string,
  ) {
    super(message);
  }
}

export function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

export async function waitBounded<T>(
  promise: Promise<T>,
  deadline: number,
  signal: AbortSignal | undefined,
  timeoutMessage: string,
): Promise<T> {
  const remaining = remainingMs(deadline);
  if (signal?.aborted || remaining === 0) {
    // Work may already be in flight when its caller retires it. Consume a late
    // rejection even though this boundary no longer waits for the result.
    void promise.catch(() => {});
    throw signal?.aborted
      ? new BoundedWaitError("aborted", "operation aborted")
      : new BoundedWaitError("timeout", timeoutMessage);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BoundedWaitError("timeout", timeoutMessage)), remaining);
    if (signal) {
      onAbort = () => reject(new BoundedWaitError("aborted", "operation aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([promise, boundary]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}
