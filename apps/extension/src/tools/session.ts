import type { SessionManager } from "@/session-manager/manager";
import type { RpcError } from "@/transport/types";
import { clearRecordingForSession } from "./record";
import { returnBorrowedTab, type TabManagementDeps } from "./tabs";
import type { ChromeTabsApi } from "./shared";

export interface SessionStartParams {
  session_id: string;
  browser_instance_id?: string;
}

export interface SessionStartResult {
  agent_window_id?: number;
}

export interface SessionStopParams {
  session_id: string;
}

export interface SessionStopResult {
  /** Tab ids that were returned to their original (or fallback) window. */
  returned_tab_ids?: number[];
  /** Tab ids whose return path failed; those entries remain borrowed so
   *  shutdown can be retried without closing the Agent Window. */
  return_failures?: Array<{ tab_id: number; code: string; message: string }>;
  /**
   * True when the Agent Window was *released* to the user (instead of being
   * closed) because it still contained user-created tabs after the agent's own
   * tabs were closed. Single-session scope.
   */
  window_released?: boolean;
}

export interface SessionStopDeps {
  cdp?: {
    detachSession(sessionId: string): Promise<void>;
  };
  /**
   * Tab management deps forwarded to `returnBorrowedTab`. Defaults to
   * the production `chrome.tabs` / `chrome.windows` wrappers, but
   * tests can inject fakes so the auto-return path is unit-tested
   * without a real browser.
   */
  tabManagement?: TabManagementDeps;
  /**
   * Read-only Chrome tabs API used to *query* remaining tabs before deciding
   * whether to release the window. Kept separate from `tabManagement.tabs`
   * (a `TabMutationApi` that has no `query`) so the mutation interface stays
   * pure. Tests can inject a fake `ChromeTabsApi` too.
   */
  tabsQuery?: ChromeTabsApi;
}

/**
 * Handler for `tool.session_start` (called by the daemon over WS).
 *
 * Creates the Agent Window and registers a fresh SessionContext.
 */
export async function handleSessionStart(
  manager: SessionManager,
  params: SessionStartParams,
): Promise<SessionStartResult | RpcError> {
  if (!params?.session_id) {
    return {
      code: "invalid_params",
      message: "session.start requires session_id",
    };
  }
  try {
    const ctx = await manager.start(params.session_id);
    return { agent_window_id: ctx.agentWindowId };
  } catch (err) {
    // chrome.windows.create / SessionManager failures are not CDP
    // failures (§4.5 reserves cdp_failed for raw CDP errors). Surface
    // them as protocol_error so the CLI maps to the right exit code
    // (review M4/M5 I5).
    return {
      code: "protocol_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Handler for `tool.session_stop` (called by the daemon over WS).
 *
 * Teardown order is intentional and must not be reordered without
 * thinking through the consequences (review M8.4):
 *
 *   1. Return every borrowed tab to its original (or fallback)
 *      window. We MUST do this before closing the Agent Window —
 *      otherwise the borrowed tab gets removed along with the window.
 *   2. Clear the RefStore so any pending `@e1` resolver bails out
 *      cleanly (review parity with M6).
 *   3. Detach CDP sessions the extension still holds for this
 *      session (no-op if M6/M7 didn't attach to any tab).
 *   4. Close the agent-created tabs and the home tab (design §3.2).
 *   5. If any tab remains — those are user-created tabs — release the
 *      window to the user (dropOnly) instead of closing it, so user
 *      tabs survive. Otherwise close the window as before.
 *
 * Failures in step 1 keep the Agent Window open: a failed borrowed tab
 * may still be there, so closing the window would risk losing user
 * state. The daemon/CLI surface the failure and keep the session
 * retryable.
 */
export async function handleSessionStop(
  manager: SessionManager,
  params: SessionStopParams,
  deps: SessionStopDeps = {},
): Promise<SessionStopResult | RpcError> {
  if (!params?.session_id) {
    return {
      code: "invalid_params",
      message: "session.stop requires session_id",
    };
  }
  const ctx = manager.get(params.session_id);
  if (!ctx) {
    return {
      code: "not_found",
      message: `session ${params.session_id} unknown`,
    };
  }

  // Step 1: auto-return borrowed tabs. Iterate over a snapshot of the
  // ids so deletions during iteration do not break the Map iterator.
  const returnedTabIds: number[] = [];
  const returnFailures: SessionStopResult["return_failures"] = [];
  const borrowedIds = Array.from(ctx.borrowedTabs.keys());
  for (const tabId of borrowedIds) {
    try {
      const tabManagement = {
        ...(deps.tabManagement ?? {}),
        isAgentWindowId:
          deps.tabManagement?.isAgentWindowId ??
          ((windowId: number) => manager.findByWindowId(windowId) !== null),
      };
      const outcome = await returnBorrowedTab(ctx, tabId, tabManagement);
      if (typeof outcome === "object" && "code" in outcome) {
        console.warn(`[bsk session_stop] auto-return failed for tab ${tabId}`, outcome);
        returnFailures?.push({
          tab_id: tabId,
          code: outcome.code,
          message: outcome.message,
        });
      } else {
        returnedTabIds.push(outcome.tabId);
        ctx.borrowedTabs.delete(tabId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[bsk session_stop] auto-return threw for tab ${tabId}: ${message}`);
      returnFailures?.push({
        tab_id: tabId,
        code: "protocol_error",
        message,
      });
    }
  }

  const result: SessionStopResult = {};
  if (returnedTabIds.length > 0) result.returned_tab_ids = returnedTabIds;
  if (returnFailures && returnFailures.length > 0) {
    result.return_failures = returnFailures;
    // A failed return means at least one borrowed user tab may still be
    // inside the Agent Window. Keep the session/window alive so the user
    // can retry `bsk session stop` or explicitly `bsk tab return` after the
    // underlying Chrome issue is resolved.
    return result;
  }

  // Step 2: clear the per-session RefStore (review M6/M7 parity).
  ctx.refStore.clear();

  clearRecordingForSession(params.session_id);

  // Step 3: detach CDP sessions this session opened (no-op if none).
  await deps.cdp?.detachSession(params.session_id);

  // Step 4: close the agent-created tabs and the home tab. `tabsApi` is a
  // TabMutationApi (remove only); `queryApi` is a separate read-only
  // ChromeTabsApi. If neither is injected, we conservatively fall back to
  // closing the window (see Step 5).
  const tabsApi = deps.tabManagement?.tabs;
  const queryApi = deps.tabsQuery;

  if (tabsApi) {
    // 4a: close each agent-created tab that still exists.
    const agentCreatedTabIds = Array.from(ctx.agentCreatedTabs);
    for (const tabId of agentCreatedTabIds) {
      try {
        await tabsApi.remove(tabId);
        ctx.agentCreatedTabs.delete(tabId);
      } catch (err) {
        // Tab may already be gone (closed by the user). Non-fatal.
        console.warn(`[bsk session_stop] failed to close agent tab ${tabId}`, err);
      }
    }

    // 4b: close the home tab by id (not by URL — avoids deleting a user's
    // `about:blank` tab). Non-fatal if it's already gone.
    if (ctx.homeTabId != null) {
      try {
        await tabsApi.remove(ctx.homeTabId);
      } catch (err) {
        console.warn(`[bsk session_stop] failed to close home tab`, err);
      }
    }
  }

  // Step 5: decide whether to release (keep) the window or close it.
  let shouldRelease = false;
  if (queryApi) {
    try {
      const liveWindowTabs = await queryApi.query({ windowId: ctx.agentWindowId });
      // Only genuine *user* tabs count toward keeping the window open.
      // An agent tab that failed to close in Step 4 may still be present
      // here; if we counted it as a reason to release (dropOnly), the
      // window would be kept and that agent tab would leak (issue #57
      // regression). Exclude any id still tracked in agentCreatedTabs.
      const userTabs = liveWindowTabs.filter((t) => {
        if (t.id === undefined) return false;
        if (t.id === ctx.homeTabId) return false;
        return !ctx.agentCreatedTabs.has(t.id);
      });
      const leakedAgentTabs = liveWindowTabs.filter(
        (t) => t.id !== undefined && ctx.agentCreatedTabs.has(t.id),
      );
      if (leakedAgentTabs.length > 0) {
        console.warn(
          `[bsk session_stop] ${leakedAgentTabs.length} agent tab(s) failed to close; forcing window close instead of release`,
          leakedAgentTabs.map((t) => t.id),
        );
      }
      shouldRelease = userTabs.length > 0;
    } catch {
      // Query failed (e.g. window already gone) — conservatively close it.
      shouldRelease = false;
    }
  }

  if (shouldRelease) {
    // Keep the window + its user tabs; only drop the session binding.
    await manager.stop(params.session_id, { dropOnly: true });
    result.window_released = true;
  } else {
    // Window is empty (or we couldn't verify state) — close it.
    await manager.stop(params.session_id);
  }

  return result;
}
