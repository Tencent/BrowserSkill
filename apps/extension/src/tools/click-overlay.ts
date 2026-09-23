import {
  INPUT_PASSTHROUGH,
  type InputPassthroughSendToTab,
  sendInputPassthrough,
} from "@/lib/input-passthrough-bridge";
import { OVERLAY_HOST_SELECTOR } from "@/lib/overlay-bridge";
import type { RpcError } from "@/transport/types";
import { rpcError } from "./errors";
import type { CdpRunner } from "./shared";

export interface ClickOverlayDeps {
  cdp: CdpRunner;
  signal?: AbortSignal;
  /** Acquire/release only this operation's automation bypass reference. */
  bypassOverlay?: (tabId: number, enabled: boolean) => Promise<void>;
  sendInputPassthrough?: InputPassthroughSendToTab;
}

type OverlayHit = "absent" | "clear" | "covered" | "unknown";

/** Prepare before mouseMoved, then check again before every press. */
export async function withClickOverlay<T>(
  tabId: number,
  point: { x: number; y: number },
  deps: ClickOverlayDeps,
  click: (beforePress: () => Promise<RpcError | null>) => Promise<T>,
  alwaysBypass = false,
): Promise<T | RpcError> {
  const send = deps.sendInputPassthrough ?? sendInputPassthrough;
  let bypass = false;
  let passthroughId: string | undefined;
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
    if (deps.signal?.aborted) return cancelled();
    let hit = await probe();
    let covered = hit === "covered";
    if (deps.signal?.aborted) return cancelled();
    if ((alwaysBypass || covered) && deps.bypassOverlay) {
      try {
        await deps.bypassOverlay(tabId, true);
        bypass = true;
      } catch (error) {
        console.debug("[bsk click] overlay bypass enable failed", error);
      }
      // Enabling bypass can also render newly arrived control UI.
      hit = await probe();
      covered ||= hit === "covered";
    }
    if (deps.signal?.aborted) return cancelled();
    if (hit === "covered") {
      passthroughId = crypto.randomUUID();
      try {
        await send(tabId, { type: INPUT_PASSTHROUGH, phase: "begin", id: passthroughId });
      } catch (error) {
        console.debug("[bsk click] overlay passthrough enable failed", error);
      }
      hit = await probe();
    }
    if (deps.signal?.aborted) return cancelled();
    if (hit === "covered" || (covered && hit === "unknown")) return notReady();
    return await click(async () => {
      const current = await probe();
      // Unknown probes preserve ordinary-page behavior, but cannot clear a known obstruction.
      return current === "covered" || (covered && current === "unknown") ? notReady() : null;
    });
  } finally {
    // Release our lease even if begin's acknowledgement was lost.
    if (passthroughId) {
      try {
        await send(tabId, { type: INPUT_PASSTHROUGH, phase: "end", id: passthroughId });
      } catch (error) {
        console.debug("[bsk click] overlay passthrough restore failed", error);
      }
    }
    if (bypass) {
      try {
        await deps.bypassOverlay!(tabId, false);
      } catch (error) {
        console.debug("[bsk click] overlay bypass restore failed", error);
      }
    }
  }
}
