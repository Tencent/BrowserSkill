import { OVERLAY_AUTOMATION_BYPASS } from "@/lib/overlay-bridge";
import type { SessionManager } from "@/session-manager/manager";
import type { Transport } from "@/transport/transport";
import type {
  ClickParams,
  ConsoleParams,
  EvaluateParams,
  FillParams,
  GetHtmlParams,
  NavigateBackParams,
  NavigateForwardParams,
  NavigateParams,
  PressParams,
  ProtocolFrame,
  ReloadParams,
  RequestFrame,
  RequestHelpParams,
  ResponseFrame,
  RpcError,
  ScreenshotParams,
  SelectParams,
  SnapshotParams,
  WaitForNavigationParams,
} from "@/transport/types";
import { isRequestFrame } from "@/transport/types";
import { handleConsole } from "./console";
import { handleEvaluate } from "./evaluate";
import { defaultWatchTabNavigation, handleRequestHelp } from "./human-loop";
import { handleClick, handleFill, handlePress, handleSelect } from "./interaction";
import {
  handleNavigate,
  handleNavigateBack,
  handleNavigateForward,
  handleReload,
} from "./navigation";
import {
  type CdpRunner,
  chromeTabsCaptureApi,
  handleGetHtml,
  handleScreenshot,
  handleSnapshot,
} from "./observation";
import {
  handleSessionStart,
  handleSessionStop,
  type SessionStartParams,
  type SessionStopParams,
} from "./session";
import { chromeTabsApi } from "./shared";
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
import { handleWaitForNavigation } from "./waits";

export interface DispatcherDeps {
  transport: Transport;
  sessions: SessionManager;
  cdp?: CdpRunner & {
    detachSession(sessionId: string): Promise<void>;
  };
  /**
   * Invoked whenever a dispatched RPC may have changed the live
   * session set (currently `tool.session_start` and
   * `tool.session_stop`). Used to refresh side caches such as the
   * `chrome.storage.session` "sessions live" flag (review M4/M5 I3).
   */
  onSessionsChanged?: () => void;
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
 * handlers that already accept a `signal` (waits, navigation,
 * interaction, evaluate, tabs) react in line, and the dispatcher
 * additionally races the in-flight invocation against the abort
 * promise so handlers without explicit signal plumbing still respond
 * promptly with `cancelled`.
 */
export class ToolDispatcher {
  private readonly transport: Transport;
  private readonly sessions: SessionManager;
  private readonly cdp?: CdpRunner & {
    detachSession(sessionId: string): Promise<void>;
  };
  private readonly onSessionsChanged?: () => void;
  private readonly approveBorrow?: BorrowConfirmationApprover;
  private readonly helpNotificationCopy?: () => { title: string; body: string };
  private subscription: { dispose(): void } | null = null;
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
    this.onSessionsChanged = deps.onSessionsChanged;
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
      const result = await Promise.race([this.invoke(req, ac.signal), abortPromise(ac.signal)]);
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
        return handleSessionStart(this.sessions, req.params as SessionStartParams);
      case "tool.session_stop":
        return handleSessionStop(this.sessions, req.params as SessionStopParams, {
          cdp: this.cdp,
        });
      case "tool.tab_list":
        return handleTabList(this.sessions, req.params as TabListParams);
      case "tool.tab_create":
        return handleTabCreate(this.sessions, req.params as TabCreateParams);
      case "tool.tab_close":
        return handleTabClose(this.sessions, req.params as TabCloseParams);
      case "tool.tab_select":
        return handleTabSelect(this.sessions, req.params as TabSelectParams);
      case "tool.tab_borrow":
        return handleTabBorrow(this.sessions, req.params as TabBorrowParams, {
          signal,
          approveBorrow: this.approveBorrow,
        });
      case "tool.tab_return":
        return handleTabReturn(this.sessions, req.params as TabReturnParams);
      case "tool.screenshot":
        return handleScreenshot(
          this.sessions,
          req.params as ScreenshotParams,
          this.cdp
            ? { cdp: this.cdp, tabsApi: chromeTabsCaptureApi, captureApi: chromeTabsCaptureApi }
            : undefined,
        );
      case "tool.console":
        return handleConsole(
          this.sessions,
          req.params as ConsoleParams,
          this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi } : undefined,
        );
      case "tool.snapshot":
        return handleSnapshot(
          this.sessions,
          req.params as SnapshotParams,
          this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsCaptureApi } : undefined,
        );
      case "tool.get_html":
        return handleGetHtml(
          this.sessions,
          req.params as GetHtmlParams,
          this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsCaptureApi } : undefined,
        );
      case "tool.navigate":
        return handleNavigate(
          this.sessions,
          req.params as NavigateParams,
          this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
        );
      case "tool.navigate_back":
        return handleNavigateBack(
          this.sessions,
          req.params as NavigateBackParams,
          this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
        );
      case "tool.navigate_forward":
        return handleNavigateForward(
          this.sessions,
          req.params as NavigateForwardParams,
          this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
        );
      case "tool.reload":
        return handleReload(
          this.sessions,
          req.params as ReloadParams,
          this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
        );
      case "tool.click":
        return handleClick(
          this.sessions,
          req.params as ClickParams,
          this.cdp
            ? {
                cdp: this.cdp,
                tabsApi: chromeTabsApi,
                signal,
                bypassOverlay: async (tabId, enabled) => {
                  try {
                    await chrome.tabs.sendMessage(tabId, {
                      type: OVERLAY_AUTOMATION_BYPASS,
                      enabled,
                    });
                  } catch {
                    // Content script may be unavailable on restricted pages.
                  }
                },
              }
            : undefined,
        );
      case "tool.fill":
        return handleFill(
          this.sessions,
          req.params as FillParams,
          this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
        );
      case "tool.press":
        return handlePress(
          this.sessions,
          req.params as PressParams,
          this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
        );
      case "tool.select":
        return handleSelect(
          this.sessions,
          req.params as SelectParams,
          this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
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
          watchTabNavigation: defaultWatchTabNavigation,
          ...(this.cdp ? { cdp: this.cdp } : {}),
          notifications: makeHelpNotifications(),
          notificationCopy: this.helpNotificationCopy?.(),
          signal,
        });
      default:
        return {
          code: "unknown_method",
          message: `${req.method} not implemented in extension`,
        } satisfies RpcError;
    }
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

/**
 * Resolves never; rejects with `AbortLikeError` as soon as the signal
 * fires (or immediately if it is already aborted). Used by the
 * dispatcher to race the tool invocation so handlers without explicit
 * signal plumbing still surface a `cancelled` reply promptly.
 */
function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new AbortLikeError());
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        reject(new AbortLikeError());
      },
      { once: true },
    );
  });
}

/**
 * Sentinel error class so [`isAbortLikeError`] can recognise our own
 * race-rejection without confusing it with a real CDP failure.
 */
class AbortLikeError extends Error {
  constructor() {
    super("rpc aborted by daemon cancel");
    this.name = "BhAbortError";
  }
}

function isAbortLikeError(err: unknown): boolean {
  if (err instanceof AbortLikeError) return true;
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
