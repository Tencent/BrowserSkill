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
import { fileTransferTriggerDeps } from "./file-transfer-trigger";
import { withInputReady } from "./input-readiness";
import { clickResolvedTarget, type InteractionDeps, resolveActionTarget } from "./interaction";
import { enforceAgentWindow, isRpcError, lookupSession, resolveTargetTab } from "./shared";

let downloadActive = false;

export type { DownloadsApi, NavigationTargetsApi } from "./download-capture";

export interface DownloadDeps extends InteractionDeps {
  /** Human input revokes the trigger; explicit cancellation also stops receipt collection. */
  completionSignal?: AbortSignal;
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

    const timeoutMs = params.timeout_ms ?? 120_000;
    const deadline = Date.now() + timeoutMs;
    let trigger: ReturnType<typeof fileTransferTriggerDeps> | undefined;
    const capture = await captureBrowserDownload({
      cdp: deps.cdp,
      target: address.cdpTarget,
      downloads: deps.downloads ?? chromeDownloadsApi,
      navigationTargets: deps.navigationTargets ?? chromeNavigationTargetsApi,
      browserRelativeDir: params.browser_relative_dir,
      maxByteSize: params.max_byte_size,
      timeoutMs,
      signal: deps.completionSignal ?? deps.signal,
      inputSignal: deps.signal,
      expectedFrameId: address.frameId,
      trigger: (markDispatched, captureSignal) => {
        const signal = deps.signal ? AbortSignal.any([captureSignal, deps.signal]) : captureSignal;
        trigger = fileTransferTriggerDeps(deps, signal);
        const clickDeps = trigger.deps;
        return withInputReady(
          ctx,
          target.tabId,
          // Focus cleanup must remain available after the click trigger is retired.
          { cdp: deps.cdp, signal, deadline, registerCleanup: clickDeps.registerClickCleanup },
          (input) =>
            clickResolvedTarget(ctx, address, {}, clickDeps, () => {
              input.markSent();
              markDispatched();
            }),
        );
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
