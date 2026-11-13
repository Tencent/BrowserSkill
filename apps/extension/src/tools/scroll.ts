import { type CdpDispatchGuard, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { type CdpTarget, cdpTargetKey } from "@/browser-driver/frame-graph";
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
  chromeTabsApi,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
  sendToCdpTarget,
} from "./shared";

export interface ScrollToDeps {
  cdp: CdpRunner;
  tabsApi: ChromeTabsApi;
  signal?: AbortSignal;
}

let defaultDeps: { cdp: ChromiumCdp; tabsApi: ChromeTabsApi } | null = null;
function getDefaultDeps(): { cdp: ChromiumCdp; tabsApi: ChromeTabsApi } {
  if (!defaultDeps) defaultDeps = { cdp: new ChromiumCdp(), tabsApi: chromeTabsApi };
  return defaultDeps;
}

export async function handleScrollTo(
  manager: SessionManager,
  params: ScrollToParams,
  deps: ScrollToDeps = getDefaultDeps(),
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
  let graph: ReturnType<NonNullable<CdpRunner["getFrameGraph"]>> | undefined;
  const cdp: CdpRunner = {
    send: (tabId, method, args) => send({ tabId }, method, args),
    sendToTarget: send,
    sendGuarded: deps.cdp.sendGuarded
      ? async <T>(
          target: CdpTarget,
          method: string,
          args: object | undefined,
          guard: CdpDispatchGuard,
        ) => {
          checkActive();
          if (method === "DOM.resolveNode") objectTargets.set(cdpTargetKey(target), target);
          const combinedSignal =
            guard.signal && deps.signal
              ? AbortSignal.any([guard.signal, deps.signal])
              : (guard.signal ?? deps.signal);
          const result = await deps.cdp.sendGuarded!<T>(
            target,
            method,
            method === "DOM.resolveNode" ? { ...args, objectGroup } : args,
            {
              ...guard,
              signal: combinedSignal,
              onDispatch: () => {
                checkActive();
                guard.onDispatch?.();
              },
            },
          );
          checkActive();
          return result;
        }
      : undefined,
    getAttachmentId: deps.cdp.getAttachmentId?.bind(deps.cdp),
    trackSessionTab: deps.cdp.trackSessionTab?.bind(deps.cdp),
    resolveTarget: deps.cdp.resolveTarget?.bind(deps.cdp),
    reattachIfSoftDetached: deps.cdp.reattachIfSoftDetached
      ? async (tabId) => {
          checkActive();
          await deps.cdp.reattachIfSoftDetached!(tabId);
          checkActive();
        }
      : undefined,
    reconcileSoftDetachedFrames: deps.cdp.reconcileSoftDetachedFrames
      ? async (tabId) => {
          checkActive();
          await deps.cdp.reconcileSoftDetachedFrames!(tabId);
          checkActive();
        }
      : undefined,
    getFrameGraph: deps.cdp.getFrameGraph
      ? async (tabId, signal, options) => {
          checkActive();
          const combinedSignal =
            signal && deps.signal
              ? AbortSignal.any([signal, deps.signal])
              : (signal ?? deps.signal);
          const promise = graph ?? deps.cdp.getFrameGraph!(tabId, combinedSignal, options);
          if (options?.includeOwners !== false) graph ??= promise;
          const result = await promise;
          checkActive();
          return result;
        }
      : undefined,
  };
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
      const scrollError = await scrollElementAndFramesIntoView(
        cdp,
        target.tabId,
        node.cdpTarget,
        node.backendNodeId,
        node.frameId,
      );
      checkActive();
      if (scrollError) return scrollError;
      const bounds = await scrollVisibleBounds(
        cdp,
        target.tabId,
        {
          target: node.cdpTarget,
          backendNodeId: node.backendNodeId,
          frameId: node.frameId,
        },
        deadline,
      );
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
    for (const target of objectTargets.values()) {
      await sendToCdpTarget(deps.cdp, target, "Runtime.releaseObjectGroup", { objectGroup }).catch(
        () => {},
      );
    }
  }
}
