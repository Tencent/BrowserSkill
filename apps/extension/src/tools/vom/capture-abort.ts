function captureAbortError(): Error {
  const error = new Error("observation aborted");
  error.name = "AbortError";
  return error;
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null
    ? ((error as { name?: string }).name ?? "")
    : "";
}

export function isAbortError(error: unknown): boolean {
  return errorName(error) === "AbortError";
}

/** Errors after which the capture pipeline must stop instead of falling back.
 * A timed-out renderer read is terminal too: AX/geometry fallback must not keep
 * issuing reads after the renderer stopped answering. It is still reported as
 * a browser failure, not as a caller abort. */
export function isCaptureTerminalError(error: unknown): boolean {
  return ["AbortError", "CdpReadTimeoutError"].includes(errorName(error));
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw captureAbortError();
}

/** Check at bounded work blocks; yield only after a processing slice is spent.
 * Each caller owns its deadline, so unrelated captures do not share state. */
export function createCaptureCheckpoint(signal?: AbortSignal): () => Promise<void> | undefined {
  throwIfAborted(signal);
  let deadline = performance.now() + 8;
  return () => {
    throwIfAborted(signal);
    if (performance.now() < deadline) return;
    return new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(null);
    }).then(() => {
      throwIfAborted(signal);
      deadline = performance.now() + 8;
    });
  };
}
