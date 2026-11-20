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
import { rpcError } from "./errors";
import { withInputReady } from "./input-readiness";
import { clickResolvedTarget, type InteractionDeps, resolveActionTarget } from "./interaction";
import { pointerTransactionDeps } from "./pointer-transaction";
import { enforceAgentWindow, isRpcError, lookupSession, resolveTargetTab } from "./shared";

export type { DownloadsApi, NavigationTargetsApi } from "./download-capture";

/**
 * Instance-scoped concurrency gate for `chrome.downloads` attribution.
 * `ToolDispatcher` owns one gate per browser runtime; direct callers/tests
 * without an explicit gate derive an isolated gate per `DownloadsApi` instance.
 */
export class DownloadConcurrencyGate {
  private active = false;

  isBusy(): boolean {
    return this.active;
  }

  tryAcquire(): (() => void) | null {
    if (this.active) return null;
    this.active = true;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active = false;
      }
    };
  }
}

const gatesByDownloadsApi = new WeakMap<DownloadsApi, DownloadConcurrencyGate>();

function resolveDownloadGate(
  downloads: DownloadsApi,
  explicitGate?: DownloadConcurrencyGate,
): DownloadConcurrencyGate {
  if (explicitGate) return explicitGate;
  let gate = gatesByDownloadsApi.get(downloads);
  if (!gate) {
    gate = new DownloadConcurrencyGate();
    gatesByDownloadsApi.set(downloads, gate);
  }
  return gate;
}

export interface DownloadDeps extends InteractionDeps {
  /** Human input revokes the trigger; explicit cancellation also stops receipt collection. */
  completionSignal?: AbortSignal;
  downloads?: DownloadsApi;
  navigationTargets?: NavigationTargetsApi;
  downloadGate?: DownloadConcurrencyGate;
}

export async function handleDownload(
  manager: SessionManager,
  params: DownloadParams,
  deps: DownloadDeps,
): Promise<DownloadResult | RpcError> {
  const ctx = lookupSession(manager, params, "download");
  if (isRpcError(ctx)) return ctx;
  if (!params.browser_relative_dir) {
    return { code: "invalid_params", message: "download requires a daemon capability directory" };
  }
  const downloads = deps.downloads ?? chromeDownloadsApi;
  const releaseGate = resolveDownloadGate(downloads, deps.downloadGate).tryAcquire();
  if (!releaseGate) {
    return rpcError("timeout", "session_busy", "another bsk download is active", {
      effect_state: "none",
      dispatched: false,
      phase: "before_trigger",
    });
  }
  try {
    const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
    if (isRpcError(target)) return target;
    const denied = enforceAgentWindow(ctx, target, "download");
    if (denied) return denied;
    const address = await resolveActionTarget(deps.cdp, ctx, target, params, "download");
    if (isRpcError(address)) return address;

    const timeoutMs = params.timeout_ms ?? 120_000;
    const deadline = Date.now() + timeoutMs;
    let trigger: ReturnType<typeof pointerTransactionDeps> | undefined;
    const capture = await captureBrowserDownload({
      cdp: deps.cdp,
      handle: address.handle,
      downloads,
      navigationTargets: deps.navigationTargets ?? chromeNavigationTargetsApi,
      browserRelativeDir: params.browser_relative_dir,
      maxByteSize: params.max_byte_size,
      timeoutMs,
      signal: deps.completionSignal ?? deps.signal,
      inputSignal: deps.signal,
      expectedFrameId: address.frameId,
      trigger: (markDispatched, captureSignal) => {
        const signal = deps.signal ? AbortSignal.any([captureSignal, deps.signal]) : captureSignal;
        trigger = pointerTransactionDeps(deps, signal);
        const clickDeps = trigger.deps;
        return withInputReady(
          ctx,
          target.tabId,
          // Focus cleanup must remain available after the click trigger is retired.
          {
            cdp: deps.cdp,
            signal,
            deadline,
            preserveWindowFocus: true,
            registerCleanup: clickDeps.registerClickCleanup,
          },
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
    releaseGate();
  }
}
