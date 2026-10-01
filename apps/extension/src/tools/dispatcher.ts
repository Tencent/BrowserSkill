import type { DebugManager, DebugTicket } from "@/debug/manager";
import type { InteractionPreferenceStore } from "@/lib/interaction-preferences";
import { OVERLAY_AUTOMATION_BYPASS } from "@/lib/overlay-bridge";
import { ScreenshotExports } from "@/long-screenshot/exports";
import type { SessionManager } from "@/session-manager/manager";
import { withTaskPopups } from "@/session-manager/task-popups";
import type { ExtensionToolMethod, ResultOf } from "@/transport/generated/methods";
import {
  decodeToolRequest,
  isExtensionToolMethod,
  type ToolHandlerMap,
  type ToolRequest,
  validateCancelParams,
  validateToolResult,
} from "@/transport/protocol";
import type { Transport } from "@/transport/transport";
import type { HoverResult, ProtocolFrame, ResponseFrame, RpcError } from "@/transport/types";
import { isRequestFrame } from "@/transport/types";
import { auditContext } from "./audit-context";
import { prepareBackgroundExecution } from "./background-execution";
import { handleConsole } from "./console";
import { handleDebug } from "./debug";
import { handleDownload } from "./download";
import { type EmulateCdpRunner, handleEmulate } from "./emulate";
import { classifyCdpError } from "./errors";
import { handleEvaluate } from "./evaluate";
import { handleRequestHelp } from "./human-loop";
import {
  handleBlur,
  handleClick,
  handleFill,
  handleFocus,
  handleHover,
  handlePress,
  handleSelect,
} from "./interaction";
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
import { resumesBrowserControl, TOOL_POLICIES } from "./policy";
import {
  clearRecordingForSession,
  handleRecordAwait,
  handleRecordStart,
  handleRecordStop,
  type RecordRuntimeDeps,
} from "./record";
import { handleFullPageScreenshot } from "./screenshot-full-page";
import { handleScrollTo } from "./scroll";
import { handleSessionStart, handleSessionStop } from "./session";
import { chromeTabsApi, lookupSession, resolveTargetTab } from "./shared";
import {
  type BorrowConfirmationApprover,
  chromeTabMutationApi,
  handleTabBorrow,
  handleTabClose,
  handleTabCreate,
  handleTabList,
  handleTabReturn,
  handleTabSelect,
} from "./tabs";
import { handleUpload } from "./upload";
import { handleWaitForNavigation } from "./waits";
import { handleWheel } from "./wheel";
import { handleWindowResize } from "./window";

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
  debug?: DebugManager;
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
  /** Invoked after a tab is explicitly claimed so its overlay can be refreshed immediately. */
  onAgentTabClaimed?: (tabId: number, windowId: number) => void;
  /** User approval for `tool.tab_borrow` (overlay in content script). */
  approveBorrow?: BorrowConfirmationApprover;
  interactionPreferences?: InteractionPreferenceStore;
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
  private readonly debug?: DebugManager;
  private readonly transport: Transport;
  private readonly sessions: SessionManager;
  private screenshotExports: ScreenshotExports;
  private readonly cdp?: DispatcherCdpRunner;
  private readonly recording?: RecordRuntimeDeps;
  private readonly onSessionsChanged?: () => void;
  private readonly onBrowserControlResumed?: (sessionId: string) => void;
  private readonly onAgentTabClaimed?: (tabId: number, windowId: number) => void;
  private readonly approveBorrow?: BorrowConfirmationApprover;
  private readonly interactionPreferences?: InteractionPreferenceStore;
  private readonly helpNotificationCopy?: () => { title: string; body: string };
  private subscription: { dispose(): void } | null = null;
  private readonly hoverBypassTabs = new Map<number, string>();
  private readonly hoverLatches = new Map<number, HoverLatch>();
  private pendingSessionStarts = 0;
  private idleOperationInProgress = false;
  /**
   * Per-rpc-id `AbortController` registry. Populated inside
   * [`dispatch`] before we await the tool handler and torn down in
   * the matching `finally` so failures + send errors never leak
   * controllers. Made public for tests.
   */
  readonly inflightAbortControllers = new Map<string, AbortController>();

  constructor(deps: DispatcherDeps) {
    this.debug = deps.debug;
    this.transport = deps.transport;
    this.sessions = deps.sessions;
    this.screenshotExports = new ScreenshotExports((id) => this.sessions.has(id));
    this.cdp = deps.cdp;
    this.recording = deps.recording;
    this.onSessionsChanged = deps.onSessionsChanged;
    this.onBrowserControlResumed = deps.onBrowserControlResumed;
    this.onAgentTabClaimed = deps.onAgentTabClaimed;
    this.approveBorrow = deps.approveBorrow;
    this.interactionPreferences = deps.interactionPreferences;
    this.helpNotificationCopy = deps.helpNotificationCopy;
  }

  start(): void {
    if (this.subscription) return;
    this.subscription = this.transport.onMessage((msg) => {
      void this.dispatch(msg);
    });
  }

  /**
   * Reserve an idle browser for a connection change. Count start requests from
   * receipt, before any asynchronous preparation or window creation. Reject new
   * starts during the change so an old connection's request cannot create a
   * session after reconnecting.
   */
  async runWhenIdle(operation: () => Promise<void>): Promise<boolean> {
    if (
      this.idleOperationInProgress ||
      this.pendingSessionStarts > 0 ||
      this.sessions.list().length > 0
    ) {
      return false;
    }
    this.idleOperationInProgress = true;
    try {
      await operation();
      return true;
    } finally {
      this.idleOperationInProgress = false;
    }
  }

  stop(): void {
    this.debug?.dispose();
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
    const exports = this.screenshotExports;
    this.screenshotExports = new ScreenshotExports((id) => this.sessions.has(id));
    void exports.dispose();
  }

  private async dispatch(msg: ProtocolFrame): Promise<void> {
    if (!isRequestFrame(msg)) return;
    const raw = msg;

    // Cancel frames take a fast path: trip the matching controller
    // (if any), reply with `{cancelled}` so the daemon can answer
    // its own peer, and skip the regular tool dispatch.
    if (raw.method === "cancel") {
      if (!validateCancelParams(raw.params)) {
        this.sendResponse({
          id: raw.id,
          error: { code: "invalid_params", message: "cancel requires a string rpc_id" },
        });
        return;
      }
      const params = raw.params;
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
        id: raw.id,
        result: { cancelled: ac !== undefined },
      };
      this.sendResponse(reply);
      return;
    }

    // Capability rejection is independent of payload details. Preserve it for
    // remote gateways before validating local file-operation parameters.
    if (isExtensionToolMethod(raw.method) && !TOOL_POLICIES[raw.method].remoteAllowed) {
      const params = raw.params;
      const sessionId =
        typeof params === "object" && params !== null && "session_id" in params
          ? params.session_id
          : undefined;
      if (typeof sessionId === "string" && this.sessions.get(sessionId)?.remote) {
        this.sendResponse({
          id: raw.id,
          error: {
            code: "unsupported",
            message: "Remote connections do not support upload or download",
          },
        });
        return;
      }
    }
    const decoded = decodeToolRequest(raw);
    if (!decoded.ok) {
      this.sendResponse({ id: raw.id, error: decoded.error });
      return;
    }
    const req = decoded.request;
    const startsSession = req.method === "tool.session_start";
    const mutatesSessions = startsSession || req.method === "tool.session_stop";
    if (startsSession) this.pendingSessionStarts += 1;
    const ac = new AbortController();
    this.inflightAbortControllers.set(req.id, ac);
    let body: ResponseFrame;
    let startedSession: string | null = null;
    let debugTicket: DebugTicket | undefined;
    try {
      if (startsSession && this.idleOperationInProgress) {
        throw new Error("Browser settings are updating; retry session start.");
      }
      const sessionId = sessionIdForBrowserControlMethod(req);
      if (sessionId) this.onBrowserControlResumed?.(sessionId);
      // Best-effort context must never prevent the requested operation.
      try {
        const context = await auditContext(req, this.sessions);
        if (context) this.transport.send({ event: "audit.context", payload: context });
      } catch {
        /* The daemon still has the original operation metadata. */
      }
      try {
        debugTicket = await this.debug?.before(req, ac.signal);
      } catch {
        /* Evidence must not block the operation. */
      }
      throwIfDispatchAborted(ac.signal);
      let result = TOOL_POLICIES[req.method].opensTabs
        ? await withTaskPopups(
            this.sessions,
            (req.params ?? {}) as { session_id?: string; tab_id?: number },
            (inputSent) => this.invoke(req, ac.signal, inputSent),
            this.onAgentTabClaimed,
            ac.signal,
          )
        : await this.invoke(req, ac.signal);
      if (!isRpcError(result)) {
        const invalid = validateToolResult(req.method, result);
        if (invalid && startsSession) await this.sessions.stop(req.params.session_id);
        result = invalid ?? result;
      }
      this.debug?.after(debugTicket, isRpcError(result) ? result.message : undefined);
      debugTicket = undefined;
      if (isRpcError(result)) {
        body = { id: req.id, error: classifyCdpError(result) };
      } else {
        body = { id: req.id, result };
        if (req.method === "tool.session_start") {
          startedSession = req.params.session_id;
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
      if (startsSession) this.pendingSessionStarts -= 1;
      this.debug?.after(debugTicket, "operation failed");
      this.inflightAbortControllers.delete(req.id);
    }
    const sent = this.sendResponse(body);
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
    if (mutatesSessions) {
      this.debug?.sync();
      this.onSessionsChanged?.();
    }
  }
  private sendResponse(body: ResponseFrame): boolean {
    try {
      this.transport.send(body);
      return true;
    } catch (error) {
      // Both normal replies and boundary rejections must retire a dead link.
      console.warn("[bsk dispatcher] failed to send response; dropping transport", error);
      void this.transport.disconnect().catch((disconnectError) => {
        console.debug("[bsk dispatcher] disconnect after send failure errored", disconnectError);
      });
      return false;
    }
  }

  private readonly handlers: ToolHandlerMap = {
    "tool.debug": async (params, signal, onInputSent) => {
      if (!this.debug)
        return {
          code: "unsupported",
          message: "Website debugging requires a compatible extension",
        };
      return handleDebug(this.sessions, params, this.debug, chromeTabsApi, signal);
    },
    "tool.session_start": async (params, signal, onInputSent) => {
      return handleSessionStart(this.sessions, params, {
        signal,
        preferences: this.interactionPreferences,
      });
    },
    "tool.session_stop": async (params, signal, onInputSent) => {
      this.debug?.releaseSession(params.session_id);
      await this.screenshotExports.releaseSession(params.session_id);
      await this.releaseHoverLatch(params.session_id);
      return handleSessionStop(this.sessions, params, {
        cdp: this.cdp,
        // Must be wired in production: the agent-tab cleanup and the
        // window-release decision (issue #57) read these deps directly
        // and silently no-op when they are absent.
        tabManagement: { tabs: chromeTabMutationApi },
        tabsQuery: chromeTabsApi,
        signal,
      });
    },
    "tool.tab_list": async (params, signal, onInputSent) => {
      return handleTabList(this.sessions, params, chromeTabsApi, signal);
    },
    "tool.tab_create": async (params, signal, onInputSent) => {
      const result = await handleTabCreate(this.sessions, params, {
        signal,
        cdp: this.cdp,
      });
      if (!isRpcError(result)) {
        this.onAgentTabClaimed?.(result.tab_id, result.window_id);
      }
      return result;
    },
    "tool.tab_close": async (params, signal, onInputSent) => {
      return this.withHoverReleaseForRequest(
        params,
        () => handleTabClose(this.sessions, params, { signal }),
        signal,
      );
    },
    "tool.tab_select": async (params, signal, onInputSent) => {
      return handleTabSelect(this.sessions, params, { signal });
    },
    "tool.tab_borrow": async (params, signal, onInputSent) => {
      const result = await handleTabBorrow(this.sessions, params, {
        signal,
        approveBorrow: this.approveBorrow,
        cdp: this.cdp,
      });
      if (!isRpcError(result)) {
        this.onAgentTabClaimed?.(result.tab_id, result.agent_window_id);
      }
      return result;
    },
    "tool.tab_return": async (params, signal, onInputSent) => {
      return handleTabReturn(this.sessions, params, {
        signal,
        cdp: this.cdp,
        beforeReturn: async (sessionId, tabId) => {
          this.debug?.stopTab(tabId);
          if (this.sessions.get(sessionId)?.remote) clearRecordingForSession(sessionId);
          await this.releaseHoverLatch(sessionId, tabId);
        },
      });
    },
    "tool.window_resize": async (params, signal, onInputSent) => {
      return handleWindowResize(this.sessions, params, undefined, signal);
    },
    "tool.emulate": async (params, signal, onInputSent) => {
      return handleEmulate(
        this.sessions,
        params,
        this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
      );
    },
    "tool.screenshot_full_page": async (params, signal, onInputSent) => {
      if (!this.cdp) return { code: "unsupported", message: "Full-page screenshot requires CDP" };
      return handleFullPageScreenshot(
        this.sessions,
        params,
        {
          cdp: this.cdp,
          tabsApi: chromeTabsApi,
          exports: this.screenshotExports,
        },
        signal,
      );
    },
    "tool.screenshot_read": async (params, signal, onInputSent) => {
      return this.screenshotExports.read(params);
    },
    "tool.screenshot_release": async (params, signal, onInputSent) => {
      return this.screenshotExports.release(params);
    },
    "tool.screenshot": async (params, signal, onInputSent) => {
      return handleScreenshot(
        this.sessions,
        params,
        this.cdp
          ? { cdp: this.cdp, tabsApi: chromeTabsCaptureApi, captureApi: chromeTabsCaptureApi }
          : undefined,
        signal,
      );
    },
    "tool.console": async (params, signal, onInputSent) => {
      return handleConsole(
        this.sessions,
        params,
        this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi } : undefined,
        signal,
      );
    },
    "tool.network": async (params, signal, onInputSent) => {
      return handleNetwork(
        this.sessions,
        params,
        this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi } : undefined,
        signal,
      );
    },
    "tool.snapshot": async (params, signal, onInputSent) => {
      return this.withHoverReassert(
        params,
        () =>
          handleSnapshot(
            this.sessions,
            params,
            this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsCaptureApi } : undefined,
            signal,
          ),
        {},
        signal,
      );
    },
    "tool.observe": async (params, signal, onInputSent) => {
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
    },
    "tool.get_html": async (params, signal, onInputSent) => {
      return handleGetHtml(
        this.sessions,
        params,
        this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsCaptureApi } : undefined,
        signal,
      );
    },
    "tool.navigate": async (params, signal, onInputSent) => {
      return this.withHoverReleaseForRequest(
        params,
        () =>
          handleNavigate(
            this.sessions,
            params,
            this.cdp
              ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal, backgroundExecution: true }
              : undefined,
          ),
        signal,
      );
    },
    "tool.navigate_back": async (params, signal, onInputSent) => {
      return this.withHoverReleaseForRequest(
        params,
        () =>
          handleNavigateBack(
            this.sessions,
            params,
            this.cdp
              ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal, backgroundExecution: true }
              : undefined,
          ),
        signal,
      );
    },
    "tool.navigate_forward": async (params, signal, onInputSent) => {
      return this.withHoverReleaseForRequest(
        params,
        () =>
          handleNavigateForward(
            this.sessions,
            params,
            this.cdp
              ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal, backgroundExecution: true }
              : undefined,
          ),
        signal,
      );
    },
    "tool.reload": async (params, signal, onInputSent) => {
      return this.withHoverReleaseForRequest(
        params,
        () =>
          handleReload(
            this.sessions,
            params,
            this.cdp
              ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal, backgroundExecution: true }
              : undefined,
          ),
        signal,
      );
    },
    "tool.click": async (params, signal, onInputSent) => {
      return this.withHoverReassert(
        params,
        () =>
          handleClick(
            this.sessions,
            params,
            this.cdp
              ? {
                  cdp: this.cdp,
                  tabsApi: chromeTabsApi,
                  signal,
                  bypassOverlay,
                  onInputSent,
                }
              : undefined,
          ),
        { releaseAfter: true },
        signal,
      );
    },
    "tool.hover": async (params, signal, onInputSent) => {
      const result = await handleHover(
        this.sessions,
        params,
        this.cdp
          ? {
              cdp: this.cdp,
              tabsApi: chromeTabsApi,
              signal,
              bypassOverlay: (tabId, enabled) =>
                this.setHoverBypass(params.session_id, tabId, enabled),
              keepOverlayBypassAfterHover: true,
            }
          : undefined,
      );
      return this.rememberHover(params.session_id, result);
    },
    "tool.wheel": async (params, signal, onInputSent) => {
      return this.withHoverReassert(
        params,
        () =>
          handleWheel(
            this.sessions,
            params,
            this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal, bypassOverlay } : undefined,
          ),
        { releaseAfter: true },
        signal,
      );
    },
    "tool.scroll_to": async (params, signal, onInputSent) => {
      return this.withHoverReleaseForRequest(
        params,
        () =>
          handleScrollTo(
            this.sessions,
            params,
            this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
          ),
        signal,
      );
    },
    "tool.focus": async (params, signal, onInputSent) => {
      return this.withHoverReleaseForRequest(
        params,
        () =>
          handleFocus(
            this.sessions,
            params,
            this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
          ),
        signal,
      );
    },
    "tool.blur": async (params, signal, onInputSent) => {
      return this.withHoverReleaseForRequest(
        params,
        () =>
          handleBlur(
            this.sessions,
            params,
            this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
          ),
        signal,
      );
    },
    "tool.fill": async (params, signal, onInputSent) => {
      return this.withHoverReleaseForRequest(
        params,
        () =>
          handleFill(
            this.sessions,
            params,
            this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
          ),
        signal,
      );
    },
    "tool.press": async (params, signal, onInputSent) => {
      return this.withHoverReleaseForRequest(
        params,
        () =>
          handlePress(
            this.sessions,
            params,
            this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal, onInputSent } : undefined,
          ),
        signal,
      );
    },
    "tool.select": async (params, signal, onInputSent) => {
      return this.withHoverReleaseForRequest(
        params,
        () =>
          handleSelect(
            this.sessions,
            params,
            this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
          ),
        signal,
      );
    },
    "tool.upload": async (params, signal, onInputSent) => {
      return this.withHoverReleaseForRequest(
        params,
        () =>
          this.cdp
            ? handleUpload(this.sessions, params, {
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
    },
    "tool.download": async (params, signal, onInputSent) => {
      return this.withHoverReleaseForRequest(
        params,
        () =>
          this.cdp
            ? handleDownload(this.sessions, params, {
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
    },
    "tool.evaluate": async (params, signal, onInputSent) => {
      return handleEvaluate(
        this.sessions,
        params,
        this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
      );
    },
    "tool.wait_for_navigation": async (params, signal, onInputSent) => {
      return handleWaitForNavigation(
        this.sessions,
        params,
        this.cdp ? { cdp: this.cdp, tabsApi: chromeTabsApi, signal } : undefined,
      );
    },
    "tool.request_help": async (params, signal, onInputSent) => {
      return handleRequestHelp(this.sessions, params, {
        preferences: this.interactionPreferences,
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
    },
    "tool.record_start": async (params, signal, onInputSent) => {
      return this.recording
        ? handleRecordStart(this.sessions, params, {
            ...this.recording,
            signal,
          })
        : recordingRuntimeUnavailable();
    },
    "tool.record_stop": async (params, signal, onInputSent) => {
      return this.recording
        ? handleRecordStop(this.sessions, params, {
            ...this.recording,
            signal,
          })
        : recordingRuntimeUnavailable();
    },
    "tool.record_await": async (params, signal, onInputSent) => {
      return this.recording
        ? handleRecordAwait(this.sessions, params, {
            ...this.recording,
            signal,
          })
        : recordingRuntimeUnavailable();
    },
  };

  private async invoke<M extends ExtensionToolMethod>(
    req: ToolRequest<M>,
    signal: AbortSignal,
    onInputSent?: (tabId: number) => void,
  ): Promise<ResultOf<M> | RpcError> {
    const preparationError = await prepareBackgroundExecution(
      this.sessions,
      req,
      this.cdp,
      chromeTabsApi,
      signal,
    );
    if (preparationError) return preparationError;

    return this.handlers[req.method](req.params, signal, onInputSent);
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

function sessionIdForBrowserControlMethod(req: ToolRequest): string | null {
  return resumesBrowserControl(req.method, req.params) ? req.params.session_id : null;
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
