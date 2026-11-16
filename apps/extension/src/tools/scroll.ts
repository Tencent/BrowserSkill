import type { CdpDispatchGuard } from "@/browser-driver/chromium-cdp";
import {
  type CdpTarget,
  cdpTargetKey,
  type FrameDocumentHandle,
  type FrameNodeHandle,
} from "@/browser-driver/frame-graph";
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
  sendToCdpTarget,
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
  const objectTargets = new Map<string, CdpTarget>();
  const objectHandles = new Map<string, FrameDocumentHandle>();
  const send = async <T>(target: CdpTarget, method: string, args?: object): Promise<T> => {
    checkActive();
    // Also own objects allocated by the shared scroll fallback. Record the
    // target before awaiting so cancellation cannot skip their cleanup.
    if (method === "DOM.resolveNode") objectTargets.set(cdpTargetKey(target), target);
    const result = await sendToCdpTarget<T>(
      deps.cdp,
      target,
      method,
      method === "DOM.resolveNode" ? { ...args, objectGroup } : args,
    );
    checkActive();
    return result;
  };
  const sendFrame = async <T>(
    handle: FrameDocumentHandle | FrameNodeHandle,
    method: string,
    args?: object,
    guard?: CdpDispatchGuard,
  ): Promise<T> => {
    checkActive();
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
  let graph: ReturnType<NonNullable<CdpRunner["getFrameGraph"]>> | undefined;
  const cdp: CdpRunner = delegateCdpRunner(deps.cdp, {
    send: (tabId, method, args) => send({ tabId }, method, args),
    sendToTarget: send,
    sendToFrame: sendFrame,
    ...(deps.cdp.ensureAttachedToUrl
      ? {
          ensureAttachedToUrl: async (tabId, expectedUrl) => {
            checkActive();
            await deps.cdp.ensureAttachedToUrl!(tabId, expectedUrl);
            checkActive();
          },
        }
      : {}),
    ...(deps.cdp.getMainFrameHandle
      ? {
          getMainFrameHandle: async (tabId, sig) => {
            checkActive();
            const result = await deps.cdp.getMainFrameHandle!(tabId, sig);
            checkActive();
            return result;
          },
        }
      : {}),
    ...(deps.cdp.getFrameGraph
      ? {
          getFrameGraph: async (tabId) => {
            checkActive();
            graph ??= deps.cdp.getFrameGraph!(tabId);
            const result = await graph;
            checkActive();
            return result;
          },
        }
      : {}),
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
    for (const target of objectTargets.values()) {
      await sendToCdpTarget(cleanup, target, "Runtime.releaseObjectGroup", { objectGroup }).catch(
        () => {},
      );
    }
    for (const handle of objectHandles.values()) {
      await sendToFrameHandle(cleanup, handle, "Runtime.releaseObjectGroup", { objectGroup }).catch(
        () => {},
      );
    }
  }
}
