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
import { withInputReady } from "./input-readiness";
import { clickResolvedTarget, type InteractionDeps, resolveActionTarget } from "./interaction";
import { pointerTransactionDeps } from "./pointer-transaction";
import { enforceAgentWindow, isRpcError, lookupSession, resolveTargetTab } from "./shared";

// chrome.downloads is browser-global, so captures run one at a time. A later
// call waits its turn within its own timeout instead of failing at once (#519).
// Each gate also waits for its predecessor, so a waiter that gives up early
// never lets the next call overlap a capture that is still running.
let downloadGate: Promise<void> = Promise.resolve();

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
  const timeoutMs = params.timeout_ms ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  const turn = downloadGate;
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  downloadGate = Promise.all([turn, done]).then(() => {});
  try {
    const waited = await waitForTurn(turn, deadline, deps.signal);
    if (waited) return waited;
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

    let trigger: ReturnType<typeof pointerTransactionDeps> | undefined;
    const capture = await captureBrowserDownload({
      cdp: deps.cdp,
      target: address.cdpTarget,
      downloads: deps.downloads ?? chromeDownloadsApi,
      navigationTargets: deps.navigationTargets ?? chromeNavigationTargetsApi,
      browserRelativeDir: params.browser_relative_dir,
      maxByteSize: params.max_byte_size,
      timeoutMs: Math.max(0, deadline - Date.now()),
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
    release();
  }
}

async function waitForTurn(
  turn: Promise<void>,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<RpcError | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const data = { effect_state: "none", phase: "queue" } as const;
  try {
    return await Promise.race([
      turn.then(() => undefined),
      new Promise<RpcError>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              code: "timeout",
              message: "another bsk download was still active when the timeout expired",
              data,
            }),
          Math.max(0, deadline - Date.now()),
        );
        onAbort = () =>
          resolve({
            code: "cancelled",
            message: "cancelled while waiting for another bsk download",
            data,
          });
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
