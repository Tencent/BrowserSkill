/** Per-event scheduling for `tool.wheel`, kept free of browser dependencies. */

/** Geometric decay per event for `ease_out`. */
export const EASE_OUT_DECAY = 0.82;

export type WheelStep = readonly [number, number];
export type WheelEasing = "linear" | "ease_out";

/**
 * Split the requested total delta into per-event deltas.
 *
 * One event keeps the exact requested delta. Larger operations normalize the
 * weights, so the steps sum to the request instead of multiplying it.
 */
export function wheelSchedule(
  deltaX: number,
  deltaY: number,
  events: number,
  easing: WheelEasing,
): WheelStep[] {
  if (events <= 1) return [[deltaX, deltaY]];
  const weights =
    easing === "ease_out"
      ? Array.from({ length: events }, (_, index) => EASE_OUT_DECAY ** index)
      : Array.from({ length: events }, () => 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => [deltaX * (weight / total), deltaY * (weight / total)] as const);
}

/**
 * Wait one inter-event interval without overrunning the operation deadline.
 *
 * Resolves `false` when the wait ends because the deadline passed or the
 * caller aborted, so the operation stops instead of dispatching past its budget.
 */
export function waitWithinInterval(
  ms: number,
  deadline: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve(false);
  const wait = Math.min(ms, remaining);
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve(!signal?.aborted && Date.now() < deadline);
    };
    const timer = setTimeout(finish, wait);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
