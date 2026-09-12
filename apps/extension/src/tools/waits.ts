// `tool.wait_for_navigation` — subscribe to CDP `Page.lifecycleEvent`
// on the target tab and wait until the requested phase fires. Design
// §4 / §7, plan M9.2.
//
// Sandbox follows the same rules as the navigate / interaction tools:
// `resolveTargetTab` + `enforceAgentWindow`. Borrowed tabs already
// inside the Agent Window are allowed; user-window tabs are refused
// with `permission_denied`.
//
// Implementation: reuses the M7 helpers `ensureCdpReady` +
// `waitForLifecyclePassive` (readyState probe + event listener) from
// navigation.ts. Reads the main frame via `Page.getFrameTree` so
// subframe lifecycle events cannot satisfy a page-level wait.

import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { SessionManager } from "@/session-manager/manager";
import type {
  RpcError,
  WaitForNavigationParams,
  WaitForNavigationResult,
  WaitUntil,
} from "@/transport/types";
import { attachDialogs, markDialogCursor } from "./dialogs";
import { cdpLifecycleName, ensureCdpReady, waitForLifecyclePassive } from "./navigation";
import {
  type CdpRunner,
  type ChromeTabsApi,
  chromeTabsApi,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
} from "./shared";

export interface WaitForNavigationDeps {
  cdp: CdpRunner;
  tabsApi: ChromeTabsApi;
  /** Abort hook (full chain wired in M10.2). */
  signal?: AbortSignal;
  defaultTimeoutMs?: number;
}

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

interface FrameTreeReply {
  frameTree?: {
    frame?: {
      id?: string;
    };
  };
}

let defaultDeps: { cdp: ChromiumCdp; tabsApi: ChromeTabsApi } | null = null;
function getDefaultDeps(): { cdp: ChromiumCdp; tabsApi: ChromeTabsApi } {
  if (!defaultDeps) {
    defaultDeps = { cdp: new ChromiumCdp(), tabsApi: chromeTabsApi };
  }
  return defaultDeps;
}

export async function handleWaitForNavigation(
  manager: SessionManager,
  params: WaitForNavigationParams,
  deps: WaitForNavigationDeps = getDefaultDeps(),
): Promise<WaitForNavigationResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "wait_for_navigation");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  if (deps.signal?.aborted) {
    return { code: "cancelled", message: "wait_for_navigation aborted" };
  }
  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  const denied = enforceAgentWindow(ctx, target, "wait_for_navigation");
  if (denied) return denied;
  const dialogCursor = markDialogCursor(deps.cdp, target.tabId);

  const waitUntil: WaitUntil = params.wait_until ?? "load";
  const timeoutMs = params.timeout_ms ?? deps.defaultTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const expected = cdpLifecycleName(waitUntil);

  try {
    deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
    await ensureCdpReady(deps.cdp, target.tabId);
    if (deps.signal?.aborted) {
      return { code: "cancelled", message: "wait_for_navigation aborted" };
    }
    const frameTree = await deps.cdp.send<FrameTreeReply>(target.tabId, "Page.getFrameTree", {});
    const mainFrameId = frameTree.frameTree?.frame?.id;
    if (!mainFrameId) {
      return { code: "cdp_failed", message: "Page.getFrameTree did not return a main frame id" };
    }
    if (deps.signal?.aborted) {
      return { code: "cancelled", message: "wait_for_navigation aborted" };
    }
    const outcome = await waitForLifecyclePassive(
      deps.cdp,
      target.tabId,
      mainFrameId,
      expected,
      timeoutMs,
      deps.signal,
    );
    if (outcome.reached === "cancelled") {
      return { code: "cancelled", message: "wait_for_navigation aborted" };
    }
    if (outcome.reached === "match") {
      return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
        tab_id: target.tabId,
        reached: waitUntil,
      });
    }
    return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
      tab_id: target.tabId,
      reached: "timeout",
      error_text: `timed out waiting for lifecycle "${expected}" after ${timeoutMs}ms${
        outcome.lastLifecycle ? `; last observed "${outcome.lastLifecycle}"` : ""
      }`,
    });
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export const __testing__ = {
  DEFAULT_WAIT_TIMEOUT_MS,
};
