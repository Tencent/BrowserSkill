import { OVERLAY_AUTOMATION_BYPASS } from "@/lib/overlay-bridge";
import type { SessionManager } from "@/session-manager/manager";
import type { Transport } from "@/transport/transport";
import type {
  ClickParams,
  ConsoleParams,
  DownloadParams,
  EmulateParams,
  EvaluateParams,
  FillParams,
  GetHtmlParams,
  HoverParams,
  HoverResult,
  NavigateBackParams,
  NavigateForwardParams,
  NavigateParams,
  NetworkParams,
  ObserveParams,
  PressParams,
  ProtocolFrame,
  RecordAwaitParams,
  RecordStartParams,
  RecordStopParams,
  ReloadParams,
  RequestFrame,
  RequestHelpParams,
  ResponseFrame,
  RpcError,
  ScreenshotParams,
  SelectParams,
  SnapshotParams,
  UploadParams,
  WaitForNavigationParams,
} from "@/transport/types";
import { isRequestFrame } from "@/transport/types";
import { handleConsole } from "./console";
import { handleDownload } from "./download";
import { type EmulateCdpRunner, handleEmulate } from "./emulate";
import { handleEvaluate } from "./evaluate";
import { handleRequestHelp } from "./human-loop";
import { handleClick, handleFill, handleHover, handlePress, handleSelect } from "./interaction";
import {
  handleNavigate,
  handleNavigateBack,
  handleNavigateForward,
  handleReload,
} from "./navigation";
import { handleNetwork, type NetworkCdpRunner } from "./network";
import {
  type CdpRunner,
  chromeTabsCaptureApi,
  handleGetHtml,
  handleObserve,
  handleScreenshot,
  handleSnapshot,
} from "./observation";
import {
  handleRecordAwait,
  handleRecordStart,
  handleRecordStop,
  type RecordRuntimeDeps,
} from "./record";
import {
  handleSessionStart,
  handleSessionStop,
  type SessionStartParams,
  type SessionStopParams,
} from "./session";
import { chromeTabsApi, lookupSession, resolveTargetTab } from "./shared";
import {
  type BorrowConfirmationApprover,
  handleTabBorrow,
  handleTabClose,
  handleTabCreate,
  handleTabList,
  handleTabReturn,
  handleTabSelect,
  type TabBorrowParams,
  type TabCloseParams,
  type TabCreateParams,
  type TabListParams,
  type TabReturnParams,
  type TabSelectParams,
} from "./tabs";
import { handleUpload } from "./upload";
import { handleWaitForNavigation } from "./waits";
import { handleWindowResize, type WindowResizeParams } from "./window";

type DispatcherCdpRunner = CdpRunner &
  NetworkCdpRunner &
  EmulateCdpRunner & {
    detachSession(sessionId: string): Promise<void>;
  };

interface HoverLatch {
  sessionId: string;
  tabId: number;
  x: number;
  y: number;
}

interface HoverLatchScope {
  session_id: string;
  tab_id?: number;
}

export interface DispatcherDeps {
  transport: Transport;
  sessions: SessionManager;
  cdp?: DispatcherCdpRunner;
  recording?: RecordRuntimeDeps;
  /**
   * Invoked whenever a dispatched RPC may have changed the live
   * session set (currently `tool.session_start` and
   * `tool.session_stop`). Used to refresh side caches such as the
   * `chrome.storage.session` "sessions live" flag (review M4/M5 I3).
   */
  onSessionsChanged?: () => void;
  /** Invoked before a tool that dispatches page input or mutates browser state is forwarded. */
  onBrowserControlResumed?: (sessionId: string) => void;
  /** User approval for `tool.tab_borrow` (overlay in content script). */
  approveBorrow?: BorrowConfirmationApprover;
  /** i18n notification copy for `tool.request_help` (resolved per-call). */
  helpNotificationCopy?: () => { title: string; body: string };
}

/**
 * Routes RPC requests pushed by the daemon over the Transport to the
 * appropriate tool implementation.
 *
 * M5 wires `tool.session_start` and `tool.session_stop`. M6+ tools
 * will register additional method handlers here.
 *
 * M10.2 wires the cancel chain: every dispatched RPC owns one
 * `AbortController` keyed by its wire `id` in
 * [`inflightAbortControllers`]. When the daemon pushes a `cancel`
 * request the dispatcher trips the matching controller; tool
 * handlers observe that signal between awaited operations. The
 * original RPC remains pending until its handler has stopped or
 * completed compensation; only the separate cancel acknowledgement
 * takes the fast path.
 */
export class ToolDispatcher {
  private readonly transport: Transport;
  private readonly sessions: SessionManager;
  private readonly cdp?: DispatcherCdpRunner;
  private readonly recording?: RecordRuntimeDeps;
  private readonly onSessionsChanged?: () => void;
  private readonly onBrowserControlResumed?: (sessionId: string) => void;
  private readonly approveBorrow?: BorrowConfirmationApprover;
  private readonly helpNotificationCopy?: () => { title: string; body: string };
  private subscription: { dispose(): void } | null = null;
  private readonly hoverBypassTabs = new Map<number, string>();
  private readonly hoverLatches = new Map<number, HoverLatch>();
  /**
   * Per-rpc-id `AbortController` registry. Populated inside
   * [`dispatch`] before we await the tool handler and torn down in
   * the matching `finally` so failures + send errors never leak
   * controllers. Made public for tests.
   */
  readonly inflightAbortControllers = new Map<string, AbortController>();

  constructor(deps: DispatcherDeps) {
    this.transport = deps.transport;
    this.sessions = deps.sessions;
    this.cdp = deps.cdp;
    this.recording = deps.recording;
    this.onSessionsChanged = deps.onSessionsChanged;
    this.onBrowserControlResumed = deps.onBrowserControlResumed;
    this.approveBorrow = deps.approveBorrow;
    this.helpNotificationCopy = deps.helpNotificationCopy;
  }

  start(): void {
    if (this.subscription) return;
    this.subscription = this.transport.onMessage((msg) => {
      void this.dispatch(msg);
    });
  }

  stop(): void {
    this.subscription?.dispose();
    this.subscription = null;
    // Trip every outstanding controller so dependent waits unblock
    // before the dispatcher is GC'd.
    for (const ac of this.inflightAbortControllers.values()) {
      try {
        ac.abort();
      } catch (_) {
        // ignore
      }
    }
    this.inflightAbortControllers.clear();
  }

  private async dispatch(msg: ProtocolFrame): Promise<void> {
    if (!isRequestFrame(msg)) return;
    const req = msg as RequestFrame;

    // Cancel frames take a fast path: trip the matching controller
    // (if any), reply with `{cancelled}` so the daemon can answer
    // its own peer, and skip the regular tool dispatch.
    if (req.method === "cancel") {
      const params = (req.params as { rpc_id?: string } | undefined) ?? {};
      const target = typeof params.rpc_id === "string" ? params.rpc_id : "";
      const ac = target ? this.inflightAbortControllers.get(target) : undefined;
      if (ac) {
        try {
          ac.abort();
        } catch (err) {
          console.warn("[bsk dispatcher] AbortController.abort() threw", err);
        }
      }
      const reply: ResponseFrame = {
        id: req.id,
        result: { cancelled: ac !== undefined },
      };
      try {
        this.transport.send(reply);
      } catch (sendErr) {
        console.warn("[bsk dispatcher] failed to ack cancel", sendErr);
      }
      return;
    }

    const mutatesSessions =
      req.method === "tool.session_start" || req.method === "tool.session_stop";
    const ac = new AbortController();
    this.inflightAbortControllers.set(req.id, ac);
    let body: ResponseFrame;
    let startedSession: string | null = null;
    try {
      const sessionId = sessionIdForBrowserControlMethod(req);
      if (sessionId) this.onBrowserControlResumed?.(sessionId);
      const result = await this.invoke(req, ac.signal);
      if (isRpcError(result)) {
        body = { id: req.id, error: result };
      } else {
        body = { id: req.id, result };
        if (req.method === "tool.session_start") {
          startedSession = (req.params as SessionStartParams | undefined)?.session_id ?? null;
        }
      }
    } catch (err) {
      if (isAbortLikeError(err)) {
        body = {
          id: req.id,
          error: { code: "cancelled", message: "rpc aborted by daemon cancel" },
        };
      } else {
        body = {
          id: req.id,
          error: {
            code: "protocol_error",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    } finally {
      this.inflightAbortControllers.delete(req.id);
    }
    let sent = true;
    try {
      this.transport.send(body);
    } catch (sendErr) {
      sent = false;
      // Transport is dead by the time we want to reply. Drop the link
      // proactively so the alarm-driven keepalive reconnects sooner
      // and the daemon's pending RPC times out cleanly instead of
      // waiting for the full 15s budget (review M4/M5 I9).
      console.warn("[bsk dispatcher] failed to send response; dropping transport", sendErr);
      void this.transport.disconnect().catch((e) => {
        console.debug("[bsk dispatcher] disconnect after send failure errored", e);
      });
    }
    if (!sent && startedSession) {
      // The daemon never observed the session id we just allocated, so
      // its `start_session` reservation will be cancelled. Roll back
      // the Agent Window + SessionContext here so we do not leak an
      // orphan window the user has to close manually (review M4/M5
      // round 3 I-R3-3).
      try {
        const ctx = await this.sessions.stop(startedSession);
        if (ctx) {
          console.warn(
            "[bsk dispatcher] rolled back orphan session after send failure",
            startedSession,
          );
        }
      } catch (rollbackErr) {
        console.warn("[bsk dispatcher] session rollback after send failure failed", rollbackErr);
      }
    }
    if (mutatesSessions) this.onSessionsChanged?.();
  }

  private async invoke(req: RequestFrame, signal: AbortSignal): Promise<unknown | RpcError> {
    switch (req.method) {
      case "tool.session_start":
        return handleSessionStart(this.sessions, req.params as SessionStartParams, { signal });
      case "tool.session_stop": {
        await this.releaseHoverLatch((req.params as SessionStopParams).session_id);
        return handleSessionStop(this.sessions, req.params as SessionStopParams, {
          cdp: this.cdp,
          signal,
        });
      }
      case "tool.tab_list":
        return handleTabList(this.sessions, req.params as TabListParams, chromeTabsApi, signal);
      case "tool.tab_create":
        return handleTabCreate(this.sessions, req.params as TabCreateParams, { signal });
      case "tool.tab_close":
        return this.withHoverReleaseForRequest(
          req.params as TabCloseParams,
          () => handleTabClose(this.sessions, req.params as TabCloseParams, { signal }),
          signal,
        );
      case "tool.tab_select":
        return handleTabSelect(this.sessions, req.params as TabSelectParams, { signal });
      case "tool.tab_borrow":
        return handleTabBorrow(this.sessions, req.params as TabBorrowParams, {
          signal,
          approveBorrow: this.approveBorrow,
        });
      case "tool.tab_return":
        return handleTabReturn(this.sessions, req.params as TabReturnParams, { signal });
      case "tool.window_resize":
        return handleWindowResize(
          this.sessions,
          req.params as WindowResizeParams,
          undefined,
          signal,
        );
      case "tool.emulate":
        return handleEmulate(
          this.sessions,
          req.params as EmulateParams,
          this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
        );
      case "tool.screenshot":
        return handleScreenshot(
          this.sessions,
          req.params as ScreenshotParams,
          this.cdp
            ? { cdp: this.cdp, tabsApi: chromeTabsCaptureApi, captureApi: chromeTabsCaptureApi }
            : undefined,
          signal,
        );
      case "tool.console":
        return handleConsole(
          this.sessions,
          req.params as ConsoleParams,
          this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi } : undefined,
          signal,
        );
      case "tool.network":
        return handleNetwork(
          this.sessions,
          req.params as NetworkParams,
          this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi } : undefined,
          signal,
        );
      case "tool.snapshot":
        return this.withHoverReassert(
          req.params as SnapshotParams,
          () =>
            handleSnapshot(
              this.sessions,
              req.params as SnapshotParams,
              this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsCaptureApi } : undefined,
              signal,
            ),
          {},
          signal,
        );
      case "tool.observe": {
        const params = req.params as ObserveParams;
        const hoverScope = await this.resolveHoverLatchScope(params);
        throwIfDispatchAborted(signal);
        return this.withHoverReassert(
          params,
          () =>
            handleObserve(
              this.sessions,
              params,
              this.cdp
                ? {
                    cdp: this.cdp,
                    tabsApi: chromeTabsCaptureApi,
                    // Active hover probing is opt-in. A held hover latch still
                    // suppresses it, because probing would move the cursor off
                    // the element the caller is deliberately holding.
                    conditionalSurfaceProbe:
                      params.probe_hover === true && !this.hasHoverLatchForScope(hoverScope),
                    hoverProbeBypassOverlay: bypassOverlay,
                  }
                : undefined,
              signal,
            ),
          {},
          signal,
        );
      }
      case "tool.get_html":
        return handleGetHtml(
          this.sessions,
          req.params as GetHtmlParams,
          this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsCaptureApi } : undefined,
          signal,
        );
      case "tool.navigate":
        return this.withHoverReleaseForRequest(
          req.params as NavigateParams,
          () =>
            handleNavigate(
              this.sessions,
              req.params as NavigateParams,
              this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
            ),
          signal,
        );
      case "tool.navigate_back":
        return this.withHoverReleaseForRequest(
          req.params as NavigateBackParams,
          () =>
            handleNavigateBack(
              this.sessions,
              req.params as NavigateBackParams,
              this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
            ),
          signal,
        );
      case "tool.navigate_forward":
        return this.withHoverReleaseForRequest(
          req.params as NavigateForwardParams,
          () =>
            handleNavigateForward(
              this.sessions,
              req.params as NavigateForwardParams,
              this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
            ),
          signal,
        );
      case "tool.reload":
        return this.withHoverReleaseForRequest(
          req.params as ReloadParams,
          () =>
            handleReload(
              this.sessions,
              req.params as ReloadParams,
              this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
            ),
          signal,
        );
      case "tool.click":
        return this.withHoverReassert(
          req.params as ClickParams,
          () =>
            handleClick(
              this.sessions,
              req.params as ClickParams,
              this.cdp
                ? {
                    cdp: this.cdp,
                    tabsApi: chromeTabsApi,
                    signal,
                    bypassOverlay,
                  }
                : undefined,
            ),
          { releaseAfter: true },
          signal,
        );
      case "tool.hover": {
        const result = await handleHover(
          this.sessions,
          req.params as HoverParams,
          this.cdp
            ? {
                cdp: this.cdp,
                tabsApi: chromeTabsApi,
                signal,
                bypassOverlay: (tabId, enabled) =>
                  this.setHoverBypass((req.params as HoverParams).session_id, tabId, enabled),
                keepOverlayBypassAfterHover: true,
              }
            : undefined,
        );
        return this.rememberHover((req.params as HoverParams).session_id, result);
      }
      case "tool.fill":
        return this.withHoverReleaseForRequest(
          req.params as FillParams,
          () =>
            handleFill(
              this.sessions,
              req.params as FillParams,
              this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
            ),
          signal,
        );
      case "tool.press":
        return this.withHoverReleaseForRequest(
          req.params as PressParams,
          () =>
            handlePress(
              this.sessions,
              req.params as PressParams,
              this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
            ),
          signal,
        );
      case "tool.select":
        return this.withHoverReleaseForRequest(
          req.params as SelectParams,
          () =>
            handleSelect(
              this.sessions,
              req.params as SelectParams,
              this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
            ),
          signal,
        );
      case "tool.upload":
        return this.withHoverReleaseForRequest(
          req.params as UploadParams,
          () =>
            this.cdp
              ? handleUpload(this.sessions, req.params as UploadParams, {
                  cdp: this.cdp,
                  tabsApi: chromeTabsApi,
                  signal,
                  bypassOverlay,
                })
              : Promise.resolve({
                  code: "unsupported",
                  message: "upload requires CDP",
                } satisfies RpcError),
          signal,
        );
      case "tool.download":
        return this.withHoverReleaseForRequest(
          req.params as DownloadParams,
          () =>
            this.cdp
              ? handleDownload(this.sessions, req.params as DownloadParams, {
                  cdp: this.cdp,
                  tabsApi: chromeTabsApi,
                  signal,
                  bypassOverlay,
                })
              : Promise.resolve({
                  code: "unsupported",
                  message: "download requires CDP",
                } satisfies RpcError),
          signal,
        );
      case "tool.evaluate":
        return handleEvaluate(
          this.sessions,
          req.params as EvaluateParams,
          this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
        );
      case "tool.wait_for_navigation":
        return handleWaitForNavigation(
          this.sessions,
          req.params as WaitForNavigationParams,
          this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
        );
      case "tool.request_help":
        return handleRequestHelp(this.sessions, req.params as RequestHelpParams, {
          tabsApi: chromeTabsApi,
          windows: { update: (id, info) => chrome.windows.update(id, info) },
          activateTab: async (tabId) => {
            await chrome.tabs.update(tabId, { active: true });
          },
          sendToTab: (tabId, msg) => chrome.tabs.sendMessage(tabId, msg),
          ...(this.cdp ? { cdp: this.cdp } : {}),
          notifications: makeHelpNotifications(),
          notificationCopy: this.helpNotificationCopy?.(),
          signal,
        });
      case "tool.record_start":
        return this.recording
          ? handleRecordStart(this.sessions, req.params as RecordStartParams, {
              ...this.recording,
              signal,
            })
          : recordingRuntimeUnavailable();
      case "tool.record_stop":
        return this.recording
          ? handleRecordStop(this.sessions, req.params as RecordStopParams, {
              ...this.recording,
              signal,
            })
          : recordingRuntimeUnavailable();
      case "tool.record_await":
        return this.recording
          ? handleRecordAwait(this.sessions, req.params as RecordAwaitParams, {
              ...this.recording,
              signal,
            })
          : recordingRuntimeUnavailable();
      default:
        return {
          code: "unknown_method",
          message: `${req.method} not implemented in extension`,
        } satisfies RpcError;
    }
  }

  private async setHoverBypass(sessionId: string, tabId: number, enabled: boolean): Promise<void> {
    const owner = this.hoverBypassTabs.get(tabId);
    if (enabled) {
      if (owner === sessionId) return;
      if (owner === undefined) await bypassOverlay(tabId, true);
      this.hoverBypassTabs.set(tabId, sessionId);
    } else {
      if (owner !== sessionId) return;
      await bypassOverlay(tabId, false);
      this.hoverBypassTabs.delete(tabId);
    }
  }

  private rememberHover(sessionId: string, result: HoverResult | RpcError): HoverResult | RpcError {
    if (!isRpcError(result)) {
      this.hoverLatches.set(result.tab_id, {
        sessionId,
        tabId: result.tab_id,
        x: result.x,
        y: result.y,
      });
    }
    return result;
  }

  private hasHoverLatchForScope(scope: HoverLatchScope): boolean {
    return this.hoverLatchesForRequest(scope).length > 0;
  }

  private async withHoverReassert<T>(
    params: { session_id: string; tab_id?: number },
    work: () => Promise<T>,
    options: { releaseAfter?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<T> {
    throwIfDispatchAborted(signal);
    const scope = await this.resolveHoverLatchScope(params);
    throwIfDispatchAborted(signal);
    await this.reassertHover(scope);
    throwIfDispatchAborted(signal);
    try {
      return await work();
    } finally {
      if (options.releaseAfter) {
        await this.releaseHoverLatch(scope.session_id, scope.tab_id);
      }
    }
  }

  private async withHoverReleaseForRequest<T>(
    params: { session_id: string; tab_id?: number },
    work: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    throwIfDispatchAborted(signal);
    const scope = await this.resolveHoverLatchScope(params);
    throwIfDispatchAborted(signal);
    await this.releaseHoverLatch(scope.session_id, scope.tab_id);
    throwIfDispatchAborted(signal);
    return work();
  }

  private async resolveHoverLatchScope(params: {
    session_id: string;
    tab_id?: number;
  }): Promise<HoverLatchScope> {
    if (params.tab_id !== undefined) return params;
    const ctx = lookupSession(this.sessions, params, "hover latch");
    if (isRpcError(ctx)) return params;
    const target = await resolveTargetTab(this.sessions, ctx, undefined, chromeTabsApi);
    if (isRpcError(target)) return params;
    return { session_id: params.session_id, tab_id: target.tabId };
  }

  private hoverLatchesForRequest(params: { session_id: string; tab_id?: number }): HoverLatch[] {
    return [...this.hoverLatches.values()].filter((latch) => {
      if (latch.sessionId !== params.session_id) return false;
      return params.tab_id === undefined || latch.tabId === params.tab_id;
    });
  }

  private async reassertHover(params: { session_id: string; tab_id?: number }): Promise<void> {
    if (!this.cdp) return;
    await Promise.all(
      this.hoverLatchesForRequest(params).map((latch) =>
        this.cdp!.send(latch.tabId, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: latch.x,
          y: latch.y,
        }).catch((err) => {
          console.debug("[bsk dispatcher] hover reassert failed", err);
          this.hoverLatches.delete(latch.tabId);
        }),
      ),
    );
  }

  private async releaseHoverLatch(sessionId?: string, tabId?: number): Promise<void> {
    const matchesScope = (entrySessionId: string, entryTabId: number): boolean => {
      if (sessionId !== undefined && entrySessionId !== sessionId) return false;
      return tabId === undefined || entryTabId === tabId;
    };
    const tabs = new Set<number>();
    for (const [bypassTabId, bypassSessionId] of this.hoverBypassTabs) {
      if (!matchesScope(bypassSessionId, bypassTabId)) continue;
      tabs.add(bypassTabId);
      this.hoverBypassTabs.delete(bypassTabId);
    }
    for (const latch of this.hoverLatches.values()) {
      if (!matchesScope(latch.sessionId, latch.tabId)) continue;
      tabs.add(latch.tabId);
      this.hoverLatches.delete(latch.tabId);
    }
    await Promise.all([...tabs].map((tabId) => bypassOverlay(tabId, false)));
  }
}

function isRpcError(v: unknown): v is RpcError {
  return (
    typeof v === "object" &&
    v !== null &&
    "code" in v &&
    "message" in v &&
    typeof (v as RpcError).code === "string"
  );
}

function recordingRuntimeUnavailable(): RpcError {
  return {
    code: "protocol_error",
    message: "recording runtime is unavailable",
  };
}

function sessionIdForBrowserControlMethod(req: RequestFrame): string | null {
  switch (req.method) {
    case "tool.tab_create":
    case "tool.tab_close":
    case "tool.tab_select":
    case "tool.tab_borrow":
    case "tool.tab_return":
    case "tool.window_resize":
    case "tool.emulate":
    case "tool.navigate":
    case "tool.navigate_back":
    case "tool.navigate_forward":
    case "tool.reload":
    case "tool.click":
    case "tool.hover":
    case "tool.fill":
    case "tool.press":
    case "tool.select":
    case "tool.upload":
    case "tool.download":
    case "tool.evaluate":
    case "tool.observe":
    case "tool.request_help":
    case "tool.record_start": {
      const sessionId = (req.params as { session_id?: unknown } | undefined)?.session_id;
      return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
    }
    default:
      return null;
  }
}

async function bypassOverlay(tabId: number, enabled: boolean): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: OVERLAY_AUTOMATION_BYPASS,
      enabled,
    });
  } catch {
    // Content script may be unavailable on restricted pages.
  }
}

function throwIfDispatchAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("rpc aborted by daemon cancel");
  error.name = "AbortError";
  throw error;
}

function isAbortLikeError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError") {
    return true;
  }
  return false;
}

function makeHelpNotifications() {
  if (typeof chrome.notifications?.create !== "function") return null;
  return {
    create: (id: string, opts: chrome.notifications.NotificationOptions<true>) =>
      new Promise<string>((resolve, reject) =>
        chrome.notifications.create(id, opts, (rid) => {
          const err = chrome.runtime?.lastError;
          if (err) reject(new Error(err.message ?? String(err)));
          else resolve(rid ?? id);
        }),
      ),
    clear: (id: string) =>
      new Promise<boolean>((resolve) => chrome.notifications.clear(id, (c) => resolve(c ?? false))),
  };
}
