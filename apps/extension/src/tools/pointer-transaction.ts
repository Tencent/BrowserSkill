import type { CdpTarget } from "@/browser-driver/frame-graph";
import type { InteractionDeps } from "./interaction";
import { type CdpRunner, sendToCdpTarget } from "./shared";
import { waitBounded } from "./transfer-transaction";

/** A retired pointer transaction must never resume input when a CDP reply arrives late. */
export function pointerTransactionDeps(
  deps: InteractionDeps,
  signal?: AbortSignal,
  cancelDragging = false,
) {
  let retired = false;
  let release: { tabId: number; params: object; attachmentId?: string } | undefined;
  let releasing = false;
  let movedWhilePressed = false;
  const clickCleanups = new Set<() => Promise<void>>();
  const check = () => {
    if (retired || signal?.aborted)
      throw new DOMException("pointer transaction aborted", "AbortError");
  };
  const send = async <T>(target: CdpTarget, method: string, params?: object): Promise<T> => {
    check();
    const mouse = params as { type?: string } | undefined;
    const onDispatch = () => {
      check();
      if (
        release?.attachmentId !== undefined &&
        deps.cdp.getAttachmentId?.(target.tabId) !== release.attachmentId
      )
        throw new Error("pointer attachment changed");
      if (method === "Input.dispatchMouseEvent") {
        if (mouse?.type === "mousePressed") {
          release = {
            tabId: target.tabId,
            params: { ...params, type: "mouseReleased", buttons: 0 },
            attachmentId: deps.cdp.getAttachmentId?.(target.tabId),
          };
        } else if (mouse?.type === "mouseMoved" && release) {
          release.params = {
            ...release.params,
            x: (params as { x: number }).x,
            y: (params as { y: number }).y,
          };
          movedWhilePressed = true;
        } else if (mouse?.type === "mouseReleased") {
          releasing = true;
        }
      }
    };
    const result = deps.cdp.sendGuarded
      ? await deps.cdp.sendGuarded<T>(target, method, params, {
          signal,
          attachmentId: release?.attachmentId,
          onDispatch,
        })
      : await (() => {
          onDispatch();
          return sendToCdpTarget<T>(deps.cdp, target, method, params);
        })();
    if (method === "Input.dispatchMouseEvent" && mouse?.type === "mouseReleased") {
      release = undefined;
      releasing = false;
    }
    return result;
  };
  const cdp: CdpRunner = {
    send: (tabId, method, params) => send({ tabId }, method, params),
    sendToTarget: send,
    trackSessionTab: deps.cdp.trackSessionTab?.bind(deps.cdp),
    verifyPointerTarget: deps.cdp.verifyPointerTarget?.bind(deps.cdp),
    dialogCursor: deps.cdp.dialogCursor?.bind(deps.cdp),
    dialogsSince: deps.cdp.dialogsSince?.bind(deps.cdp),
    getAttachmentId: deps.cdp.getAttachmentId?.bind(deps.cdp),
    getFrameGraph: deps.cdp.getFrameGraph
      ? (tabId) => {
          check();
          return deps.cdp.getFrameGraph!(tabId);
        }
      : undefined,
  };
  const cleanupInput = async (deadline: number): Promise<void> => {
    if (!release) return;
    const pending = release;
    release = undefined;
    const ownsAttachment = () =>
      pending.attachmentId === undefined ||
      deps.cdp.getAttachmentId?.(pending.tabId) === pending.attachmentId;
    const detach = () => {
      if (!ownsAttachment()) return Promise.resolve();
      return pending.attachmentId === undefined
        ? deps.cdp.detach?.(pending.tabId)
        : deps.cdp.detach?.(pending.tabId, pending.attachmentId);
    };
    if (!ownsAttachment()) return;
    try {
      // Native HTML drag state also belongs to this gesture. Cancel it before releasing;
      // a plain release could otherwise commit the pending drop after cancellation.
      if (
        cancelDragging &&
        movedWhilePressed &&
        (pending.params as { button?: string }).button === "left" &&
        !releasing
      ) {
        const cancel = deps.cdp.sendGuarded
          ? deps.cdp.sendGuarded(
              { tabId: pending.tabId },
              "Input.cancelDragging",
              {},
              { attachmentId: pending.attachmentId },
            )
          : deps.cdp.send(pending.tabId, "Input.cancelDragging", {});
        await waitBounded(
          cancel,
          Math.min(deadline, Date.now() + 300),
          undefined,
          "drag cancellation timed out",
        );
      }
      if (!ownsAttachment()) return;
      // Never replay an in-flight release or send cleanup on a new attachment.
      const cleanup = releasing
        ? detach()
        : deps.cdp.sendGuarded
          ? deps.cdp.sendGuarded(
              { tabId: pending.tabId },
              "Input.dispatchMouseEvent",
              pending.params,
              {
                attachmentId: pending.attachmentId,
              },
            )
          : deps.cdp.send(pending.tabId, "Input.dispatchMouseEvent", pending.params);
      if (!cleanup) throw new Error("pointer input cleanup unavailable");
      await waitBounded(cleanup, deadline, undefined, "pointer input cleanup timed out");
    } catch (error) {
      // Replacement may happen while release is pending. Recheck ownership,
      // and have the driver enforce it again when executing the fallback.
      void detach()?.catch(() => {});
      throw error;
    }
  };
  return {
    deps: {
      ...deps,
      cdp,
      signal,
      registerClickCleanup: (cleanup: () => Promise<void>) => {
        clickCleanups.add(cleanup);
        return () => {
          clickCleanups.delete(cleanup);
        };
      },
      onInputSent: deps.onInputSent
        ? (tabId: number) => {
            check();
            deps.onInputSent!(tabId);
          }
        : undefined,
    },
    async cleanup(deadline: number): Promise<void> {
      retired = true;
      const cleanups = [cleanupInput(deadline), ...[...clickCleanups].map((cleanup) => cleanup())];
      clickCleanups.clear();
      const results = await waitBounded(
        Promise.allSettled(cleanups),
        deadline,
        undefined,
        "pointer transaction cleanup timed out",
      );
      for (const result of results) if (result.status === "rejected") throw result.reason;
    },
  };
}
