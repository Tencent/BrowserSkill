// Window-tool handlers: `tool.window_resize` resizes the session's
// Agent Window via `chrome.windows.update`.

import type { SessionManager } from "@/session-manager/manager";
import type { RpcError } from "@/transport/types";
import { validateWindowSize } from "./session";
import { isRpcError, lookupSession } from "./shared";

/**
 * Mirror of bsk-protocol `WindowResizeParams` /
 * `WindowResizeResult` (see crates/bsk-protocol/src/tools/window.rs).
 */
export interface WindowResizeParams {
  session_id: string;
  width: number;
  height: number;
}

export interface WindowResizeResult {
  window_id: number;
  width: number;
  height: number;
}

/**
 * Subset of `chrome.windows` we depend on, injectable so unit tests
 * can fake the browser without monkey-patching the global `chrome`.
 */
export interface WindowResizeApi {
  update(windowId: number, updateInfo: { width: number; height: number }): Promise<unknown>;
}

export const chromeWindowResizeApi: WindowResizeApi = {
  async update(windowId, updateInfo) {
    return chrome.windows.update(windowId, updateInfo);
  },
};

/**
 * Handler for `tool.window_resize` (called by the daemon over WS).
 *
 * Resizes the session's Agent Window to the given outer dimensions in
 * CSS pixels. chrome API failures are surfaced as `protocol_error`
 * (§4.5 reserves `cdp_failed` for raw CDP errors).
 */
export async function handleWindowResize(
  manager: SessionManager,
  params: WindowResizeParams,
  api: WindowResizeApi = chromeWindowResizeApi,
): Promise<WindowResizeResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "window_resize");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;

  const sizeOrErr = validateWindowSize(params.width, params.height);
  if (isRpcError(sizeOrErr)) return sizeOrErr;
  if (!sizeOrErr) {
    // validateWindowSize only returns undefined when both are absent,
    // which is valid for session_start but not for an explicit resize.
    return {
      code: "invalid_params",
      message: "window_resize requires width and height",
    };
  }

  try {
    await api.update(ctx.agentWindowId, {
      width: sizeOrErr.width,
      height: sizeOrErr.height,
    });
  } catch (err) {
    return {
      code: "protocol_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  return {
    window_id: ctx.agentWindowId,
    width: sizeOrErr.width,
    height: sizeOrErr.height,
  };
}
