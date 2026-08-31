import type { MouseButton } from "@/transport/types";
import type { Point } from "./geometry";
import type { CdpRunner } from "./shared";

interface MouseClickDispatchOptions {
  button: MouseButton;
  clickCount: number;
  modifiers: number;
  signal?: AbortSignal;
  moveSettleMs?: number;
}

type MouseClickDispatchResult = "completed" | "cancelled";

function waitForSettle(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(signal?.aborted !== true);
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(true), ms);
    const onAbort = () => finish(false);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Dispatch one coherent CDP mouse click in top-viewport CSS coordinates.
 *
 * Keeping the sequence here prevents DOM and Surface interaction paths from
 * duplicating cancellation and best-effort release behavior. Callers that
 * target asynchronously hit-tested content may request a settle interval.
 */
export async function dispatchMouseClick(
  cdp: CdpRunner,
  tabId: number,
  point: Point,
  options: MouseClickDispatchOptions,
): Promise<MouseClickDispatchResult> {
  const { button, clickCount, modifiers, signal, moveSettleMs = 0 } = options;
  let pressed = false;
  const release = () =>
    cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button,
      clickCount,
      modifiers,
    });

  try {
    await cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      modifiers,
    });
    if (!(await waitForSettle(moveSettleMs, signal))) return "cancelled";

    await cdp.send(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button,
      clickCount,
      modifiers,
    });
    pressed = true;

    if (signal?.aborted) {
      await release();
      pressed = false;
      return "cancelled";
    }

    await release();
    pressed = false;
    return "completed";
  } catch (error) {
    if (pressed) {
      try {
        await release();
      } catch (releaseError) {
        console.debug("[bsk mouse-input] best-effort mouse release failed", releaseError);
      }
    }
    throw error;
  }
}
