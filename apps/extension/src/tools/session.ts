import type { SessionManager } from "@/session-manager/manager";
import type { RpcError } from "@/transport/types";
import { returnBorrowedTab, type TabManagementDeps } from "./tabs";

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
 *   4. Close the Agent Window. SessionManager.stop() removes the
 *      Chrome window and forgets the context.
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

  // Step 3: detach CDP sessions this session opened (no-op if none).
  await deps.cdp?.detachSession(params.session_id);

  // Step 4: close the Agent Window and drop the context.
  await manager.stop(params.session_id);

  return result;
}
