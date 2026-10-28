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
  const notReady = () =>
    rpcError(
      "cdp_failed",
      "input_not_ready",
      "Could not clear the extension overlay from the click point",
      {
        effect_state: "none",
        pointer_moved: false,
      },
    );
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
        });
        await bypassAcquisition;
      } catch (error) {
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
    if (pressDeadlineReached() || hit === "covered" || (covered && hit === "unknown"))
      return notReady();
    const result = await click(async () => {
      if (pressDeadlineReached()) return notReady();
      const current = await probe();
      // Unknown probes preserve ordinary-page behavior, but cannot clear a known obstruction.
      return pressDeadlineReached() || current === "covered" || (covered && current === "unknown")
        ? notReady()
        : null;
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
