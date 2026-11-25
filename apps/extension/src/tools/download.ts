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

interface GateWaiter {
  settled: boolean;
  sessionId?: string;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
  grant(): void;
  refuse(): void;
}

/**
 * Instance-scoped concurrency gate for `chrome.downloads` attribution.
 * `ToolDispatcher` owns one gate per browser runtime; direct callers/tests
 * without an explicit gate derive an isolated gate per `DownloadsApi` instance.
 *
 * The slot is browser-global, so a second session cannot clear it by waiting on
 * its own daemon queue. Callers from *other* sessions queue here and report
 * `session_busy` only when their own budget expires. A second download for the
 * session that already holds the slot is a caller error (the daemon rejects a
 * concurrent command for one session before dispatch) and keeps failing at once.
 */
export class DownloadConcurrencyGate {
  private active = false;
  private holder?: string;
  private readonly waiters: GateWaiter[] = [];

  isBusy(): boolean {
    return this.active;
  }

  tryAcquire(sessionId?: string): (() => void) | null {
    if (this.active) return null;
    return this.takeSlot(sessionId);
  }

  /** Queue for the slot until `budgetMs` or `signal` ends the wait. */
  acquire(
    budgetMs: number,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<(() => void) | null> {
    if (signal?.aborted) return Promise.resolve(null);
    // Same-session concurrency is a caller bug, not contention: do not queue it.
    if (this.active && sessionId !== undefined && this.holder === sessionId) {
      return Promise.resolve(null);
    }
    if (!this.active) return Promise.resolve(this.takeSlot(sessionId));
    return new Promise((resolve) => {
      const waiter = {
        settled: false,
        sessionId,
        timer: setTimeout(() => waiter.refuse(), Math.max(0, budgetMs)),
        grant: () =>
          this.settle(waiter, () => {
            // The slot moves with the grant, never with a refused/aborted wait.
            this.holder = waiter.sessionId;
            resolve(this.newRelease());
          }),
        refuse: () => this.settle(waiter, () => resolve(null)),
      } as GateWaiter;
      if (signal) {
        waiter.signal = signal;
        waiter.onAbort = () => waiter.refuse();
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private settle(waiter: GateWaiter, done: () => void): void {
    if (waiter.settled) return;
    waiter.settled = true;
    const index = this.waiters.indexOf(waiter);
    if (index !== -1) this.waiters.splice(index, 1);
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    done();
  }

  private takeSlot(sessionId?: string): () => void {
    this.active = true;
    this.holder = sessionId;
    return this.newRelease();
  }

  /** Handing the slot straight to the next waiter keeps it closed to newcomers. */
  private newRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters[0];
      if (next) next.grant();
      else {
        this.active = false;
        this.holder = undefined;
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
  const gate = resolveDownloadGate(downloads, deps.downloadGate);
  const timeoutMs = params.timeout_ms ?? 120_000;
  // The slot is browser-global, so queue inside the caller's own budget. Keep
  // the reply margin the cooperation controller already uses below a transport
  // timeout, so waiting cannot lose the race to the daemon's RPC timeout.
  const gateEnteredAt = Date.now();
  const contended = gate.isBusy();
  const waitBudgetMs =
    params.timeout_ms === undefined
      ? timeoutMs
      : Math.max(0, params.timeout_ms - Math.min(500, Math.floor(params.timeout_ms / 4)));
  const releaseGate = await gate.acquire(waitBudgetMs, ctx.sessionId, deps.signal);
  if (!releaseGate) {
    const waitedMs = Date.now() - gateEnteredAt;
    if (deps.signal?.aborted) {
      return {
        code: "cancelled",
        message: "download aborted while waiting for the active download",
        data: {
          effect_state: "none",
          dispatched: false,
          phase: "before_trigger",
          waited_ms: waitedMs,
        },
      };
    }
    return rpcError("timeout", "session_busy", "another bsk download is active", {
      effect_state: "none",
      dispatched: false,
      phase: "before_trigger",
      waited_ms: waitedMs,
    });
  }
  // Wait time belongs to the caller's budget; the capture must not exceed it.
  const waitedMs = contended ? Date.now() - gateEnteredAt : 0;
  try {
    const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
    if (isRpcError(target)) return target;
    const denied = enforceAgentWindow(ctx, target, "download");
    if (denied) return denied;
    const address = await resolveActionTarget(deps.cdp, ctx, target, params, "download");
    if (isRpcError(address)) return address;

    const captureTimeoutMs = Math.max(1, timeoutMs - waitedMs);
    const deadline = Date.now() + captureTimeoutMs;
    let trigger: ReturnType<typeof pointerTransactionDeps> | undefined;
    const capture = await captureBrowserDownload({
      cdp: deps.cdp,
      handle: address.handle,
      downloads,
      navigationTargets: deps.navigationTargets ?? chromeNavigationTargetsApi,
      browserRelativeDir: params.browser_relative_dir,
      maxByteSize: params.max_byte_size,
      timeoutMs: captureTimeoutMs,
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
