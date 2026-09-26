import type { CdpTarget } from "@/browser-driver/frame-graph";
import type { InteractionDeps } from "./interaction";
import { type CdpRunner, sendToCdpTarget } from "./shared";
import { waitBounded } from "./transfer-transaction";

/** A retired download click must never resume input when a CDP reply arrives late. */
export function downloadTriggerDeps(deps: InteractionDeps, signal: AbortSignal) {
  let retired = false;
  let release: { tabId: number; params: object; attachmentId?: string } | undefined;
  let releasing = false;
  const check = () => {
    if (retired || signal.aborted) throw new DOMException("download trigger aborted", "AbortError");
  };
  const send = async <T>(target: CdpTarget, method: string, params?: object): Promise<T> => {
    check();
    const mouse = params as { type?: string } | undefined;
    if (method === "Input.dispatchMouseEvent") {
      if (mouse?.type === "mousePressed") {
        release = {
          tabId: target.tabId,
          params: { ...params, type: "mouseReleased" },
          attachmentId: deps.cdp.getAttachmentId?.(target.tabId),
        };
      } else if (mouse?.type === "mouseReleased") {
        releasing = true;
      }
    }
    const result = await sendToCdpTarget<T>(deps.cdp, target, method, params);
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
  return {
    deps: {
      ...deps,
      cdp,
      signal,
      onInputSent: deps.onInputSent
        ? (tabId: number) => {
            check();
            deps.onInputSent!(tabId);
          }
        : undefined,
    },
    async cleanup(deadline: number): Promise<void> {
      retired = true;
      if (!release) return;
      const pending = release;
      release = undefined;
      if (
        pending.attachmentId !== undefined &&
        deps.cdp.getAttachmentId?.(pending.tabId) !== pending.attachmentId
      )
        return;
      try {
        // A release already in flight must not be replayed. Detaching fences
        // that debugger connection; otherwise release the button once while
        // this download still owns the global gate.
        const cleanup = releasing
          ? deps.cdp.detach?.(pending.tabId)
          : deps.cdp.send(pending.tabId, "Input.dispatchMouseEvent", pending.params);
        if (!cleanup) throw new Error("download input cleanup unavailable");
        await waitBounded(cleanup, deadline, undefined, "download input cleanup timed out");
      } catch (error) {
        // ChromiumCdp invalidates attachment identity synchronously and fences
        // a pending detach. Do not wait beyond the shared cleanup budget.
        void deps.cdp.detach?.(pending.tabId).catch(() => {});
        throw error;
      }
    },
  };
}
