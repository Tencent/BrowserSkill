import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { SessionManager } from "@/session-manager/manager";
import type { RpcError, ScrollToParams, ScrollToResult } from "@/transport/types";
import { attachDialogs, markDialogCursor } from "./dialogs";
import { resolveNodeGeometry } from "./frame-geometry";
import { resolveBackendNode } from "./interaction";
import {
  type CdpRunner,
  type ChromeTabsApi,
  chromeTabsApi,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
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
  if (deps.signal?.aborted) return { code: "cancelled", message: "scroll-to aborted" };
  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  const denied = enforceAgentWindow(ctx, target, "scroll-to");
  if (denied) return denied;
  const dialogCursor = markDialogCursor(deps.cdp, target.tabId);
  const node = await resolveBackendNode(deps.cdp, ctx, target, params, "scroll-to");
  if (isRpcError(node)) return node;
  if (deps.signal?.aborted) return { code: "cancelled", message: "scroll-to aborted" };

  deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
  const geometry = await resolveNodeGeometry(
    deps.cdp,
    target.tabId,
    {
      target: node.cdpTarget,
      backendNodeId: node.backendNodeId,
      ...(node.frameId ? { frameId: node.frameId } : {}),
    },
    { scrollIntoView: true },
  );
  if (isRpcError(geometry)) return geometry;

  return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
    tab_id: target.tabId,
    used_ref: node.usedRef,
    used_selector: node.usedSelector,
    x: geometry.topBounds.x,
    y: geometry.topBounds.y,
    width: geometry.topBounds.width,
    height: geometry.topBounds.height,
  });
}
