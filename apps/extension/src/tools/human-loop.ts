// `tool.request_help` — pause and ask the human to act on a tab.
//
// Brings the target tab to the foreground, resolves `ref` targets to a
// temporary attribute selector via CDP, asks the content script to enter
// help mode (HelpRequestOverlay + hidden ControlOverlay), and blocks
// until the user clicks Continue / Cancel, the wait times out, or the
// daemon cancels the RPC.

import {
  HELP_CANCEL,
  HELP_REQUEST,
  HELP_RESPONSE,
  type HelpCancelMessage,
  type HelpRequestMessage,
  type HelpResponseMessage,
} from "@/lib/help-bridge";
import type { SessionManager } from "@/session-manager/manager";
import type {
  HelpTarget,
  RequestHelpParams,
  RequestHelpResult,
  ResolvedTarget,
  RpcError,
} from "@/transport/types";
import {
  type CdpRunner,
  type ChromeTabsApi,
  chromeTabsApi,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
} from "./shared";
import { lookupSnapshotRef } from "./snapshot-ref";

const DEFAULT_HELP_TIMEOUT_MS = 300_000;
/** Attribute the overlay highlights for resolved `ref` targets. */
const HELP_ATTR = "data-bsk-help";

export interface RequestHelpNotifications {
  create(id: string, options: chrome.notifications.NotificationOptions<true>): Promise<string>;
  clear(id: string): Promise<boolean>;
}

export type TabNavigationUnsubscribe = () => void;

export interface RequestHelpDeps {
  tabsApi: ChromeTabsApi;
  windows: {
    update(windowId: number, info: { focused?: boolean }): Promise<chrome.windows.Window>;
  };
  /** Activate a tab inside its window. */
  activateTab(tabId: number): Promise<void>;
  /** Send the help-request to the tab's content script and await reply. */
  sendToTab(tabId: number, msg: HelpRequestMessage | HelpCancelMessage): Promise<unknown>;
  /**
   * Watch for navigation on `tabId` (full page load or SPA URL change).
   * Invokes `onNavigated` once; returns unsubscribe.
   */
  watchTabNavigation: (tabId: number, onNavigated: () => void) => TabNavigationUnsubscribe;
  cdp?: CdpRunner;
  /** Pass `null` to skip OS notifications (tests). */
  notifications: RequestHelpNotifications | null;
  notificationCopy?: { title: string; body: string };
  signal?: AbortSignal;
}

/** Default navigation watcher: full reload (`loading`) and SPA (`url`). */
export function defaultWatchTabNavigation(
  tabId: number,
  onNavigated: () => void,
): TabNavigationUnsubscribe {
  const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
    if (updatedTabId !== tabId) return;
    if (changeInfo.url !== undefined || changeInfo.status === "loading") {
      chrome.tabs.onUpdated.removeListener(listener);
      onNavigated();
    }
  };
  chrome.tabs.onUpdated.addListener(listener);
  return () => chrome.tabs.onUpdated.removeListener(listener);
}

let defaultDeps: RequestHelpDeps | null = null;
function getDefaultDeps(): RequestHelpDeps {
  if (!defaultDeps) {
    defaultDeps = {
      tabsApi: chromeTabsApi,
      windows: { update: (id, info) => chrome.windows.update(id, info) },
      activateTab: async (tabId) => {
        await chrome.tabs.update(tabId, { active: true });
      },
      sendToTab: (tabId, msg) => chrome.tabs.sendMessage(tabId, msg),
      watchTabNavigation: defaultWatchTabNavigation,
      notifications: {
        create: (id, opts) =>
          new Promise((resolve, reject) =>
            chrome.notifications.create(id, opts, (rid) => {
              const err = chrome.runtime?.lastError;
              if (err) reject(new Error(err.message ?? String(err)));
              else resolve(rid ?? id);
            }),
          ),
        clear: (id) =>
          new Promise((resolve) => chrome.notifications.clear(id, (c) => resolve(c ?? false))),
      },
    };
  }
  return defaultDeps;
}

function makeRequestId(tabId: number): string {
  return `${tabId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Tag a `ref` target's DOM node with `data-bsk-help="<i>"` via CDP so the
 * content overlay can highlight it with a plain attribute selector.
 * Returns the selector on success, or null when the ref can't resolve.
 */
async function tagRefTarget(
  cdp: CdpRunner,
  tabId: number,
  backendNodeId: number,
  index: number,
): Promise<string | null> {
  let objectId: string | undefined;
  try {
    const resolved = await cdp.send<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", {
      backendNodeId,
    });
    objectId = resolved.object?.objectId;
    if (!objectId) return null;
    await cdp.send(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(){ this.setAttribute("${HELP_ATTR}", "${index}"); }`,
    });
    return `[${HELP_ATTR}="${index}"]`;
  } catch {
    return null;
  } finally {
    if (objectId) {
      await cdp.send(tabId, "Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }
}

/** Returns true when `selector` matches a live element in the page. */
async function selectorExists(
  cdp: CdpRunner,
  tabId: number,
  rootNodeId: number,
  selector: string,
): Promise<boolean> {
  try {
    const res = await cdp.send<{ nodeId?: number }>(tabId, "DOM.querySelector", {
      nodeId: rootNodeId,
      selector,
    });
    return typeof res.nodeId === "number" && res.nodeId !== 0;
  } catch {
    return false;
  }
}

/** Remove every help attribute we added (best-effort cleanup). */
async function clearRefTags(cdp: CdpRunner | undefined, tabId: number): Promise<void> {
  if (!cdp) return;
  try {
    const doc = await cdp.send<{ root?: { nodeId?: number } }>(tabId, "DOM.getDocument", {
      depth: 0,
    });
    const rootId = doc.root?.nodeId;
    if (rootId === undefined) return;
    const { nodeIds } = await cdp.send<{ nodeIds: number[] }>(tabId, "DOM.querySelectorAll", {
      nodeId: rootId,
      selector: `[${HELP_ATTR}]`,
    });
    for (const nodeId of nodeIds ?? []) {
      await cdp.send(tabId, "DOM.removeAttribute", { nodeId, name: HELP_ATTR }).catch(() => {});
    }
  } catch {
    // best-effort
  }
}

export async function handleRequestHelp(
  manager: SessionManager,
  params: RequestHelpParams,
  deps: RequestHelpDeps = getDefaultDeps(),
): Promise<RequestHelpResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "request_help");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  if (!params.prompt || typeof params.prompt !== "string") {
    return { code: "invalid_params", message: "request_help requires a prompt" };
  }
  if (deps.signal?.aborted) {
    return { code: "cancelled", message: "request_help aborted" };
  }

  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  const denied = enforceAgentWindow(ctx, target, "request_help");
  if (denied) return denied;
  const tabId = target.tabId;

  // Resolve targets → selectors. `selector` passes through; `ref` is
  // tagged with an attribute via CDP and reported as its attr selector.
  const targets = params.targets ?? [];
  const selectors: string[] = [];
  const resolved: ResolvedTarget[] = [];
  let rootNodeId: number | undefined;
  if (deps.cdp && targets.length > 0) {
    try {
      const doc = await deps.cdp.send<{ root?: { nodeId?: number } }>(tabId, "DOM.getDocument", {
        depth: 0,
      });
      rootNodeId = doc.root?.nodeId;
    } catch {
      rootNodeId = undefined;
    }
  }
  for (let i = 0; i < targets.length; i++) {
    const tgt = targets[i] as HelpTarget;
    if (tgt.selector) {
      selectors.push(tgt.selector);
      let matched: boolean;
      if (deps.cdp) {
        matched =
          rootNodeId !== undefined
            ? await selectorExists(deps.cdp, tabId, rootNodeId, tgt.selector)
            : false;
      } else {
        matched = true;
      }
      resolved.push({ matched, selector: tgt.selector });
    } else if (tgt.ref) {
      const looked = lookupSnapshotRef(ctx, tgt.ref, tabId);
      const backendNodeId = looked?.backendNodeId ?? null;
      let sel: string | null = null;
      if (backendNodeId !== null && deps.cdp) {
        sel = await tagRefTarget(deps.cdp, tabId, backendNodeId, i);
      }
      if (sel) selectors.push(sel);
      resolved.push({ matched: sel !== null, ref: tgt.ref });
    }
  }

  // Bring the tab to the foreground.
  await deps.windows.update(target.windowId, { focused: true }).catch(() => {});
  await deps.activateTab(tabId).catch(() => {});

  const requestId = makeRequestId(tabId);
  const notificationId = `bsk-help:${requestId}`;
  const timeoutMs = params.timeout_ms ?? DEFAULT_HELP_TIMEOUT_MS;

  // OS notification (best-effort).
  if (deps.notifications) {
    const copy = deps.notificationCopy ?? {
      title: "BrowserSkill: Agent needs your help",
      body: params.prompt,
    };
    await deps.notifications
      .create(notificationId, {
        type: "basic",
        iconUrl: "icon/logo.png",
        title: copy.title,
        message: copy.body || params.prompt,
        priority: 2,
      })
      .catch(() => {});
  }

  const cleanup = async () => {
    await clearRefTags(deps.cdp, tabId);
    if (deps.notifications) await deps.notifications.clear(notificationId).catch(() => {});
    // Retract the overlay in case we resolved via timeout / abort.
    await deps
      .sendToTab(tabId, { type: HELP_CANCEL, requestId } satisfies HelpCancelMessage)
      .catch(() => {});
  };

  const request: HelpRequestMessage = {
    type: HELP_REQUEST,
    requestId,
    prompt: params.prompt,
    ...(params.title ? { title: params.title } : {}),
    selectors,
    timeoutMs,
  };

  const resolvedTargets = resolved.length > 0 ? resolved : undefined;

  return new Promise<RequestHelpResult | RpcError>((resolveOuter) => {
    let settled = false;
    const unwatchNav = deps.watchTabNavigation(tabId, () => {
      finish({ outcome: "navigated", tab_id: tabId, resolved_targets: resolvedTargets });
    });

    const finish = (value: RequestHelpResult | RpcError) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      unwatchNav();
      deps.signal?.removeEventListener("abort", onAbort);
      void cleanup();
      resolveOuter(value);
    };

    const onAbort = () => finish({ code: "cancelled", message: "request_help aborted" });

    const timer = setTimeout(() => {
      finish({ outcome: "timed_out", tab_id: tabId, resolved_targets: resolvedTargets });
    }, timeoutMs) as unknown as number;

    if (deps.signal) {
      if (deps.signal.aborted) {
        onAbort();
        return;
      }
      deps.signal.addEventListener("abort", onAbort, { once: true });
    }

    deps
      .sendToTab(tabId, request)
      .then((reply) => {
        const res = reply as HelpResponseMessage | undefined;
        if (
          !res ||
          res.type !== HELP_RESPONSE ||
          (res.outcome !== "continued" && res.outcome !== "cancelled")
        ) {
          finish({
            code: "protocol_error",
            message: `invalid help response from tab ${tabId}`,
          });
          return;
        }
        finish({
          outcome: res.outcome,
          ...(res.note ? { note: res.note } : {}),
          tab_id: tabId,
          resolved_targets: resolvedTargets,
        });
      })
      .catch((err) => {
        finish({
          code: "protocol_error",
          message: `failed to show help overlay on tab ${tabId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      });
  });
}
