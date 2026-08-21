import type { CdpRunner } from "../shared";

function abortError(): Error {
  const error = new Error("hover perception aborted");
  error.name = "AbortError";
  return error;
}

export async function waitForHover(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function clearHover(cdp: CdpRunner, tabId: number): Promise<void> {
  await cdp
    .send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: -10,
      y: -10,
    })
    .catch(() =>
      cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 }).catch(() => {
        // Best effort cleanup.
      }),
    );
}
