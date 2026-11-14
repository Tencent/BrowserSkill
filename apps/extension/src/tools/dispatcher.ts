import type { CooperationController } from "@/cooperation/controller";
import type { DebugManager, DebugTicket } from "@/debug/manager";
import type { InteractionPreferenceStore } from "@/lib/interaction-preferences";
import { OVERLAY_AUTOMATION_BYPASS } from "@/lib/overlay-bridge";
import { ScreenshotExports } from "@/long-screenshot/exports";
import {
  isAgentControlledTab,
  type SessionContext,
  type SessionManager,
} from "@/session-manager/manager";
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
import type {
  DialogHandleResult,
  DialogStatusResult,
  HoverResult,
  ProtocolFrame,
  RequestFrame,
  ResponseFrame,
  RpcError,
} from "@/transport/types";
import { isRequestFrame } from "@/transport/types";
import { videoError } from "@/video/errors";
import type { VideoManager } from "@/video/manager";
import { auditContext } from "./audit-context";
import { prepareBackgroundExecution } from "./background-execution";
import { handleConsole } from "./console";
import { handleDebug } from "./debug";
import { handleDialog } from "./dialog-control";
import { handleDownload } from "./download";
import { handleDrag } from "./drag";
import { type EmulateCdpRunner, handleEmulate } from "./emulate";
import { classifyCdpError, rpcError } from "./errors";
import { handleEvaluate } from "./evaluate";
import { handleExtract } from "./extract";
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
import { resumesBrowserControl, TOOL_POLICIES, toolPolicy } from "./policy";
import { handleRead } from "./read";
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
import {
  cdpBlockedUrlReason,
  chromeTabsApi,
  lookupSession,
  resolveTargetTab,
  sessionCdpRunner,
} from "./shared";
import {
  type BorrowConfirmationApprover,
  chromeTabMutationApi,
  handleTabBorrow,
  handleTabClose,
  handleTabCreate,
  handleTabList,
  handleTabReturn,
  handleTabSelect,
  type TabBorrowResult,
} from "./tabs";
import { handleUpload } from "./upload";
import { handleWaitForElement, handleWaitForNavigation } from "./waits";
import { handleWheel } from "./wheel";
import { chromeWindowResizeApi, handleWindowResize } from "./window";

type DispatcherCdpRunner = CdpRunner &
  NetworkCdpRunner &
  EmulateCdpRunner & {
    detachSession(sessionId: string): Promise<void>;
  };

interface ToolContext {
  signal: AbortSignal;
  completionSignal: AbortSignal;
  cdp?: DispatcherCdpRunner;
  onInputSent?: (tabId: number) => void;
}

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
  cooperation?: CooperationController;
  video?: VideoManager;
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

/** Suggested wait before retrying a request refused while another settles.
 * Viewport captures are bounded at 10 s plus 500 ms cleanup; most settle sooner. */
const OPERATION_SETTLING_RETRY_MS = 1_000;

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
  private readonly video?: VideoManager;
  private readonly debug?: DebugManager;
  private readonly transport: Transport;
  private readonly sessions: SessionManager;
  private screenshotExports: ScreenshotExports;
  private readonly cdp?: DispatcherCdpRunner;
  private readonly recording?: RecordRuntimeDeps;
  private readonly onSessionsChanged?: () => void;
  private readonly cooperation?: CooperationController;
  private readonly onBrowserControlResumed?: (sessionId: string) => void;
  private readonly onAgentTabClaimed?: (tabId: number, windowId: number) => void;
  private readonly approveBorrow?: BorrowConfirmationApprover;
  private readonly interactionPreferences?: InteractionPreferenceStore;
  private readonly helpNotificationCopy?: () => { title: string; body: string };
  private subscription: { dispose(): void } | null = null;
  private readonly hoverBypassTabs = new Map<number, string>();
  private readonly hoverLatches = new Map<number, HoverLatch>();
  private readonly activeDialogOperations = new Map<
    string,
    { request: RequestFrame; operationId: string }
  >();
  private dialogSubscription: { dispose(): void } | null = null;
  private pendingSessionStarts = 0;
  private idleOperationInProgress = false;
  /**
   * Per-rpc-id `AbortController` registry. Populated inside
   * [`dispatch`] before we await the tool handler and torn down in
   * the matching `finally` so failures + send errors never leak
   * controllers. Made public for tests.
   */
  readonly inflightAbortControllers = new Map<string, AbortController>();
  private readonly requestSessions = new Map<string, string>();

  constructor(deps: DispatcherDeps) {
    this.cooperation = deps.cooperation;
    this.video = deps.video;
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
    this.dialogSubscription =
      this.cdp?.onDialogChanged?.((tabId, dialog, reason) => {
        const sessionId = this.sessions.findControllingSession(tabId);
        if (!sessionId) return;
        const active = this.activeDialogOperations.get(sessionId);
        if (reason === "decision_timeout" && active)
          this.inflightAbortControllers.get(active.request.id)?.abort();
        // Dismissing one dialog can synchronously resume page code that opens
        // another. Keep rejecting the chain until the original handler settles.
        if (
          dialog &&
          active &&
          this.inflightAbortControllers.get(active.request.id)?.signal.aborted
        )
          void this.cdp?.resolveDialog?.(dialog.id, false).catch(() => {});
        try {
          this.transport.send({
            event: "dialog.changed",
            payload: {
              session_id: sessionId,
              tab_id: tabId,
              dialog,
              ...(active ? { operation_id: active.operationId } : {}),
            },
          });
        } catch {
          /* Disconnect invalidates the daemon's operation, never replay it. */
        }
      }) ?? null;
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
    this.dialogSubscription?.dispose();
    this.dialogSubscription = null;
    for (const active of this.activeDialogOperations.values())
      this.dismissOperationDialogs(active.request);
    this.activeDialogOperations.clear();
    for (const ac of this.inflightAbortControllers.values()) {
      try {
        ac.abort();
      } catch (_) {
        // ignore
      }
    }
    this.inflightAbortControllers.clear();
    this.requestSessions.clear();
    const exports = this.screenshotExports;
    this.screenshotExports = new ScreenshotExports((id) => this.sessions.has(id));
    void exports.dispose();
  }

  /** Revoke in-flight work locally; do not wait for the daemon's round trip. */
  cancelSession(sessionId: string): void {
    for (const [rpcId, owner] of this.requestSessions) {
      if (owner === sessionId) this.inflightAbortControllers.get(rpcId)?.abort();
    }
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
        const active = [...this.activeDialogOperations.values()].find(
          (item) => item.request.id === target,
        );
        try {
          ac.abort();
        } catch (err) {
          console.warn("[bsk dispatcher] AbortController.abort() threw", err);
        }
        if (active) this.dismissOperationDialogs(active.request);
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
    const rawEnvelope =
      typeof raw.params === "object" && raw.params !== null && !Array.isArray(raw.params)
        ? (raw.params as { _operation_id?: unknown; _audit_id?: unknown })
        : undefined;
    const rawOperationId =
      typeof rawEnvelope?._operation_id === "string" ? rawEnvelope._operation_id : undefined;
    const rawAuditId =
      typeof rawEnvelope?._audit_id === "string" ? rawEnvelope._audit_id : undefined;

    const decoded = decodeToolRequest(raw);
    if (!decoded.ok) {
      this.sendResponse({ id: raw.id, error: decoded.error });
      return;
    }
    const req = decoded.request;
    const policy = TOOL_POLICIES[req.method];
    const startsSession = req.method === "tool.session_start";
    const stopsSession = req.method === "tool.session_stop";
    const mutatesSessions = startsSession || stopsSession;
    if (startsSession) this.pendingSessionStarts += 1;
    const ac = new AbortController();
    this.inflightAbortControllers.set(req.id, ac);
    const requestSessionId =
      "session_id" in req.params && typeof req.params.session_id === "string"
        ? req.params.session_id
        : undefined;
    if (requestSessionId) this.requestSessions.set(req.id, requestSessionId);
    let body: ResponseFrame;
    let startedSession: string | null = null;
    let debugTicket: DebugTicket | undefined;
    try {
      if (startsSession && this.idleOperationInProgress) {
        throw new Error("Browser settings are updating; retry session start.");
      }
      const dialogControl = policy.cooperation === "dialog";
      const blocked = requestSessionId ? this.pendingForSession(requestSessionId) : undefined;
      if (!dialogControl && !stopsSession && blocked) {
        body = {
          id: req.id,
          error: {
            code: "dialog_pending",
            message:
              "Resolve the pending dialog before starting another action; this action was not dispatched",
            data: { dispatched: false, dialog: blocked, session_id: requestSessionId },
          },
        };
      } else if (
        requestSessionId &&
        rawOperationId &&
        this.activeDialogOperations.has(requestSessionId)
      ) {
        // A daemon cleanup deadline can expire before Chrome releases the
        // original call. Do not replace the owner of its dialog cleanup.
        // Nothing was sent, so the caller may retry the same request once the
        // earlier one settles (for example a cancelled screenshot, #527).
        const settling = this.activeDialogOperations.get(requestSessionId);
        body = {
          id: req.id,
          error: {
            code: "cdp_failed",
            message: "Previous operation is still settling; this action was not dispatched",
            data: {
              dispatched: false,
              reason: "operation_settling",
              retryable: true,
              retry_after_ms: OPERATION_SETTLING_RETRY_MS,
              settling_method: settling?.request.method,
            },
          },
        };
      } else {
        if (requestSessionId && rawOperationId) {
          this.activeDialogOperations.set(requestSessionId, {
            request: req,
            operationId: rawOperationId,
          });
        }
        const sessionId = sessionIdForBrowserControlMethod(req);
        if (sessionId) this.onBrowserControlResumed?.(sessionId);
        // Best-effort context must never prevent the requested operation.
        if (rawAuditId) {
          try {
            const context = await auditContext(
              {
                ...req,
                params: {
                  ...(req.params as Record<string, unknown>),
                  _audit_id: rawAuditId,
                },
              },
              this.sessions,
            );
            if (context) this.transport.send({ event: "audit.context", payload: context });
          } catch {
            /* The daemon still has the original operation metadata. */
          }
        }
        try {
          if (!dialogControl && !stopsSession)
            debugTicket = await this.debug?.before(req, ac.signal);
        } catch {
          /* Evidence must not block the operation. */
        }
        throwIfDispatchAborted(ac.signal);
        let result = policy.opensTabs
          ? await withTaskPopups(
              this.sessions,
              (req.params ?? {}) as { session_id?: string; tab_id?: number },
              (inputSent) => this.invoke(req, ac.signal, inputSent),
              this.onAgentTabClaimed,
              ac.signal,
            )
          : stopsSession && requestSessionId
            ? await this.withDialogCleanup(requestSessionId, () => this.invoke(req, ac.signal))
            : await this.invoke(req, ac.signal);
        if (!isRpcError(result)) {
          const invalid = validateToolResult(req.method, result);
          if (invalid && startsSession && requestSessionId)
            await this.sessions.stop(requestSessionId);
          result = invalid ?? result;
        }
        this.debug?.after(debugTicket, isRpcError(result) ? result.message : undefined);
        debugTicket = undefined;
        if (isRpcError(result)) {
          body = { id: req.id, error: classifyCdpError(result) };
        } else {
          body = { id: req.id, result };
          if (startsSession) {
            startedSession = requestSessionId ?? null;
          }
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
      this.requestSessions.delete(req.id);
      if (
        requestSessionId &&
        this.activeDialogOperations.get(requestSessionId)?.request.id === req.id
      ) {
        this.activeDialogOperations.delete(requestSessionId);
      }
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

  private readonly handlers: ToolHandlerMap<ToolContext> = {
    "tool.cooperate": async () => ({
      code: "unsupported",
      message: "Shared-tab cooperation requires a compatible extension runtime",
    }),
    "tool.video": async (params, { signal }) => {
      if (!this.video)
        return { code: "unsupported", message: "Video recording requires a compatible extension" };
      try {
        return await this.video.rpc(params, signal);
      } catch (error) {
        return videoError(error, signal?.aborted ? "cancelled" : "cdp_failed");
      }
    },
    "tool.read": async (params, { signal, cdp }) =>
      cdp
        ? handleRead(this.sessions, params, { cdp, tabsApi: chromeTabsApi }, signal)
        : { code: "unsupported", message: "read requires CDP" },
    "tool.extract": async (params, { signal, cdp }) =>
      cdp
        ? handleExtract(this.sessions, params, { cdp, tabsApi: chromeTabsApi }, signal)
        : { code: "unsupported", message: "extract requires CDP" },
    "tool.wait_for_element": async (params, { signal, cdp }) =>
      cdp
        ? handleWaitForElement(this.sessions, params, { cdp, tabsApi: chromeTabsApi, signal })
        : { code: "unsupported", message: "wait_for_element requires CDP" },
    "tool.debug": async (params, { signal, cdp }) => {
      if (!this.debug)
        return {
          code: "unsupported",
          message: "Website debugging requires a compatible extension",
        };
      return handleDebug(
        this.sessions,
        params,
        this.debug,
        chromeTabsApi,
        signal,
        cdp?.runBrowserMutation,
      );
    },
    "tool.dialog_status": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "Dialog control requires CDP" };
      return handleDialog(this.sessions, "tool.dialog_status", params, cdp, {
        signal,
        authority: this.cooperation,
      }) as Promise<DialogStatusResult | RpcError>;
    },
    "tool.dialog_accept": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "Dialog control requires CDP" };
      return handleDialog(this.sessions, "tool.dialog_accept", params, cdp, {
        signal,
        authority: this.cooperation,
      }) as Promise<DialogHandleResult | RpcError>;
    },
    "tool.dialog_dismiss": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "Dialog control requires CDP" };
      return handleDialog(this.sessions, "tool.dialog_dismiss", params, cdp, {
        signal,
        authority: this.cooperation,
      }) as Promise<DialogHandleResult | RpcError>;
    },
    "tool.session_start": async (params, { signal }) => {
      return handleSessionStart(this.sessions, params, {
        signal,
        preferences: this.interactionPreferences,
      });
    },
    "tool.session_stop": async (params, { signal, cdp }) => {
      if (this.video)
        await this.video
          .stopSession(params.session_id)
          .catch((error) => console.warn("Video finalization failed during task cleanup", error));
      this.debug?.releaseSession(params.session_id);
      await this.screenshotExports.releaseSession(params.session_id);
      await this.releaseHoverLatch(params.session_id);
      const result = await handleSessionStop(this.sessions, params, {
        cdp,
        ...(typeof chrome === "undefined"
          ? {}
          : { tabManagement: { tabs: chromeTabMutationApi }, tabsQuery: chromeTabsApi }),
        signal,
      });
      if (!this.sessions.has(params.session_id)) this.cooperation?.release(params.session_id);
      return result;
    },
    "tool.tab_list": async (params, { signal }) => {
      return handleTabList(this.sessions, params, chromeTabsApi, signal);
    },
    "tool.tab_create": async (params, { signal, cdp }) => {
      const result = await handleTabCreate(this.sessions, params, {
        signal,
        cdp,
      });
      if (!isRpcError(result)) {
        this.onAgentTabClaimed?.(result.tab_id, result.window_id);
      }
      return result;
    },
    "tool.tab_close": async (params, { signal, cdp }) => {
      return this.withHoverReleaseForRequest(
        params,
        () => handleTabClose(this.sessions, params, { signal, cdp }),
        signal,
      );
    },
    "tool.tab_select": async (params, { signal, cdp }) => {
      return handleTabSelect(this.sessions, params, { signal, cdp });
    },
    "tool.tab_borrow": async (params, { signal, cdp }) => {
      const result = await handleTabBorrow(this.sessions, params, {
        signal,
        approveBorrow: this.getBorrowApprover(),
        cdp,
      });
      if (!isRpcError(result)) {
        this.onAgentTabClaimed?.(result.tab_id, result.agent_window_id);
      }
      return result;
    },
    "tool.tab_return": async (params, { signal, cdp }) => {
      return handleTabReturn(this.sessions, params, {
        signal,
        cdp,
        beforeReturn: async (sessionId, tabId) => {
          this.debug?.stopTab(tabId);
          clearRecordingForSession(sessionId);
          await this.releaseHoverLatch(sessionId, tabId);
        },
      });
    },
    "tool.window_resize": async (params, { signal, cdp }) => {
      return handleWindowResize(
        this.sessions,
        params,
        { windows: chromeWindowResizeApi, tabs: chromeTabsApi, cdp },
        signal,
      );
    },
    "tool.emulate": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "emulate requires CDP" };
      return handleEmulate(this.sessions, params, { cdp, tabsApi: chromeTabsApi, signal });
    },
    "tool.screenshot_full_page": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "Full-page screenshot requires CDP" };
      return handleFullPageScreenshot(
        this.sessions,
        params,
        {
          cdp,
          tabsApi: chromeTabsApi,
          exports: this.screenshotExports,
        },
        signal,
      );
    },
    "tool.screenshot_read": async (params) => {
      return this.screenshotExports.read(params);
    },
    "tool.screenshot_release": async (params) => {
      return this.screenshotExports.release(params);
    },
    "tool.screenshot": async (params, { signal, cdp }) => {
      return handleScreenshot(
        this.sessions,
        params,
        {
          ...(cdp ? { cdp } : {}),
          tabsApi: chromeTabsCaptureApi,
          captureApi: chromeTabsCaptureApi,
        },
        signal,
      );
    },
    "tool.console": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "console requires CDP" };
      return handleConsole(this.sessions, params, { cdp, tabsApi: chromeTabsApi }, signal);
    },
    "tool.network": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "network requires CDP" };
      return handleNetwork(this.sessions, params, { cdp, tabsApi: chromeTabsApi }, signal);
    },
    "tool.snapshot": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "snapshot requires CDP" };
      return this.withHoverReassert(
        params,
        () => handleSnapshot(this.sessions, params, { cdp, tabsApi: chromeTabsCaptureApi }, signal),
        {},
        signal,
      );
    },
    "tool.observe": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "observe requires CDP" };
      const hoverScope = await this.resolveHoverLatchScope(params);
      throwIfDispatchAborted(signal);
      return this.withHoverReassert(
        params,
        () =>
          handleObserve(
            this.sessions,
            params,
            {
              cdp,
              tabsApi: chromeTabsCaptureApi,
              // Active hover probing is opt-in. A held hover latch still
              // suppresses it, because probing would move the cursor off
              // the element the caller is deliberately holding.
              conditionalSurfaceProbe:
                params.probe_hover === true && !this.hasHoverLatchForScope(hoverScope),
              hoverProbeBypassOverlay: bypassOverlay,
            },
            signal,
          ),
        {},
        signal,
      );
    },
    "tool.get_html": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "get_html requires CDP" };
      return handleGetHtml(this.sessions, params, { cdp, tabsApi: chromeTabsCaptureApi }, signal);
    },
    "tool.navigate": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "navigate requires CDP" };
      return this.withHoverReleaseForRequest(
        params,
        () =>
          handleNavigate(this.sessions, params, {
            cdp,
            tabsApi: chromeTabsApi,
            signal,
            backgroundExecution: true,
          }),
        signal,
      );
    },
    "tool.navigate_back": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "navigate_back requires CDP" };
      return this.withHoverReleaseForRequest(
        params,
        () =>
          handleNavigateBack(this.sessions, params, {
            cdp,
            tabsApi: chromeTabsApi,
            signal,
            backgroundExecution: true,
          }),
        signal,
      );
    },
    "tool.navigate_forward": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "navigate_forward requires CDP" };
      return this.withHoverReleaseForRequest(
        params,
        () =>
          handleNavigateForward(this.sessions, params, {
            cdp,
            tabsApi: chromeTabsApi,
            signal,
            backgroundExecution: true,
          }),
        signal,
      );
    },
    "tool.reload": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "reload requires CDP" };
      return this.withHoverReleaseForRequest(
        params,
        () =>
          handleReload(this.sessions, params, {
            cdp,
            tabsApi: chromeTabsApi,
            signal,
            backgroundExecution: true,
          }),
        signal,
      );
    },
    "tool.click": async (params, { signal, onInputSent, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "click requires CDP" };
      return this.withHoverReassert(
        params,
        () =>
          handleClick(this.sessions, params, {
            cdp,
            tabsApi: chromeTabsApi,
            signal,
            bypassOverlay,
            onInputSent,
          }),
        { releaseAfter: true },
        signal,
      );
    },
    "tool.hover": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "hover requires CDP" };
      const result = await handleHover(this.sessions, params, {
        cdp,
        tabsApi: chromeTabsApi,
        signal,
        bypassOverlay: (tabId, enabled) => this.setHoverBypass(params.session_id, tabId, enabled),
        keepOverlayBypassAfterHover: true,
      });
      return this.rememberHover(params.session_id, result);
    },
    "tool.drag": async (params, { signal, onInputSent, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "drag requires CDP" };
      return this.withHoverReassert(
        params,
        () =>
          handleDrag(this.sessions, params, {
            cdp,
            tabsApi: chromeTabsApi,
            signal,
            bypassOverlay,
            onInputSent,
          }),
        { releaseAfter: true },
        signal,
      );
    },
    "tool.wheel": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "wheel requires CDP" };
      return this.withHoverReassert(
        params,
        () =>
          handleWheel(this.sessions, params, {
            cdp,
            tabsApi: chromeTabsApi,
            signal,
            bypassOverlay,
          }),
        { releaseAfter: true },
        signal,
      );
    },
    "tool.scroll_to": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "scroll_to requires CDP" };
      return this.withHoverReleaseForRequest(
        params,
        () => handleScrollTo(this.sessions, params, { cdp, tabsApi: chromeTabsApi, signal }),
        signal,
      );
    },
    "tool.focus": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "focus requires CDP" };
      return this.withHoverReleaseForRequest(
        params,
        () => handleFocus(this.sessions, params, { cdp, tabsApi: chromeTabsApi, signal }),
        signal,
      );
    },
    "tool.blur": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "blur requires CDP" };
      return this.withHoverReleaseForRequest(
        params,
        () => handleBlur(this.sessions, params, { cdp, tabsApi: chromeTabsApi, signal }),
        signal,
      );
    },
    "tool.fill": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "fill requires CDP" };
      return this.withHoverReleaseForRequest(
        params,
        () => handleFill(this.sessions, params, { cdp, tabsApi: chromeTabsApi, signal }),
        signal,
      );
    },
    "tool.press": async (params, { signal, onInputSent, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "press requires CDP" };
      return this.withHoverReleaseForRequest(
        params,
        () =>
          handlePress(this.sessions, params, {
            cdp,
            tabsApi: chromeTabsApi,
            signal,
            onInputSent,
          }),
        signal,
      );
    },
    "tool.select": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "select requires CDP" };
      return this.withHoverReleaseForRequest(
        params,
        () => handleSelect(this.sessions, params, { cdp, tabsApi: chromeTabsApi, signal }),
        signal,
      );
    },
    "tool.upload": async (params, { signal, cdp }) => {
      return this.withHoverReleaseForRequest(
        params,
        () =>
          cdp
            ? handleUpload(this.sessions, params, {
                cdp,
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
    "tool.download": async (params, { signal, cdp, completionSignal }) => {
      return this.withHoverReleaseForRequest(
        params,
        () =>
          cdp
            ? handleDownload(this.sessions, params, {
                cdp,
                tabsApi: chromeTabsApi,
                signal,
                completionSignal,
                bypassOverlay,
              })
            : Promise.resolve({
                code: "unsupported",
                message: "download requires CDP",
              } satisfies RpcError),
        signal,
      );
    },
    "tool.evaluate": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "evaluate requires CDP" };
      return handleEvaluate(this.sessions, params, { cdp, tabsApi: chromeTabsApi, signal });
    },
    "tool.wait_for_navigation": async (params, { signal, cdp }) => {
      if (!cdp) return { code: "unsupported", message: "wait_for_navigation requires CDP" };
      return handleWaitForNavigation(this.sessions, params, {
        cdp,
        tabsApi: chromeTabsApi,
        signal,
      });
    },
    "tool.request_help": async (params, { signal, cdp }) => {
      return handleRequestHelp(this.sessions, params, {
        preferences: this.interactionPreferences,
        tabsApi: chromeTabsApi,
        windows: { update: (id, info) => chrome.windows.update(id, info) },
        activateTab: async (tabId) => {
          await chrome.tabs.update(tabId, { active: true });
        },
        sendToTab: (tabId, msg) => chrome.tabs.sendMessage(tabId, msg),
        ...(cdp ? { cdp } : {}),
        notifications: makeHelpNotifications(),
        notificationCopy: this.helpNotificationCopy?.(),
        signal,
      });
    },
    "tool.record_start": async (params, { signal, cdp }) => {
      const release = this.video?.reserveActionRecording(params.session_id);
      if (this.video && !release)
        return {
          code: "invalid_params",
          message: "Stop video recording before starting action recording",
        };
      const started = this.recording
        ? handleRecordStart(this.sessions, params, {
            ...(cdp ? { cdp } : {}),
            ...this.recording,
            signal,
          })
        : Promise.resolve(recordingRuntimeUnavailable());
      return release ? started.finally(release) : started;
    },
    "tool.record_stop": async (params, { signal, cdp }) => {
      return this.recording
        ? handleRecordStop(this.sessions, params, {
            ...(cdp ? { cdp } : {}),
            ...this.recording,
            signal,
          })
        : recordingRuntimeUnavailable();
    },
    "tool.record_await": async (params, { signal, cdp }) => {
      return this.recording
        ? handleRecordAwait(this.sessions, params, {
            ...(cdp ? { cdp } : {}),
            ...this.recording,
            signal,
          })
        : recordingRuntimeUnavailable();
    },
  };

  private pendingForSession(sessionId: string) {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return undefined;
    return this.cdp
      ?.pendingDialogs?.()
      .find((dialog) => this.sessions.findControllingSession(dialog.tab_id) === sessionId);
  }

  private dismissOperationDialogs(request: RequestFrame): void {
    const sessionId = (request.params as { session_id?: string } | undefined)?.session_id;
    if (!sessionId) return;
    for (const dialog of this.cdp?.pendingDialogs?.() ?? []) {
      if (this.sessions.findControllingSession(dialog.tab_id) === sessionId)
        void this.cdp?.resolveDialog?.(dialog.id, false).catch(() => {});
    }
  }

  /** Teardown must also dismiss dialogs opened after their initiating action
   * returned, including a chained dialog resumed by the first dismissal. */
  private withDialogCleanup(sessionId: string, stop: () => Promise<unknown>): Promise<unknown> {
    const owned = (tabId: number) => this.sessions.findControllingSession(tabId) === sessionId;
    const dismiss = (id: string) => this.cdp?.resolveDialog?.(id, false).catch(() => {});
    const subscription = this.cdp?.onDialogChanged?.((tabId, dialog) => {
      if (dialog && owned(tabId)) void dismiss(dialog.id);
    });
    const pending = (this.cdp?.pendingDialogs?.() ?? []).filter((dialog) => owned(dialog.tab_id));
    if (!subscription && pending.length === 0) return stop();
    return (async () => {
      try {
        await Promise.all(pending.map((dialog) => dismiss(dialog.id)));
        return await stop();
      } finally {
        subscription?.dispose();
      }
    })();
  }

  private getBorrowApprover(): BorrowConfirmationApprover | undefined {
    if (this.approveBorrow) return this.approveBorrow;
    if (!this.interactionPreferences) return undefined;
    return async () => {
      await this.interactionPreferences!.readyOrFallback();
      if (!this.interactionPreferences!.get().confirmTabBorrow) return true;
      return rpcError(
        "permission_denied",
        "confirmation_ui_unavailable",
        "Borrow confirmation is unavailable",
      );
    };
  }

  private canAutoBorrowForRequest(req: RequestFrame, session: SessionContext): boolean {
    if (req.method === "tool.cooperate") {
      const params = req.params as { action?: string; control_policy?: string } | undefined;
      const action = params?.action;
      if (action !== "sync" && action !== "enable") return false;
      if (params?.control_policy !== undefined) {
        if (!["auto", "strict", "target"].includes(params.control_policy)) return false;
        const requestedPolicy =
          params.control_policy === "auto"
            ? (session.controlPolicy ?? "target")
            : params.control_policy;
        if (requestedPolicy && session.controlPolicy && requestedPolicy !== session.controlPolicy) {
          return false;
        }
      }
      return true;
    }
    if (req.method === "tool.tab_select") return true;
    if (!this.cooperation) {
      return (
        Boolean(toolPolicy(req.method)?.autoBorrowWrite) ||
        (req.method === "tool.observe" &&
          (req.params as { probe_hover?: boolean } | undefined)?.probe_hover === true)
      );
    }
    return false;
  }

  private tryStartAutoBorrow(
    req: RequestFrame,
    signal: AbortSignal,
  ): Promise<{ borrowed: TabBorrowResult } | { error: RpcError } | null> | null {
    if (!this.interactionPreferences) return null;
    const params = req.params as { session_id?: string; tab_id?: number } | undefined;
    const sessionId = params?.session_id;
    const tabId = params?.tab_id;
    if (
      typeof sessionId !== "string" ||
      typeof tabId !== "number" ||
      !Number.isSafeInteger(tabId) ||
      tabId <= 0
    ) {
      return null;
    }
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      session.remote ||
      session.incognito ||
      isAgentControlledTab(session, tabId) ||
      !this.canAutoBorrowForRequest(req, session)
    ) {
      return null;
    }
    if (
      this.sessions.findControllingSession(tabId) !== null ||
      this.sessions.findBorrowingSession(tabId, null) !== null
    ) {
      return null;
    }
    return this.executeAutoBorrow(req, sessionId, tabId, signal);
  }

  private async executeAutoBorrow(
    req: RequestFrame,
    sessionId: string,
    tabId: number,
    signal: AbortSignal,
  ): Promise<{ borrowed: TabBorrowResult } | { error: RpcError } | null> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.interactionPreferences || !this.canAutoBorrowForRequest(req, session)) {
      return null;
    }
    await this.interactionPreferences.readyOrFallback();
    if (
      signal.aborted ||
      this.interactionPreferences.get().confirmTabBorrow ||
      !this.canAutoBorrowForRequest(req, session)
    ) {
      return null;
    }
    let tab: chrome.tabs.Tab;
    try {
      tab = await chromeTabsApi.get(tabId);
    } catch {
      return null;
    }
    if (
      tab.incognito ||
      typeof tab.windowId !== "number" ||
      tab.windowId === session.agentWindowId ||
      this.sessions.findByWindowId(tab.windowId) !== null
    ) {
      return null;
    }
    if (
      req.method === "tool.cooperate" &&
      (req.params as { action?: string } | undefined)?.action === "sync" &&
      cdpBlockedUrlReason(tab.url)
    ) {
      return null;
    }
    const borrowReq: ToolRequest<"tool.tab_borrow"> = {
      id: `${req.id}:auto_borrow`,
      method: "tool.tab_borrow",
      params: { session_id: sessionId, tab_id: tabId },
    };
    const sessionCdp = this.cdpForSession(sessionId);
    const runBorrow = (cdp = sessionCdp, opSignal = signal) =>
      this.invokeTool(borrowReq, opSignal, undefined, cdp);
    const borrowResult = await (this.cooperation && sessionCdp
      ? this.cooperation.run(borrowReq, sessionCdp, signal, runBorrow)
      : runBorrow());
    if (isRpcError(borrowResult)) return { error: borrowResult };
    return { borrowed: borrowResult as TabBorrowResult };
  }

  private cdpForSession(sessionId: string | undefined): DispatcherCdpRunner | undefined {
    if (!this.cdp || !sessionId) return this.cdp;
    return sessionCdpRunner(this.cdp, sessionId, () => this.sessions.has(sessionId));
  }

  private invoke(
    req: ToolRequest,
    signal: AbortSignal,
    onInputSent?: (tabId: number) => void,
  ): Promise<unknown> {
    const rawSessionId = (req.params as { session_id?: unknown } | undefined)?.session_id;
    const sessionId =
      typeof rawSessionId === "string" &&
      rawSessionId.length > 0 &&
      req.method !== "tool.session_start" &&
      req.method !== "tool.session_stop"
        ? rawSessionId
        : undefined;
    const sessionCdp = this.cdpForSession(sessionId);
    const run = (cdp = sessionCdp, operationSignal = signal, completionSignal = operationSignal) =>
      this.invokeTool(req, operationSignal, onInputSent, cdp, completionSignal);
    // Modal control uses cached authority checks, without blocked renderer preparation.
    if (TOOL_POLICIES[req.method].cooperation === "dialog") return run();
    const dispatchMain = (): Promise<unknown> => {
      if (req.method === "tool.cooperate" && this.cooperation && sessionCdp) {
        const cdp = sessionCdp;
        return this.releaseHoverLatch((req.params as { session_id: string }).session_id).then(() =>
          this.cooperation!.run(req, cdp, signal, run),
        );
      }
      return this.cooperation && sessionCdp
        ? this.cooperation.run(req, sessionCdp, signal, run)
        : run();
    };
    const autoBorrow = this.tryStartAutoBorrow(req, signal);
    if (!autoBorrow) return dispatchMain();
    return autoBorrow.then((outcome) => {
      if (outcome && "error" in outcome) return outcome.error;
      if (outcome && "borrowed" in outcome && req.method === "tool.tab_select") {
        return {
          tab_id: outcome.borrowed.tab_id,
          window_id: outcome.borrowed.agent_window_id,
        };
      }
      return dispatchMain();
    });
  }

  private async invokeTool<M extends ExtensionToolMethod>(
    req: ToolRequest<M>,
    signal: AbortSignal,
    onInputSent?: (tabId: number) => void,
    cdp = this.cdp,
    completionSignal = signal,
  ): Promise<ResultOf<M> | RpcError> {
    const sessionId = (req.params as { session_id?: string }).session_id;
    if (
      sessionId &&
      this.sessions.get(sessionId)?.remote &&
      !TOOL_POLICIES[req.method].remoteAllowed
    ) {
      return {
        code: "unsupported",
        message: "Remote connections do not support upload or download",
      };
    }
    const preparationError = await prepareBackgroundExecution(
      this.sessions,
      req,
      cdp,
      chromeTabsApi,
      signal,
    );
    if (preparationError) return preparationError;

    return this.handlers[req.method](req.params, { signal, onInputSent, cdp, completionSignal });
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
    if (scope.tab_id !== undefined && this.cooperation?.enabled(scope.tab_id)) return work();
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
        this.cdpForSession(latch.sessionId)!
          .send(latch.tabId, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: latch.x,
            y: latch.y,
          })
          .catch((err) => {
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
  return resumesBrowserControl(req.method, req.params) && "session_id" in req.params
    ? (req.params.session_id ?? null)
    : null;
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
