import {
  INPUT_PASSTHROUGH,
  INPUT_PASSTHROUGH_TTL_MS,
  type InputPassthroughSendToTab,
  sendInputPassthrough,
} from "@/lib/input-passthrough-bridge";
import { OVERLAY_HOST_SELECTOR } from "@/lib/overlay-bridge";
import type { RpcError } from "@/transport/types";
import { rpcError } from "./errors";
import { type CdpRunner, isRpcError } from "./shared";

export interface ClickOverlayDeps {
  cdp: CdpRunner;
  signal?: AbortSignal;
  /** Acquire/release only this operation's automation bypass reference. */
  bypassOverlay?: (tabId: number, enabled: boolean) => Promise<void>;
  sendInputPassthrough?: InputPassthroughSendToTab;
  /** Let a bounded operation release these resources without waiting for input replies. */
  registerClickCleanup?: (cleanup: () => Promise<void>) => () => void;
}

type OverlayHit = "absent" | "clear" | "covered" | "unknown";

/**
 * Why the click point could not be proven clear. The causes need different
 * follow-up and used to share one opaque message, so a caller could not tell
 * "the overlay is still there" from "the hit test never answered" or "the
 * passthrough lease ran out" (#556).
 *
 * `passthrough_headroom` and `passthrough_expired` are split because
 * `pressDeadlineReached()` also rejects a fresh lease when the gesture's input
 * budget is longer than the lease itself (drag with a hold), which no amount of
 * waiting fixes: the gesture has to be shortened.
 */
type OverlayClearFailure =
  | "overlay_still_covered"
  | "overlay_state_unknown"
  | "passthrough_headroom"
  | "passthrough_expired";

const OVERLAY_CLEAR_MESSAGES: Record<
  OverlayClearFailure,
  (point: { x: number; y: number }) => string
> = {
  overlay_still_covered: ({ x, y }) =>
    `The BrowserSkill overlay still covers the click point (${x}, ${y}) after bypass and input passthrough`,
  overlay_state_unknown: ({ x, y }) =>
    `Could not confirm the click point (${x}, ${y}) is clear: the overlay hit test did not answer after bypass`,
  passthrough_headroom: ({ x, y }) =>
    `Input passthrough has too little lease left for this gesture at the click point (${x}, ${y})`,
  passthrough_expired: ({ x, y }) =>
    `Input passthrough expired before the click point (${x}, ${y}) could be verified`,
};

const OVERLAY_CLEAR_RECOVERY: Record<OverlayClearFailure, string> = {
  overlay_still_covered:
    "Synchronize and inspect the reported click point. If the overlay still covers it, reload the tab once before retrying.",
  overlay_state_unknown:
    "Retry the action; a page that keeps the hit test unreadable is not safe to click through. Use get-html or snapshot to inspect it instead.",
  passthrough_headroom:
    "Shorten the gesture (its hold or drag duration) so it fits inside the input passthrough lease, or run the action without passthrough. Waiting and lowering the action timeout cannot change this.",
  passthrough_expired:
    "Wait for the page to settle and retry. The passthrough lease ran out while the gesture was still in flight.",
};

/** Prepare before mouseMoved, then check again before every press. */
export async function withClickOverlay<T>(
  tabId: number,
  point: { x: number; y: number },
  deps: ClickOverlayDeps,
  click: (beforePress: () => Promise<RpcError | null>) => Promise<T>,
  alwaysBypass = false,
  inputBudgetMs = 1_000,
): Promise<T | RpcError> {
  const send = deps.sendInputPassthrough ?? sendInputPassthrough;
  let bypass = false;
  // Resolving `bypassOverlay` does not prove the content side received the
  // enable message: the production callback swallows a failed or timed-out
  // send. Report the request, not a confirmed state.
  let bypassState: "not_requested" | "requested" | "failed" | "unsupported" = deps.bypassOverlay
    ? "not_requested"
    : "unsupported";
  let bypassAcquisition: Promise<void> | undefined;
  let passthroughId: string | undefined;
  let retired = false;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    retired = true;
    // Outer retirement and a late inner finally share one release of each resource.
    cleanupPromise ??= (async () => {
      const results = await Promise.allSettled([
        (async () => {
          if (passthroughId)
            await send(tabId, { type: INPUT_PASSTHROUGH, phase: "end", id: passthroughId });
        })(),
        (async () => {
          await bypassAcquisition;
          if (bypass) await deps.bypassOverlay!(tabId, false);
        })(),
      ]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
    })();
    return cleanupPromise;
  };
  const unregisterCleanup = deps.registerClickCleanup?.(cleanup);
  let passthroughExpiresAt = Infinity;
  const expired = () => Date.now() >= passthroughExpiresAt;
  // Reserve enough lease for the gesture; slow delivery still reports an unknown outcome.
  const pressDeadlineReached = () => Date.now() >= passthroughExpiresAt - inputBudgetMs;
  // A fresh lease is also rejected when the gesture's budget exceeds the lease
  // itself, which no amount of waiting fixes.
  const deadlineFailure = (): OverlayClearFailure =>
    expired() ? "passthrough_expired" : "passthrough_headroom";
  const notReady = (failure: OverlayClearFailure, observed: OverlayHit) =>
    rpcError("cdp_failed", "input_not_ready", OVERLAY_CLEAR_MESSAGES[failure](point), {
      effect_state: "none",
      pointer_moved: false,
      click_point: { x: point.x, y: point.y },
      overlay_probe: observed,
      overlay_bypass: bypassState,
      overlay_passthrough: passthroughId ? "attempted" : "not_started",
      recovery: OVERLAY_CLEAR_RECOVERY[failure],
    });
  const cancelled = (): RpcError => ({
    code: "cancelled",
    message: "click aborted",
    data: { effect_state: "none", pointer_moved: false },
  });
  const probe = async (): Promise<OverlayHit> => {
    try {
      const selector = JSON.stringify(OVERLAY_HOST_SELECTOR);
      const hit = await deps.cdp.send<{
        result?: { value?: unknown };
        exceptionDetails?: unknown;
      }>(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const host = document.querySelector(${selector});
          if (!host) return "absent";
          return document.elementFromPoint(${point.x},${point.y})?.closest(${selector}) ? "covered" : "clear";
        })()`,
        returnByValue: true,
      });
      const value = hit.result?.value;
      if (!hit.exceptionDetails && (value === "absent" || value === "clear" || value === "covered"))
        return value;
      console.debug("[bsk click] overlay hit-test returned no result", hit.exceptionDetails);
    } catch (error) {
      console.debug("[bsk click] overlay hit-test failed", error);
    }
    return "unknown";
  };
  try {
    if (retired || deps.signal?.aborted) return cancelled();
    let hit = await probe();
    let covered = hit === "covered";
    if (retired || deps.signal?.aborted) return cancelled();
    if ((alwaysBypass || covered) && deps.bypassOverlay) {
      try {
        bypassAcquisition = deps.bypassOverlay(tabId, true).then(() => {
          bypass = true;
          bypassState = "requested";
        });
        await bypassAcquisition;
      } catch (error) {
        bypassState = "failed";
        console.debug("[bsk click] overlay bypass enable failed", error);
      }
      // Enabling bypass can also render newly arrived control UI.
      hit = await probe();
      covered ||= hit === "covered";
    }
    if (retired || deps.signal?.aborted) return cancelled();
    if (hit === "covered") {
      passthroughId = crypto.randomUUID();
      // Start before sending, so our deadline cannot outlive the content-side lease.
      passthroughExpiresAt = Date.now() + INPUT_PASSTHROUGH_TTL_MS;
      try {
        await send(tabId, { type: INPUT_PASSTHROUGH, phase: "begin", id: passthroughId });
      } catch (error) {
        console.debug("[bsk click] overlay passthrough enable failed", error);
      }
      hit = await probe();
    }
    if (retired || deps.signal?.aborted) return cancelled();
    if (pressDeadlineReached()) return notReady(deadlineFailure(), hit);
    if (hit === "covered") return notReady("overlay_still_covered", hit);
    if (covered && hit === "unknown") return notReady("overlay_state_unknown", hit);
    const result = await click(async () => {
      if (pressDeadlineReached()) return notReady(deadlineFailure(), hit);
      const current = await probe();
      if (pressDeadlineReached()) return notReady(deadlineFailure(), current);
      // Unknown probes preserve ordinary-page behavior, but cannot clear a known obstruction.
      if (current === "covered") return notReady("overlay_still_covered", current);
      if (covered && current === "unknown") return notReady("overlay_state_unknown", current);
      return null;
    });
    // The lease can expire while a slow press/release is in flight. Always release
    // the mouse, but do not claim success (or retry) when delivery is uncertain.
    if (expired() && !isRpcError(result)) {
      return rpcError(
        "cdp_failed",
        "input_outcome_unknown",
        "Overlay passthrough expired during click",
        {
          effect_state: "unknown",
          pointer_moved: true,
        },
      );
    }
    return result;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      console.debug("[bsk click] overlay restore failed", error);
    } finally {
      unregisterCleanup?.();
    }
  }
}
