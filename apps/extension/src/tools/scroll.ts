import type { CdpDispatchGuard } from "@/browser-driver/chromium-cdp";
import {
  type FrameDocumentGraph,
  type FrameDocumentHandle,
  type FrameNodeHandle,
  toRootFrameHandle,
} from "@/browser-driver/frame-handles";
import type { SessionManager } from "@/session-manager/manager";
import type { RpcError, ScrollToParams, ScrollToResult } from "@/transport/types";
import { attachDialogs, markDialogCursor } from "./dialogs";
import { cdpError, rpcError } from "./errors";
import { scrollElementAndFramesIntoView } from "./frame-geometry";
import { withInputReady } from "./input-readiness";
import { resolveBackendNode } from "./interaction";
import { scrollVisibleBounds } from "./scroll-visibility";
import {
  type CdpRunner,
  type ChromeTabsApi,
  delegateCdpRunner,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
  sendToFrameHandle,
} from "./shared";

export interface ScrollToDeps {
  cdp: CdpRunner;
  tabsApi: ChromeTabsApi;
  signal?: AbortSignal;
}

export async function handleScrollTo(
  manager: SessionManager,
  params: ScrollToParams,
  deps: ScrollToDeps,
): Promise<ScrollToResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "scroll-to");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  const timeout = params.timeout_ms ?? 30_000;
  if (!Number.isInteger(timeout) || timeout <= 0) {
    return { code: "invalid_params", message: "timeout_ms must be a positive integer" };
  }
  const deadline = Date.now() + timeout;
  const checkActive = () => {
    if (deps.signal?.aborted) throw new DOMException("scroll-to aborted", "AbortError");
    if (Date.now() >= deadline) throw new DOMException("scroll-to timed out", "TimeoutError");
  };
  const objectGroup = `bsk-scroll-${crypto.randomUUID()}`;
  const objectHandles = new Map<string, FrameDocumentHandle>();
  const sendFrame = async <T>(
    handle: FrameDocumentHandle | FrameNodeHandle,
    method: string,
    args?: object,
    guard?: CdpDispatchGuard,
  ): Promise<T> => {
    checkActive();
    // Also own objects allocated by the shared scroll fallback. Record the
    // handle before awaiting so cancellation cannot skip their cleanup.
    if (method === "DOM.resolveNode") {
      objectHandles.set(`${handle.tabId}:${handle.frameId}:${handle.loaderId}`, {
        tabId: handle.tabId,
        frameId: handle.frameId,
        loaderId: handle.loaderId,
        ...(handle.documentElementBackendNodeId !== undefined
          ? { documentElementBackendNodeId: handle.documentElementBackendNodeId }
          : {}),
      });
    }
    const result = await sendToFrameHandle<T>(
      deps.cdp,
      handle,
      method,
      method === "DOM.resolveNode" ? { ...args, objectGroup } : args,
      guard,
    );
    checkActive();
    return result;
  };
  let graph: Promise<FrameDocumentGraph> | undefined;
  const cdp: CdpRunner = delegateCdpRunner(deps.cdp, {
    resourceCleanup: deps.cdp.resourceCleanup ?? deps.cdp,
    send: <T>(tabId: number, method: string, args?: object, sig?: AbortSignal) =>
      sendFrame<T>(toRootFrameHandle(tabId), method, args, sig ? { signal: sig } : undefined),
    sendToFrame: sendFrame,
    ensureAttachedToUrl: async (tabId, expectedUrl) => {
      checkActive();
      await deps.cdp.ensureAttachedToUrl(tabId, expectedUrl);
      checkActive();
    },
    getMainFrameHandle: async (tabId, sig) => {
      checkActive();
      const result = await deps.cdp.getMainFrameHandle(tabId, sig);
      checkActive();
      return result;
    },
    getFrameDocuments: async (tabId, sig) => {
      checkActive();
      graph ??= deps.cdp.getFrameDocuments(tabId, sig);
      const result = await graph;
      checkActive();
      return result;
    },
  });
  try {
    checkActive();
    const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
    checkActive();
    if (isRpcError(target)) return target;
    const denied = enforceAgentWindow(ctx, target, "scroll-to");
    if (denied) return denied;
    const dialogCursor = markDialogCursor(deps.cdp, target.tabId);
    const node = await resolveBackendNode(cdp, ctx, target, params, "scroll-to");
    checkActive();
    if (isRpcError(node)) return node;
    deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
    return await withInputReady(ctx, target.tabId, { ...deps, deadline }, async () => {
      const scrollError = await scrollElementAndFramesIntoView(cdp, target.tabId, node.handle);
      checkActive();
      if (scrollError) return scrollError;
      const bounds = await scrollVisibleBounds(cdp, target.tabId, node.handle, deadline);
      checkActive();
      if (!bounds)
        return rpcError(
          "permission_denied",
          "element_not_visible",
          "scroll-to target has no visible area",
        );
      return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
        tab_id: target.tabId,
        used_ref: node.usedRef,
        used_selector: node.usedSelector,
        ...bounds,
      });
    });
  } catch (error) {
    if (deps.signal?.aborted) return { code: "cancelled", message: "scroll-to aborted" };
    if (Date.now() >= deadline) return { code: "timeout", message: "scroll-to timed out" };
    return cdpError(error);
  } finally {
    // Cleanup bypasses the cancellation guard and cannot replace the result.
    const cleanup = deps.cdp.resourceCleanup ?? deps.cdp;
    for (const handle of objectHandles.values()) {
      await sendToFrameHandle(
        cleanup,
        handle,
        "Runtime.releaseObjectGroup",
        { objectGroup },
        { allowReattach: false },
      ).catch(() => {});
    }
  }
}
