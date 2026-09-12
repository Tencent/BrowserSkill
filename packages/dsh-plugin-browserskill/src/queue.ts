/**
 * Per-key FIFO executor. The bsk daemon serializes commands per session (a
 * second command while one is unfinished is rejected), so every plugin
 * command — model-facing tool calls AND observation captures — funnels
 * through one queue per session. A queued task rejects early if its abort
 * signal fires before it starts; once running, cancellation is owned by the
 * task's own signal handling (the runner kills the child).
 */

export class KeyedExecutor {
  private readonly tails = new Map<string, Promise<void>>();

  /** Run `fn` after every previously queued task for `key` settled. */
  run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const task = new Promise<T>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (!settled) {
          settled = true;
          reject(abortError());
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      void previous.then(() => {
        if (settled) return;
        if (signal?.aborted) {
          settled = true;
          reject(abortError());
          return;
        }
        // Running now: cancellation flows through the task's own signal.
        signal?.removeEventListener("abort", onAbort);
        fn().then(
          (value) => {
            settled = true;
            resolve(value);
          },
          (error: unknown) => {
            settled = true;
            reject(error);
          },
        );
      });
    });
    // The stored tail never rejects, so one failure never strands the queue;
    // and it chains BOTH the previous tail and this task, so a task aborted
    // while still queued cannot let a later task overlap the one before it.
    const tail = Promise.allSettled([previous, task]).then(() => {});
    this.tails.set(key, tail);
    // Drop the entry once the queue drains, so the map tracks live keys only.
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return task;
  }
}

function abortError(): Error {
  const error = new Error("tool call aborted");
  error.name = "AbortError";
  return error;
}
