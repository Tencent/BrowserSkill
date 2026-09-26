// Download orchestration: validate session/tab ownership, then delegate one
// browser-global chrome.downloads transaction to download-capture.ts.

import type { SessionManager } from "@/session-manager/manager";
import type { DownloadParams, DownloadResult, RpcError } from "@/transport/types";
import {
  captureBrowserDownload,
  chromeDownloadsApi,
  chromeNavigationTargetsApi,
  type DownloadsApi,
  type NavigationTargetsApi,
} from "./download-capture";
import { downloadTriggerDeps } from "./download-trigger";
import { clickResolvedTarget, type InteractionDeps, resolveActionTarget } from "./interaction";
import { enforceAgentWindow, isRpcError, lookupSession, resolveTargetTab } from "./shared";

let downloadActive = false;

export type { DownloadsApi, NavigationTargetsApi } from "./download-capture";

export interface DownloadDeps extends InteractionDeps {
  downloads?: DownloadsApi;
  navigationTargets?: NavigationTargetsApi;
}

export async function handleDownload(
  manager: SessionManager,
  params: DownloadParams,
  deps: DownloadDeps,
): Promise<DownloadResult | RpcError> {
  if (downloadActive) return { code: "invalid_params", message: "another bsk download is active" };
  downloadActive = true;
  try {
    const ctx = lookupSession(manager, params, "download");
    if (isRpcError(ctx)) return ctx;
    const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
    if (isRpcError(target)) return target;
    const denied = enforceAgentWindow(ctx, target, "download");
    if (denied) return denied;
    if (!params.browser_relative_dir) {
      return { code: "invalid_params", message: "download requires a daemon capability directory" };
    }
    const address = await resolveActionTarget(deps.cdp, ctx, target, params, "download");
    if (isRpcError(address)) return address;

    let trigger: ReturnType<typeof downloadTriggerDeps> | undefined;
    const capture = await captureBrowserDownload({
      cdp: deps.cdp,
      target: address.cdpTarget,
      downloads: deps.downloads ?? chromeDownloadsApi,
      navigationTargets: deps.navigationTargets ?? chromeNavigationTargetsApi,
      browserRelativeDir: params.browser_relative_dir,
      maxByteSize: params.max_byte_size,
      timeoutMs: params.timeout_ms ?? 120_000,
      signal: deps.signal,
      expectedFrameId: address.frameId,
      trigger: (markDispatched, signal) => {
        trigger = downloadTriggerDeps(deps, signal);
        return clickResolvedTarget(ctx, address, {}, trigger.deps, markDispatched);
      },
      cleanupTrigger: (deadline) => trigger?.cleanup(deadline) ?? Promise.resolve(),
    });
    if (isRpcError(capture)) return capture;
    const { click, item } = capture;
    return {
      tab_id: target.tabId,
      used_ref: click.used_ref,
      used_selector: click.used_selector,
      suggested_filename: item.filename.split(/[\\/]/).pop() ?? "download",
      byte_size: item.fileSize >= 0 ? item.fileSize : item.totalBytes,
      mime: item.mime || undefined,
      danger: item.danger,
      browser_path: item.filename,
    };
  } finally {
    downloadActive = false;
  }
}
