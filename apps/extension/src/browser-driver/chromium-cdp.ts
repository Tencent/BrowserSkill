// Chromium `BrowserDriver` implementation. Wraps `chrome.debugger.*`
// so each tool implementation can think in terms of typed `send<T>`
// calls and a single attach-once-per-tab cache.
//
// Lifecycle notes:
// * `chrome.debugger.attach()` will fail with "Another debugger is
//   already attached" if invoked twice for the same tab — we track
//   attachments in `attachedTabs` to coalesce. The CDP protocol
//   version pinned here ("1.3") matches what intern uses and what
//   Playwright targets for stable Chrome / Edge / Brave.
// * Closing a tab implicitly detaches; we do not race-clean here.
//   Higher-level code calls `detach()` explicitly when a session
//   stops to keep the "Agent controlling — DevTools" infobar visible
//   only while we actually need it.
// * MV3 service workers can be evicted mid-call. The wrapper
//   propagates `chrome.runtime.lastError` as a thrown Error so
//   callers can decide whether to retry vs. surface an `cdp_failed`.
// * Native JS dialogs (`alert` / `confirm` / `prompt` / `beforeunload`)
//   block CDP until dismissed. We listen for `Page.javascriptDialogOpening`,
//   retain pending state until an explicit agent decision, and record the
//   actual closing event for tool results.

import type {
  ConsoleEntry,
  ConsoleEntryKind,
  ConsoleResult,
  ConsoleStackFrame,
  JavaScriptDialogInfo,
  JavaScriptDialogType,
  NetworkEntry,
  NetworkEntryKind,
  NetworkResult,
  PendingJavaScriptDialog,
} from "@/transport/types";
import { BackgroundExecution } from "./background-execution";
import { CdpReadGate, CdpReadTimeoutError, READ_TIMEOUT_MS } from "./command-deadline";
import {
  buildFrameGraph,
  type CdpFrameGraph,
  type CdpFrameTreeNode,
  type CdpFrameTreeSource,
  type CdpTarget,
  omitFrameSubtrees,
} from "./frame-graph";
import { NativeInputClock } from "./native-input-clock";
import { sampleNativeInputClock } from "./native-input-probe";

export type CdpDebuggee = chrome.debugger.Debuggee & { sessionId?: string };

/** Guards checked at native dispatch, after any asynchronous connection setup. */
export interface CdpDispatchGuard {
  signal?: AbortSignal;
  /** Only use this live attachment; never reconnect a cleanup command. */
  attachmentId?: string;
  /** Called immediately before native send, never for a cancelled or stale command. */
  onDispatch?(): void;
}

/**
 * Minimal slice of `chrome.debugger` the rest of the extension
 * depends on. Stays as an explicit interface so vitest can inject a
 * fake without monkey-patching the real `chrome` global.
 */
export interface CdpDebuggerApi {
  attach(target: CdpDebuggee, requiredVersion: string): Promise<void>;
  detach(target: CdpDebuggee): Promise<void>;
  sendCommand(target: CdpDebuggee, method: string, commandParams?: object): Promise<unknown>;
  getTargets?(): Promise<chrome.debugger.TargetInfo[]>;
  /**
   * Fires for every CDP event (`Page.lifecycleEvent`, `DOM.documentUpdated`,
   * …). The first callback argument is the source debuggee; the second
   * is the CDP method name; the third is the payload.
   */
  onEvent: chrome.events.Event<(source: CdpDebuggee, method: string, params: unknown) => void>;
  /**
   * Fires when Chrome unilaterally detaches us — most commonly because
   * the tab navigated to a chrome:// URL or the user clicked
   * "Cancel debugging" on the system infobar.
   */
  onDetach: chrome.events.Event<(source: chrome.debugger.Debuggee, reason: string) => void>;
}

/**
 * Production-backed [`CdpDebuggerApi`]. `onEvent` / `onDetach` are
 * exposed as getters so the *module* loads in vitest (where `chrome`
 * is undefined) — the actual property access only fires when a real
 * caller wires the driver in `background.ts`.
 */
export const chromeDebuggerApi: CdpDebuggerApi = {
  attach: (target, version) => chrome.debugger.attach(target, version),
  detach: (target) => chrome.debugger.detach(target),
  sendCommand: (target, method, commandParams) =>
    chrome.debugger.sendCommand(target, method, commandParams),
  getTargets: () => chrome.debugger.getTargets(),
  get onEvent() {
    return chrome.debugger.onEvent;
  },
  get onDetach() {
    return chrome.debugger.onDetach;
  },
};

export const CDP_PROTOCOL_VERSION = "1.3";

/** Per-tab monotonic sequence returned by [`ChromiumCdp.dialogCursor`]. */
export type DialogCursor = number;

/** CDP `Emulation.setDeviceMetricsOverride` payload. */
export interface DeviceMetricsOverride {
  width: number;
  height: number;
  /** `0` asks Chrome to use the display's native factor. */
  deviceScaleFactor: number;
  mobile: boolean;
}

/** CDP `Emulation.setUserAgentOverride` payload. */
export interface UserAgentOverride {
  userAgent: string;
  acceptLanguage?: string;
  /** CDP `Emulation.UserAgentMetadata` (already camelCase). */
  userAgentMetadata?: Record<string, unknown>;
}

const MAX_DIALOG_BUFFER = 32;
const MAX_DIALOG_FIELD_LENGTH = 4096;
const MAX_CONSOLE_BUFFER = 200;
const MAX_CONSOLE_FIELD_LENGTH = 4096;
const MAX_CONSOLE_STACK_FRAMES = 20;
const MAX_NETWORK_BUFFER = 200;
const MAX_NETWORK_FIELD_LENGTH = 4096;
const MAX_NETWORK_REQUEST_META = 1024;
const FRAME_DISCOVERY_TIMEOUT_MS = 1000;
const FRAME_DISCOVERY_QUIET_MS = 20;

interface ParsedDialogOpening {
  type: JavaScriptDialogType;
  message: string;
  url?: string;
  defaultPrompt?: string;
  hasBrowserHandler?: boolean;
}

interface ParsedConsoleEntry extends Omit<ConsoleEntry, "sequence"> {}

interface ParsedNetworkEntry extends Omit<NetworkEntry, "sequence"> {}

/** Bounded request metadata remembered from `requestWillBeSent`. */
interface NetworkRequestMeta {
  url: string;
  method?: string;
  resourceType?: string;
  truncated: boolean;
}

interface FrameDiscoveryState {
  rootFrameId?: string;
  sessions: Set<string>;
  pending: Set<Promise<void>>;
  generation: number;
  enabled: Map<string, Promise<void>>;
  frameIds: Map<string, string>;
  loaderIds: Map<string, string>;
  frameUrls: Map<string, string>;
}

async function settleBeforeDeadline(promises: Promise<void>[], deadline: number): Promise<boolean> {
  if (promises.length === 0) return true;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    Promise.allSettled(promises).then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), remaining);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return !timedOut;
}

export const DEFAULT_IDLE_DETACH_MS = 75_000;

export interface ChromiumCdpOptions {
  /** CDP observation alone does not authorize dismissing user dialogs. */
  canControlDialog?: (tabId: number) => boolean | Promise<boolean>;
  /** Invalidate tab refs when the root document or debugger attachment changes. */
  onDocumentChanged?: (tabId: number) => void;
  /** Notify tab observers when child OOPIF sessions are remapped across idle soft-detach. */
  onChildFramesRemapped?: (tabId: number, remapped: ReadonlyMap<string, string>) => void;
  /** Invalidate child-frame refs when OOPIF targets disappear or navigate across idle soft-detach. */
  onChildFramesInvalidated?: (
    tabId: number,
    stale: { sessionIds: ReadonlySet<string>; frameIds: ReadonlySet<string> },
  ) => void;
  /** Notify tab observers when `chrome.debugger` soft-detaches on idle without replacing the document. */
  onSoftDetached?: (tabId: number) => void;
  /**
   * Sliding idle duration (ms) before soft-detaching `chrome.debugger` from a
   * tab when all safety guards pass. Defaults to `75_000` when wired to the
   * production `chromeDebuggerApi` (or `0` when an injected test `CdpDebuggerApi`
   * omits `idleDetachMs`); `<= 0` disables it.
   */
  idleDetachMs?: number;
}

interface EmulationDomainState {
  deviceMetrics: boolean;
  userAgent: boolean;
  touch: boolean;
}

interface RootDocumentSignature {
  probed: boolean;
  dialogOpen?: boolean;
  frameId?: string;
  loaderId?: string;
  url?: string;
  urlFragment?: string;
  backendNodeId?: number;
  documentElementBackendNodeId?: number;
  documentUrl?: string;
}

interface ChildFrameSignature {
  sessionId: string;
  frameId?: string;
  loaderId?: string;
  url?: string;
  urlFragment?: string;
}

function sameRootDocumentSignature(
  before: RootDocumentSignature | undefined,
  after: RootDocumentSignature,
): boolean {
  if (!before || !before.probed || !after.probed) return false;
  const sameFrame =
    before.frameId === after.frameId &&
    before.loaderId === after.loaderId &&
    before.url === after.url &&
    before.urlFragment === after.urlFragment;
  if (!sameFrame) return false;
  if (after.dialogOpen) {
    const hasFrameIdentity =
      after.frameId !== undefined || after.loaderId !== undefined || after.url !== undefined;
    return (
      hasFrameIdentity || (before.backendNodeId === undefined && before.documentUrl === undefined)
    );
  }
  return (
    before.backendNodeId === after.backendNodeId &&
    before.documentElementBackendNodeId === after.documentElementBackendNodeId &&
    before.documentUrl === after.documentUrl
  );
}

function sameChildFrameSignature(
  before: ChildFrameSignature,
  after: ChildFrameSignature | undefined,
): after is ChildFrameSignature {
  if (!after || !before.frameId || before.frameId !== after.frameId) return false;
  if (!before.loaderId || !after.loaderId) return false;
  return (
    before.loaderId === after.loaderId &&
    before.url === after.url &&
    before.urlFragment === after.urlFragment
  );
}

const MAX_REMAPPED_CHILD_SESSIONS = 256;

/**
 * Wrapper around `chrome.debugger` that owns the "attach once per
 * tabId" cache and exposes typed `send<T>()`.
 */
export class ChromiumCdp {
  private readonly api: CdpDebuggerApi;
  private readonly inputClock = new NativeInputClock(() => sampleNativeInputClock(this.api));
  private readonly readGate = new CdpReadGate();
  private readonly attachedTabs = new Set<number>();
  private readonly softDetachedTabs = new Set<number>();
  private readonly softDetachedDocSignatures = new Map<number, RootDocumentSignature>();
  private readonly softDetachedAttachmentIds = new Map<number, string>();
  private readonly softDetachedFrameSessions = new Map<number, Map<string, ChildFrameSignature>>();
  private readonly remappedChildSessions = new Map<number, Map<string, string>>();
  private readonly retainedAttachments = new Map<number, Set<object>>();
  private readonly unverifiedDialogDocSignatures = new Map<
    number,
    { attachmentId: string; expected: RootDocumentSignature }
  >();
  private readonly postDialogVerifications = new Map<number, Promise<void>>();
  private readonly claimAttempts = new Map<number, Map<string, object>>();
  private readonly attachmentVersions = new Map<number, number>();
  private readonly attachmentIds = new Map<number, string>();
  private readonly attachingIds = new Map<number, string>();
  private readonly attachInFlight = new Map<number, Promise<void>>();
  private readonly detachInFlight = new Map<number, Promise<void>>();
  private readonly inFlightCommands = new Map<number, number>();
  private readonly idleTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly activeEmulationTabs = new Map<number, EmulationDomainState>();
  private readonly backgroundExecution = new BackgroundExecution(
    (tabId) => this.attachmentIds.get(tabId),
    (tabId, enabled) =>
      this.runTrackedSendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled }),
  );
  private readonly tabOwners = new Map<number, Set<string>>();
  private syncGeneration = 0;
  private readonly pendingDialogEntries = new Map<
    number,
    {
      dialog: PendingJavaScriptDialog;
      attachmentId: string;
      defaultPrompt?: string;
      hasBrowserHandler?: boolean;
      source: CdpDebuggee;
      resolving: boolean;
      emitOnAttach?: boolean;
      timer: ReturnType<typeof setTimeout>;
      closed: Set<(result: JavaScriptDialogInfo | Error) => void>;
    }
  >();
  private readonly dialogOpeningInFlight = new Map<number, Promise<void>>();
  private readonly dialogGenerations = new Map<number, number>();
  private readonly dialogListeners = new Set<
    (tabId: number, dialog: PendingJavaScriptDialog | null, reason?: "decision_timeout") => void
  >();
  private readonly dialogBuffers = new Map<number, JavaScriptDialogInfo[]>();
  private readonly dialogSequences = new Map<number, number>();
  private readonly consoleBuffers = new Map<number, ConsoleEntry[]>();
  private readonly consoleSequences = new Map<number, number>();
  private readonly consoleDomainsEnabledTabs = new Map<number, string>();
  private readonly activeConsoleCaptureTabs = new Set<number>();
  private readonly networkBuffers = new Map<number, NetworkEntry[]>();
  private readonly networkSequences = new Map<number, number>();
  private readonly networkDomainsEnabledTabs = new Set<number>();
  private readonly passiveNetworkEnabledTabs = new Set<number>();
  private readonly networkRequestMeta = new Map<number, Map<string, NetworkRequestMeta>>();
  private readonly frameDiscovery = new Map<number, FrameDiscoveryState>();
  private detachSubscription: { dispose(): void } | null = null;
  private dialogSubscription: { dispose(): void } | null = null;
  private consoleSubscription: { dispose(): void } | null = null;
  private networkSubscription: { dispose(): void } | null = null;
  private frameTargetSubscription: { dispose(): void } | null = null;

  constructor(
    api: CdpDebuggerApi = chromeDebuggerApi,
    private readonly options: ChromiumCdpOptions = {},
  ) {
    this.api = api;
    this.bindAutoDetach();
    this.bindDialogHandler();
    this.bindConsoleHandler();
    this.bindNetworkHandler();
    this.bindFrameTargetHandler();
  }

  /** Identity of this actual debugger attachment, independent of frame topology. */
  getAttachmentId(tabId: number): string | undefined {
    return this.attachmentIds.get(tabId);
  }

  /** Map a pre-soft-detach OOPIF child `sessionId` to its current reattached `sessionId`. */
  resolveTarget<T extends CdpDebuggee>(target: T): T {
    if (typeof target.tabId !== "number" || !target.sessionId) return target;
    const remapped = this.remappedChildSessions.get(target.tabId)?.get(target.sessionId);
    if (!remapped || remapped === target.sessionId) return target;
    return { ...target, sessionId: remapped };
  }

  /** Prevent idle soft-detach while a passive CDP event operation (such as download) is active. */
  retainTabAttachment(tabId: number): () => void {
    const tokens = this.retainedAttachments.get(tabId) ?? new Set<object>();
    const token = {};
    tokens.add(token);
    this.retainedAttachments.set(tabId, tokens);
    this.clearIdleTimer(tabId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.retainedAttachments.get(tabId);
      current?.delete(token);
      if (current && current.size === 0) {
        this.retainedAttachments.delete(tabId);
      }
      if (this.attachedTabs.has(tabId)) {
        this.touchTabActivity(tabId);
      }
    };
  }

  /** Reattach `tabId` only when it was previously idle-soft-detached; never reconnects hard-detached tabs. */
  async reattachIfSoftDetached(tabId: number): Promise<void> {
    const attaching = this.attachInFlight.get(tabId);
    if (attaching) await attaching;
    const verifying = this.postDialogVerifications.get(tabId);
    if (verifying) await cleanupWait(verifying.catch(() => {}));
    if (!this.softDetachedTabs.has(tabId)) return;
    await this.ensureAttached(tabId);
  }

  /** Reattach a soft-detached tab that had tracked OOPIFs so `sync` reconciles child-frame sessions. */
  async reconcileSoftDetachedFrames(tabId: number): Promise<void> {
    const attaching = this.attachInFlight.get(tabId);
    if (attaching) await attaching;
    const verifying = this.postDialogVerifications.get(tabId);
    if (verifying) await cleanupWait(verifying.catch(() => {}));
    if (
      !this.softDetachedTabs.has(tabId) ||
      (this.softDetachedFrameSessions.get(tabId)?.size ?? 0) === 0
    ) {
      return;
    }
    await this.ensureAttached(tabId);
  }

  prepareInputTimestamp() {
    return this.inputClock.prepare();
  }

  /** Attach to `tabId` if we haven't already in this driver. */
  async ensureAttached(tabId: number): Promise<void> {
    await this.ensureRawAttached(tabId);
    await this.backgroundExecution.synchronize(tabId);
    this.touchTabActivity(tabId);
  }

  /** `CdpRunner` entry point used by passive read/extract/observation tools. */
  async ensureAttachedToUrl(tabId: number, _expectedUrl?: string): Promise<void> {
    await this.ensureAttached(tabId);
  }

  /** Only explicit automation control may retain the focus/visibility override. */
  async acquireBackgroundExecution(sessionId: string, tabId: number): Promise<void> {
    const attempts = this.claimAttempts.get(tabId) ?? new Map<string, object>();
    const attempt = {};
    attempts.set(sessionId, attempt);
    this.claimAttempts.set(tabId, attempts);
    const retained = this.backgroundExecution.has(sessionId, tabId);
    this.trackSessionTab(sessionId, tabId);
    this.backgroundExecution.retain(sessionId, tabId);
    try {
      await this.ensureAttached(tabId);
      if (!this.backgroundExecution.has(sessionId, tabId)) {
        throw new Error("Background execution was released during setup");
      }
    } catch (error) {
      if (!retained && this.claimAttempts.get(tabId)?.get(sessionId) === attempt) {
        this.claimAttempts.get(tabId)?.delete(sessionId);
        this.backgroundExecution.release(sessionId, tabId);
        await cleanupWait(this.backgroundExecution.synchronize(tabId)).catch(() => {});
      }
      throw error;
    }
  }

  /** True when this session owns the persistent focus/visibility override for the tab. */
  ownsBackgroundExecution(sessionId: string, tabId: number): boolean {
    return this.backgroundExecution.has(sessionId, tabId);
  }

  /** Shared tabs retain debugger ownership but relinquish persistent focus emulation. */
  async releaseBackgroundExecution(sessionId: string, tabId: number): Promise<void> {
    this.backgroundExecution.release(sessionId, tabId);
    await this.backgroundExecution.synchronize(tabId);
    this.touchTabActivity(tabId);
  }

  /** Resend this session's override when Chrome lost it without clearing the applied-state cache. */
  async restoreBackgroundExecution(sessionId: string, tabId: number): Promise<void> {
    if (!this.backgroundExecution.has(sessionId, tabId))
      throw new Error("Background execution is not owned by this session");
    await this.ensureRawAttached(tabId);
    await this.backgroundExecution.reapply(tabId);
    if (!this.backgroundExecution.has(sessionId, tabId))
      throw new Error("Background execution was released during restore");
    this.touchTabActivity(tabId);
  }

  private async ensureRawAttached(tabId: number): Promise<void> {
    // Returning a tab clears the cache before Chrome finishes detaching.
    // New observers must wait before opening the next connection to that tab.
    const detaching = this.detachInFlight.get(tabId);
    if (detaching) await detaching;
    const existing = this.attachInFlight.get(tabId);
    if (existing) {
      await existing;
      const verifyingAfterAttach = this.postDialogVerifications.get(tabId);
      if (verifyingAfterAttach) await cleanupWait(verifyingAfterAttach.catch(() => {}));
      if (this.attachedTabs.has(tabId)) {
        this.touchTabActivity(tabId);
        return;
      }
    }
    const verifying = this.postDialogVerifications.get(tabId);
    if (verifying) await cleanupWait(verifying.catch(() => {}));
    if (this.attachedTabs.has(tabId)) {
      this.touchTabActivity(tabId);
      return;
    }
    const version = this.attachmentVersions.get(tabId) ?? 0;
    const wasSoftDetached = this.softDetachedTabs.has(tabId);
    const previousDocSignature = this.softDetachedDocSignatures.get(tabId);
    const previousAttachmentId = wasSoftDetached
      ? this.softDetachedAttachmentIds.get(tabId)
      : undefined;
    const previousChildFrames = wasSoftDetached
      ? this.softDetachedFrameSessions.get(tabId)
      : undefined;
    const check = () => {
      if ((this.attachmentVersions.get(tabId) ?? 0) !== version)
        throw new Error("Debugger attachment was released during setup");
    };
    const attach = (async () => {
      let currentAttachmentId =
        (wasSoftDetached ? previousAttachmentId : undefined) ?? crypto.randomUUID();
      await this.api.attach({ tabId }, CDP_PROTOCOL_VERSION);
      try {
        check();
        this.attachingIds.set(tabId, currentAttachmentId);
        await this.enablePageDomain(tabId);
        check();
        await this.enableNetworkDomainBestEffort(tabId);
        check();
        let rootDocumentUnchanged = false;
        if (wasSoftDetached) {
          const currentDocSignature = await this.probeRootDocumentSignature(tabId);
          check();
          rootDocumentUnchanged = sameRootDocumentSignature(
            previousDocSignature,
            currentDocSignature,
          );
          if (!rootDocumentUnchanged) {
            currentAttachmentId = crypto.randomUUID();
            this.attachingIds.set(tabId, currentAttachmentId);
            const pendingDialog = this.pendingDialogEntries.get(tabId);
            if (pendingDialog && pendingDialog.attachmentId === previousAttachmentId) {
              pendingDialog.attachmentId = currentAttachmentId;
            }
            this.unverifiedDialogDocSignatures.delete(tabId);
            this.remappedChildSessions.delete(tabId);
            this.options.onDocumentChanged?.(tabId);
          } else if (currentDocSignature.dialogOpen && previousDocSignature) {
            this.unverifiedDialogDocSignatures.set(tabId, {
              attachmentId: currentAttachmentId,
              expected: previousDocSignature,
            });
          } else {
            this.unverifiedDialogDocSignatures.delete(tabId);
          }
        }
        await this.enableFrameDiscovery({ tabId }).catch((err) => {
          console.debug("[bsk cdp] frame discovery unavailable", { tabId, err });
        });
        check();
        if (wasSoftDetached && rootDocumentUnchanged && previousChildFrames?.size) {
          await this.reconcileSoftDetachedChildFrames(tabId, previousChildFrames, check);
        }
        this.attachedTabs.add(tabId);
        this.attachmentIds.set(tabId, currentAttachmentId);
        this.attachingIds.delete(tabId);
        this.softDetachedTabs.delete(tabId);
        this.softDetachedDocSignatures.delete(tabId);
        this.softDetachedAttachmentIds.delete(tabId);
        this.softDetachedFrameSessions.delete(tabId);
        const pendingDialog = this.pendingDialogEntries.get(tabId);
        if (pendingDialog?.emitOnAttach) {
          pendingDialog.emitOnAttach = false;
          this.emitDialogChanged(tabId, pendingDialog.dialog);
        }
        if (!this.pendingDialogEntries.has(tabId)) {
          this.schedulePostDialogVerification(tabId);
          const verifyingNow = this.postDialogVerifications.get(tabId);
          if (verifyingNow) await cleanupWait(verifyingNow.catch(() => {}));
        }
        this.touchTabActivity(tabId);
      } catch (err) {
        // A CDP domain enable failed after the raw attach succeeded
        // (e.g. `Page.enable` rejects because the tab just navigated to
        // a chrome:// URL or the Web Store). `attachedTabs` does not yet
        // hold `tabId`, so without rolling back the debugger would stay
        // attached and the next `ensureAttached` would re-attach and hit
        // "Another debugger is already attached" forever — the tab is
        // unusable until the extension is reloaded. Detach directly
        // (`this.detach()` is a no-op here because `attachedTabs` lacks
        // the id) so the next attempt starts from a clean slate.
        this.passiveNetworkEnabledTabs.delete(tabId);
        if (this.attachingIds.get(tabId) === currentAttachmentId) {
          this.attachingIds.delete(tabId);
        }
        if (this.unverifiedDialogDocSignatures.get(tabId)?.attachmentId === currentAttachmentId) {
          this.unverifiedDialogDocSignatures.delete(tabId);
        }
        const pendingDialog = this.pendingDialogEntries.get(tabId);
        if (pendingDialog && pendingDialog.attachmentId === currentAttachmentId) {
          clearTimeout(pendingDialog.timer);
          this.pendingDialogEntries.delete(tabId);
          for (const close of pendingDialog.closed)
            close(new Error("Debugger attachment changed; dialog outcome is unknown"));
          this.emitDialogChanged(tabId, null);
        }
        if (this.attachmentIds.get(tabId) === currentAttachmentId) {
          this.attachedTabs.delete(tabId);
          this.attachmentIds.delete(tabId);
        }
        if ((this.attachmentVersions.get(tabId) ?? 0) !== version) {
          this.attachedTabs.delete(tabId);
          this.attachmentIds.delete(tabId);
          this.backgroundExecution.invalidate(tabId);
        }
        await this.api.detach({ tabId }).catch((detachErr) => {
          console.debug("[bsk cdp] rollback detach failed", { tabId, detachErr });
        });
        throw err;
      }
    })()
      .catch((err) => {
        // Chrome surfaces "Another debugger is already attached" when
        // (rare) the user opened DevTools on the same tab. Don't swallow
        // — let the caller decide how to surface it.
        throw normalizeError(err);
      })
      .finally(() => {
        if (this.attachInFlight.get(tabId) === attach) {
          this.attachingIds.delete(tabId);
          this.attachInFlight.delete(tabId);
        }
      });
    this.attachInFlight.set(tabId, attach);
    await attach;
  }

  /**
   * Send a CDP command and decode the result as `T`. Throws on any
   * `chrome.runtime.lastError`.
   */
  async send<T = unknown>(
    tabId: number,
    method: string,
    params?: object,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    await this.ensureAttached(tabId);
    signal?.throwIfAborted();
    try {
      const result = await this.command({ tabId }, method, params ?? {});
      return result as T;
    } catch (err) {
      throw normalizeError(err);
    }
  }

  async sendToTarget<T = unknown>(
    target: CdpTarget,
    method: string,
    params?: object,
    readTimeoutMs?: number,
  ): Promise<T> {
    await this.ensureAttached(target.tabId);
    try {
      return (await this.command(target, method, params ?? {}, readTimeoutMs)) as T;
    } catch (err) {
      throw normalizeError(err);
    }
  }

  async sendGuarded<T = unknown>(
    target: CdpTarget,
    method: string,
    params: object | undefined,
    guard: CdpDispatchGuard,
  ): Promise<T> {
    guard.signal?.throwIfAborted();
    if (guard.attachmentId === undefined) await this.ensureAttached(target.tabId);
    try {
      return (await this.command(target, method, params ?? {}, undefined, () => {
        guard.signal?.throwIfAborted();
        if (
          guard.attachmentId !== undefined &&
          this.getAttachmentId(target.tabId) !== guard.attachmentId
        )
          throw new Error("Debugger attachment changed before dispatch");
        guard.onDispatch?.();
      })) as T;
    } catch (err) {
      throw normalizeError(err);
    }
  }

  async getFrameGraph(tabId: number, signal?: AbortSignal): Promise<CdpFrameGraph> {
    signal?.throwIfAborted();
    await this.ensureAttached(tabId);
    const attachmentId = this.getAttachmentId(tabId);
    const check = () => {
      signal?.throwIfAborted();
      if (attachmentId === undefined || this.getAttachmentId(tabId) !== attachmentId) {
        const error = new Error("Debugger attachment changed during frame discovery");
        error.name = "CdpAttachmentChangedError";
        throw error;
      }
    };
    // Frame discovery belongs to this attachment. An old tree reply must not
    // reconnect a released tab, or continue against another reader's connection.
    const read = async <T>(
      target: CdpTarget,
      method: string,
      params: object,
      timeoutMs?: number,
    ): Promise<T> => {
      check();
      try {
        const result = await this.command(target, method, params, timeoutMs, check);
        check();
        return result as T;
      } catch (error) {
        check();
        throw error;
      }
    };
    check();
    // Ordinary configuration failures leave the graph to the root tree. A
    // timed-out read means the renderer is not answering: stop here instead of
    // queueing the tree, owner and snapshot reads behind the stuck command.
    await this.enableFrameDiscovery({ tabId }).catch(rethrowReadTimeout);
    check();
    this.retryChildFrameDiscovery(tabId);
    await this.drainFrameAttachTasks(tabId);
    check();

    const sources: CdpFrameTreeSource[] = [];
    const unavailable = new Map<string, CdpTarget>();
    const isolateChildTimeout = (error: unknown, target: CdpTarget) => {
      check();
      if (!(error instanceof CdpReadTimeoutError)) return;
      const frameId =
        target.sessionId && this.frameDiscovery.get(tabId)?.frameIds.get(target.sessionId);
      // A root timeout also gates child reads. Never mistake it for a local
      // child failure, or guess ownership when discovery has no frame identity.
      if (!frameId || frameId === sources[0]?.tree.frame.id || error.sessionId !== target.sessionId)
        throw error;
      unavailable.set(frameId, target);
    };
    const root = await read<{ frameTree?: CdpFrameTreeNode }>(
      { tabId },
      "Page.getFrameTree",
      {},
      READ_TIMEOUT_MS,
    );
    if (root.frameTree) {
      sources.push({ target: { tabId }, tree: root.frameTree });
    }

    const sessions = [...(this.frameDiscovery.get(tabId)?.sessions ?? [])];
    const childTrees = await Promise.all(
      sessions.map(async (sessionId): Promise<CdpFrameTreeSource | null> => {
        const target = { tabId, sessionId };
        try {
          const reply = await read<{ frameTree?: CdpFrameTreeNode }>(
            target,
            "Page.getFrameTree",
            {},
            READ_TIMEOUT_MS,
          );
          if (reply.frameTree) {
            const state = this.frameDiscovery.get(tabId);
            const childFrame = reply.frameTree.frame as CdpFrameTreeNode["frame"] & {
              loaderId?: string;
            };
            state?.frameIds.set(sessionId, childFrame.id);
            if (typeof childFrame.loaderId === "string") {
              state?.loaderIds.set(sessionId, childFrame.loaderId);
            }
            if (typeof childFrame.url === "string") {
              state?.frameUrls.set(sessionId, childFrame.url);
            }
          }
          return reply.frameTree ? { target, tree: reply.frameTree } : null;
        } catch (err) {
          isolateChildTimeout(err, target);
          return null;
        }
      }),
    );
    for (const source of childTrees) {
      if (source) sources.push(source);
    }

    const discovered = buildFrameGraph(sources);
    if (!discovered) throw new Error("Page.getFrameTree returned no root frame");
    const graph = omitFrameSubtrees(discovered, unavailable);
    const frameById = new Map(graph.frames.map((frame) => [frame.frameId, frame]));
    await Promise.all(
      graph.frames.map(async (frame) => {
        if (!frame.parentFrameId) return;
        const parent = frameById.get(frame.parentFrameId);
        if (!parent) return;
        try {
          const owner = await read<{ backendNodeId?: number }>(parent.target, "DOM.getFrameOwner", {
            frameId: frame.frameId,
          });
          if (owner.backendNodeId !== undefined) frame.ownerBackendNodeId = owner.backendNodeId;
        } catch (err) {
          // The frame may have navigated between tree capture and owner lookup.
          isolateChildTimeout(err, parent.target);
        }
      }),
    );
    check();
    return omitFrameSubtrees(discovered, unavailable);
  }

  /** Return a cursor marking the current dialog sequence for `tabId`. */
  dialogCursor(tabId: number): DialogCursor {
    return this.dialogSequences.get(tabId) ?? 0;
  }

  /** `Emulation.setDeviceMetricsOverride` — pin the tab's viewport metrics. */
  async setDeviceMetricsOverride(tabId: number, metrics: DeviceMetricsOverride): Promise<void> {
    await this.send(tabId, "Emulation.setDeviceMetricsOverride", { ...metrics });
  }

  /** `Emulation.clearDeviceMetricsOverride` — restore native viewport metrics. */
  async clearDeviceMetricsOverride(tabId: number): Promise<void> {
    await this.send(tabId, "Emulation.clearDeviceMetricsOverride", {});
  }

  /** `Emulation.setUserAgentOverride` — an empty `userAgent` restores the real UA. */
  async setUserAgentOverride(tabId: number, override: UserAgentOverride): Promise<void> {
    await this.send(tabId, "Emulation.setUserAgentOverride", { ...override });
  }

  /** `Emulation.setTouchEmulationEnabled`. */
  async setTouchEmulationEnabled(
    tabId: number,
    enabled: boolean,
    maxTouchPoints?: number,
  ): Promise<void> {
    await this.send(tabId, "Emulation.setTouchEmulationEnabled", {
      enabled,
      ...(maxTouchPoints !== undefined ? { maxTouchPoints } : {}),
    });
  }

  /** Dialogs observed on `tabId` with sequence strictly greater than `cursor`. */
  dialogsSince(tabId: number, cursor: DialogCursor): JavaScriptDialogInfo[] {
    const buf = this.dialogBuffers.get(tabId) ?? [];
    return buf.filter((entry) => entry.sequence > cursor);
  }

  /**
   * Enable console capture for this tab on first use. Attach leaves Runtime
   * off: while it is on, every `console.*` call builds argument previews,
   * which anti-debugging pages time to detect a debugger.
   */
  async ensureConsoleCapture(tabId: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.attachedTabs.has(tabId)) {
      await this.ensureAttached(tabId);
    }
    signal?.throwIfAborted();
    await this.enableConsoleDomains(tabId, signal);
  }

  /** Console entries observed on `tabId`, bounded for agent context safety. */
  consoleEntriesSince(
    tabId: number,
    since: number | undefined,
    limit: number,
    maxTextChars: number,
    includeStack: boolean,
  ): ConsoleResult {
    const buf = this.consoleBuffers.get(tabId) ?? [];
    const { entries, nextSince, truncated } = readBufferedEntries(
      buf,
      this.consoleSequences.get(tabId) ?? 0,
      since,
      limit,
      (entry) => projectConsoleEntry(entry, maxTextChars, includeStack),
    );
    return {
      tab_id: tabId,
      entries,
      next_since: nextSince,
      truncated,
    };
  }

  /** Ensure CDP domains for network capture are enabled for this tab. */
  async ensureNetworkCapture(tabId: number): Promise<void> {
    if (!this.attachedTabs.has(tabId)) {
      await this.ensureAttached(tabId);
    }
    await this.enableNetworkDomain(tabId);
  }

  /** Network entries observed on `tabId`, bounded for agent context safety. */
  networkEntriesSince(
    tabId: number,
    since: number | undefined,
    limit: number,
    maxTextChars: number,
  ): NetworkResult {
    const buf = this.networkBuffers.get(tabId) ?? [];
    const { entries, nextSince, truncated } = readBufferedEntries(
      buf,
      this.networkSequences.get(tabId) ?? 0,
      since,
      limit,
      (entry) => projectNetworkEntry(entry, maxTextChars),
    );
    return {
      tab_id: tabId,
      entries,
      next_since: nextSince,
      truncated,
    };
  }

  private clearSoftDetachState(tabId: number): void {
    this.softDetachedTabs.delete(tabId);
    this.softDetachedDocSignatures.delete(tabId);
    this.softDetachedAttachmentIds.delete(tabId);
    this.softDetachedFrameSessions.delete(tabId);
    this.remappedChildSessions.delete(tabId);
    this.unverifiedDialogDocSignatures.delete(tabId);
    this.postDialogVerifications.delete(tabId);
    this.attachingIds.delete(tabId);
  }

  /** Detach if attached; never throws. */
  async detach(tabId: number, expectedAttachmentId?: string): Promise<void> {
    if (expectedAttachmentId !== undefined && this.getAttachmentId(tabId) !== expectedAttachmentId)
      return;
    this.clearIdleTimer(tabId);
    this.attachmentVersions.set(tabId, (this.attachmentVersions.get(tabId) ?? 0) + 1);
    const wasAttached = this.attachedTabs.delete(tabId);
    const wasSoftDetached = this.softDetachedTabs.delete(tabId);
    const existing = this.detachInFlight.get(tabId);
    if (!wasAttached && !wasSoftDetached && !existing) {
      this.clearSoftDetachState(tabId);
      this.retainedAttachments.delete(tabId);
      this.dialogOpeningInFlight.delete(tabId);
      return;
    }
    this.clearSoftDetachState(tabId);
    this.retainedAttachments.delete(tabId);
    this.dialogOpeningInFlight.delete(tabId);
    this.attachmentIds.delete(tabId);
    if (wasAttached || wasSoftDetached) {
      this.options.onDocumentChanged?.(tabId);
    }
    this.backgroundExecution.invalidate(tabId);
    this.activeEmulationTabs.delete(tabId);
    this.clearDialogState(tabId);
    this.clearConsoleState(tabId);
    this.clearNetworkState(tabId);
    this.clearFrameState(tabId);
    if (!wasAttached) {
      if (existing) await cleanupWait(existing);
      return;
    }
    if (existing) await cleanupWait(existing);
    const detach = (async () => {
      try {
        await this.api.detach({ tabId });
      } catch (err) {
        // Tab may already be gone — Chrome auto-detaches on close. Log
        // at debug so production builds aren't noisy.
        console.debug("[bsk cdp] detach failed (likely tab already closed)", err);
      }
    })().finally(() => {
      if (this.detachInFlight.get(tabId) === detach) {
        this.detachInFlight.delete(tabId);
      }
    });
    this.detachInFlight.set(tabId, detach);
    await cleanupWait(detach);
  }

  /** True iff `ensureAttached(tabId)` has succeeded since the last detach. */
  isAttached(tabId: number): boolean {
    return this.attachedTabs.has(tabId);
  }

  /** Remember that `sessionId` used CDP on `tabId` so stop can detach it. */
  trackSessionTab(sessionId: string, tabId: number): void {
    const owners = this.tabOwners.get(tabId) ?? new Set<string>();
    owners.add(sessionId);
    this.tabOwners.set(tabId, owners);
  }

  /** Identity of the latest acquisition, including repeated use on one attachment. */
  getSessionClaimId(sessionId: string, tabId: number): object | undefined {
    return this.claimAttempts.get(tabId)?.get(sessionId);
  }

  /** Release one session's claim, preserving attachments still used by another. */
  async releaseSessionTab(
    sessionId: string,
    tabId: number,
    guard?: { ifClaim: object },
  ): Promise<void> {
    if (guard && this.getSessionClaimId(sessionId, tabId) !== guard.ifClaim) return;
    this.claimAttempts.get(tabId)?.delete(sessionId);
    this.backgroundExecution.release(sessionId, tabId);
    const owners = this.tabOwners.get(tabId);
    owners?.delete(sessionId);
    if (owners?.size === 0) this.tabOwners.delete(tabId);
    // Remove the old claim before yielding: a new acquisition must survive this
    // cleanup, including when it uses the same session id.
    const attaching = this.attachInFlight.get(tabId);
    if (attaching && !(await cleanupWait(attaching.catch(() => {})))) {
      if (!this.tabOwners.has(tabId)) await this.detach(tabId);
      return;
    }
    try {
      if (!(await cleanupWait(this.backgroundExecution.synchronize(tabId))))
        throw new Error("Background execution cleanup timed out");
    } catch (error) {
      // A failed disable must not leave a returned user page emulated just
      // because a passive reader still owns the debugger. Readers can reattach.
      await this.detach(tabId);
      throw error;
    } finally {
      if (!this.tabOwners.has(tabId)) await this.detach(tabId);
    }
  }

  /** Debug body reads must never resurrect a detached / returned tab. */
  async sendAttached<T = unknown>(
    target: CdpDebuggee & { tabId: number },
    method: string,
    params?: object,
  ): Promise<T> {
    if (!this.attachedTabs.has(target.tabId)) throw new Error("debugger detached");
    return this.runTrackedSendCommand(this.resolveTarget(target), method, params) as Promise<T>;
  }

  /** Subscribe to all CDP events. Returned disposable removes the listener. */
  onEvent(handler: (source: CdpDebuggee, method: string, params: unknown) => void): {
    dispose(): void;
  } {
    this.api.onEvent.addListener(handler);
    return {
      dispose: () => this.api.onEvent.removeListener(handler),
    };
  }

  /** Best-effort detach of every cached tab. Used on session.stop. */
  async detachAll(): Promise<void> {
    this.inputClock.invalidate();
    this.clearAllIdleTimers();
    const tabs = Array.from(this.attachedTabs);
    const softTabs = Array.from(this.softDetachedTabs);
    const inFlightDetaches = Array.from(this.detachInFlight.values());
    for (const tabId of new Set([
      ...tabs,
      ...softTabs,
      ...this.attachInFlight.keys(),
      ...this.detachInFlight.keys(),
    ]))
      this.attachmentVersions.set(tabId, (this.attachmentVersions.get(tabId) ?? 0) + 1);
    this.claimAttempts.clear();
    this.tabOwners.clear();
    this.backgroundExecution.clear();
    this.activeEmulationTabs.clear();
    this.attachedTabs.clear();
    this.softDetachedTabs.clear();
    this.softDetachedDocSignatures.clear();
    this.softDetachedAttachmentIds.clear();
    this.softDetachedFrameSessions.clear();
    this.remappedChildSessions.clear();
    this.retainedAttachments.clear();
    this.unverifiedDialogDocSignatures.clear();
    this.postDialogVerifications.clear();
    this.dialogOpeningInFlight.clear();
    this.attachingIds.clear();
    this.attachmentIds.clear();
    for (const tabId of new Set([...tabs, ...softTabs])) this.options.onDocumentChanged?.(tabId);
    for (const tabId of this.pendingDialogEntries.keys()) this.clearDialogState(tabId);
    this.dialogBuffers.clear();
    this.dialogSequences.clear();
    this.consoleBuffers.clear();
    this.consoleSequences.clear();
    this.consoleDomainsEnabledTabs.clear();
    this.activeConsoleCaptureTabs.clear();
    this.networkBuffers.clear();
    this.networkSequences.clear();
    this.networkDomainsEnabledTabs.clear();
    this.passiveNetworkEnabledTabs.clear();
    this.networkRequestMeta.clear();
    this.frameDiscovery.clear();
    this.readGate.clear();
    await Promise.all([
      ...inFlightDetaches.map((detach) => cleanupWait(detach)),
      ...tabs.map(async (tabId) => {
        try {
          await this.api.detach({ tabId });
        } catch (err) {
          console.debug("[bsk cdp] detachAll: tab already gone", { tabId, err });
        }
      }),
    ]);
  }

  private runTrackedSendCommand(
    target: CdpDebuggee,
    method: string,
    params?: object,
  ): Promise<unknown> {
    const tabId = target.tabId;
    if (typeof tabId === "number") {
      this.inFlightCommands.set(tabId, (this.inFlightCommands.get(tabId) ?? 0) + 1);
      this.touchTabActivity(tabId);
    }
    return this.api
      .sendCommand(target, method, params)
      .then((result) => {
        if (typeof tabId === "number" && !target.sessionId) {
          this.recordEmulationCommand(tabId, method, params);
        }
        return result;
      })
      .finally(() => {
        if (typeof tabId === "number") {
          const remaining = (this.inFlightCommands.get(tabId) ?? 1) - 1;
          if (remaining <= 0) this.inFlightCommands.delete(tabId);
          else this.inFlightCommands.set(tabId, remaining);
          if (this.attachedTabs.has(tabId)) {
            this.touchTabActivity(tabId);
          }
        }
      });
  }

  private recordEmulationCommand(tabId: number, method: string, params?: object): void {
    const raw = (params ?? {}) as Record<string, unknown>;
    const current = this.activeEmulationTabs.get(tabId) ?? {
      deviceMetrics: false,
      userAgent: false,
      touch: false,
    };
    let touched = false;
    switch (method) {
      case "Emulation.setDeviceMetricsOverride":
        current.deviceMetrics = true;
        touched = true;
        break;
      case "Emulation.clearDeviceMetricsOverride":
        current.deviceMetrics = false;
        touched = true;
        break;
      case "Emulation.setUserAgentOverride":
        current.userAgent = typeof raw.userAgent === "string" && raw.userAgent.length > 0;
        touched = true;
        break;
      case "Emulation.setTouchEmulationEnabled":
        current.touch = raw.enabled === true;
        touched = true;
        break;
    }
    if (!touched) return;
    if (current.deviceMetrics || current.userAgent || current.touch) {
      this.activeEmulationTabs.set(tabId, current);
    } else {
      this.activeEmulationTabs.delete(tabId);
    }
  }

  private hasActiveEmulation(tabId: number): boolean {
    const state = this.activeEmulationTabs.get(tabId);
    return Boolean(state && (state.deviceMetrics || state.userAgent || state.touch));
  }

  private idleDetachDelayMs(): number {
    if (this.options.idleDetachMs !== undefined) return this.options.idleDetachMs;
    return this.api === chromeDebuggerApi ? DEFAULT_IDLE_DETACH_MS : 0;
  }

  private clearIdleTimer(tabId: number): void {
    const existing = this.idleTimers.get(tabId);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.idleTimers.delete(tabId);
    }
  }

  private clearAllIdleTimers(): void {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
  }

  private touchTabActivity(tabId: number): void {
    this.clearIdleTimer(tabId);
    const delayMs = this.idleDetachDelayMs();
    if (
      delayMs <= 0 ||
      !this.attachedTabs.has(tabId) ||
      (this.retainedAttachments.get(tabId)?.size ?? 0) > 0
    ) {
      return;
    }
    const timer = setTimeout(() => {
      this.idleTimers.delete(tabId);
      void this.softDetachIdleTab(tabId);
    }, delayMs);
    this.idleTimers.set(tabId, timer);
  }

  private canSoftDetachIdleTab(tabId: number): boolean {
    if (!this.attachedTabs.has(tabId)) return false;
    // Guard 1: No in-flight attach/detach, retained attachment lease, concurrent CDP command or pending frame task.
    if (
      this.attachInFlight.has(tabId) ||
      this.detachInFlight.has(tabId) ||
      (this.retainedAttachments.get(tabId)?.size ?? 0) > 0 ||
      (this.inFlightCommands.get(tabId) ?? 0) > 0 ||
      (this.frameDiscovery.get(tabId)?.pending.size ?? 0) > 0
    ) {
      return false;
    }
    // Guard 2: No active console or network diagnostic capture enabled.
    if (
      this.consoleDomainsEnabledTabs.has(tabId) ||
      this.activeConsoleCaptureTabs.has(tabId) ||
      this.networkDomainsEnabledTabs.has(tabId)
    ) {
      return false;
    }
    // Guard 3: No persistent backgroundExecution anti-throttling or active Emulation override.
    if (this.backgroundExecution.hasAny(tabId) || this.hasActiveEmulation(tabId)) {
      return false;
    }
    // Guard 4: No pending or opening native JavaScript dialog or post-dialog verification.
    if (
      this.pendingDialogEntries.has(tabId) ||
      this.dialogOpeningInFlight.has(tabId) ||
      this.unverifiedDialogDocSignatures.has(tabId) ||
      this.postDialogVerifications.has(tabId)
    ) {
      return false;
    }
    return true;
  }

  private async probeRootDocumentSignature(tabId: number): Promise<RootDocumentSignature> {
    try {
      let treeReply: unknown;
      const treeOk = await cleanupWait(
        this.api.sendCommand({ tabId }, "Page.getFrameTree", {}).then((res) => {
          treeReply = res;
        }),
      );
      if (!treeOk) return { probed: false };
      const frame = (
        treeReply as
          | {
              frameTree?: {
                frame?: {
                  id?: string;
                  parentId?: string;
                  loaderId?: string;
                  url?: string;
                  urlFragment?: string;
                };
              };
            }
          | undefined
      )?.frameTree?.frame;
      const frameIdentity =
        frame && !frame.parentId
          ? {
              frameId: typeof frame.id === "string" ? frame.id : undefined,
              loaderId: typeof frame.loaderId === "string" ? frame.loaderId : undefined,
              url: typeof frame.url === "string" ? frame.url : undefined,
              urlFragment: typeof frame.urlFragment === "string" ? frame.urlFragment : undefined,
            }
          : {};
      const dialogOpening = this.dialogOpeningInFlight.get(tabId);
      if (dialogOpening) {
        await cleanupWait(dialogOpening);
      }
      // When a native JS modal dialog is open, the renderer main thread is paused and
      // `DOM.getDocument` hangs until the dialog is dismissed. Confirm root identity
      // from `Page.getFrameTree` instead of blocking reattach on `DOM.getDocument`.
      if (this.pendingDialogEntries.has(tabId)) {
        return {
          probed: true,
          dialogOpen: true,
          ...frameIdentity,
        };
      }
      let docReply: unknown;
      const docOk = await cleanupWait(
        this.api.sendCommand({ tabId }, "DOM.getDocument", { depth: 1 }).then((res) => {
          docReply = res;
        }),
      );
      if (!docOk) return { probed: false };
      const root = (
        docReply as
          | {
              root?: {
                backendNodeId?: number;
                documentURL?: string;
                children?: { nodeType?: number; backendNodeId?: number }[];
              };
            }
          | undefined
      )?.root;
      const docElementId = root?.children?.find((child) => child.nodeType === 1)?.backendNodeId;
      return {
        probed: true,
        ...frameIdentity,
        backendNodeId: typeof root?.backendNodeId === "number" ? root.backendNodeId : undefined,
        documentElementBackendNodeId: typeof docElementId === "number" ? docElementId : undefined,
        documentUrl: typeof root?.documentURL === "string" ? root.documentURL : undefined,
      };
    } catch {
      return { probed: false };
    }
  }

  private async probeChildFrameSignatures(
    tabId: number,
  ): Promise<Map<string, ChildFrameSignature>> {
    const state = this.frameDiscovery.get(tabId);
    const signatures = new Map<string, ChildFrameSignature>();
    if (!state || state.sessions.size === 0) return signatures;
    const sessions = [...state.sessions];
    await Promise.all(
      sessions.map(async (sessionId) => {
        let frame:
          | {
              id?: string;
              parentId?: string;
              loaderId?: string;
              url?: string;
              urlFragment?: string;
            }
          | undefined;
        try {
          let reply: unknown;
          const ok = await cleanupWait(
            this.api.sendCommand({ tabId, sessionId }, "Page.getFrameTree", {}).then((res) => {
              reply = res;
            }),
          );
          if (ok) {
            frame = (
              reply as
                | {
                    frameTree?: {
                      frame?: {
                        id?: string;
                        parentId?: string;
                        loaderId?: string;
                        url?: string;
                        urlFragment?: string;
                      };
                    };
                  }
                | undefined
            )?.frameTree?.frame;
          }
        } catch {
          // Fall back to cached Target.attachedToTarget metadata when child tree read fails.
        }
        const frameId =
          (typeof frame?.id === "string" && frame.id ? frame.id : undefined) ??
          state.frameIds.get(sessionId);
        const loaderId =
          (typeof frame?.loaderId === "string" ? frame.loaderId : undefined) ??
          state.loaderIds.get(sessionId);
        const url =
          (typeof frame?.url === "string" ? frame.url : undefined) ??
          state.frameUrls.get(sessionId);
        const urlFragment = typeof frame?.urlFragment === "string" ? frame.urlFragment : undefined;
        if (frameId) state.frameIds.set(sessionId, frameId);
        if (loaderId !== undefined) state.loaderIds.set(sessionId, loaderId);
        if (url !== undefined) state.frameUrls.set(sessionId, url);
        signatures.set(sessionId, {
          sessionId,
          frameId,
          loaderId,
          url,
          urlFragment,
        });
      }),
    );
    return signatures;
  }

  private async reconcileSoftDetachedChildFrames(
    tabId: number,
    previousChildFrames: Map<string, ChildFrameSignature>,
    check: () => void,
  ): Promise<void> {
    while ((this.frameDiscovery.get(tabId)?.pending.size ?? 0) > 0) {
      const pending = [...(this.frameDiscovery.get(tabId)?.pending ?? [])];
      if (!(await cleanupWait(Promise.allSettled(pending)))) break;
      check();
    }
    if (this.api === chromeDebuggerApi) {
      const discoveredFrameIds = new Set(this.frameDiscovery.get(tabId)?.frameIds.values() ?? []);
      const missingExpected = [...previousChildFrames.values()].some(
        (sig) => sig.frameId !== undefined && !discoveredFrameIds.has(sig.frameId),
      );
      if (missingExpected) {
        await this.drainFrameAttachTasks(tabId);
        check();
      }
    }
    const currentChildFrames = await this.probeChildFrameSignatures(tabId);
    check();
    const currentByFrameId = new Map<string, ChildFrameSignature>();
    for (const sig of currentChildFrames.values()) {
      if (sig.frameId) currentByFrameId.set(sig.frameId, sig);
    }

    const stepRemap = new Map<string, string>();
    const staleSessionIds = new Set<string>();
    const staleFrameIds = new Set<string>();

    for (const [oldSessionId, prevSig] of previousChildFrames) {
      const nextSig = prevSig.frameId ? currentByFrameId.get(prevSig.frameId) : undefined;
      if (sameChildFrameSignature(prevSig, nextSig)) {
        stepRemap.set(oldSessionId, nextSig.sessionId);
      } else {
        staleSessionIds.add(oldSessionId);
        if (prevSig.frameId) staleFrameIds.add(prevSig.frameId);
      }
    }

    const existingRemap = this.remappedChildSessions.get(tabId);
    const nextRemap = new Map<string, string>();
    if (existingRemap) {
      for (const [originSessionId, intermediateSessionId] of existingRemap) {
        const chainedSessionId = stepRemap.get(intermediateSessionId);
        if (chainedSessionId !== undefined) {
          if (originSessionId !== chainedSessionId) {
            nextRemap.set(originSessionId, chainedSessionId);
          }
        } else if (
          staleSessionIds.has(intermediateSessionId) ||
          !currentChildFrames.has(intermediateSessionId)
        ) {
          staleSessionIds.add(originSessionId);
        }
      }
    }
    for (const [oldSessionId, newSessionId] of stepRemap) {
      if (oldSessionId !== newSessionId) {
        nextRemap.set(oldSessionId, newSessionId);
      }
    }
    while (nextRemap.size > MAX_REMAPPED_CHILD_SESSIONS) {
      const oldest = nextRemap.keys().next().value;
      if (oldest === undefined) break;
      nextRemap.delete(oldest);
      staleSessionIds.add(oldest);
    }
    if (nextRemap.size > 0) {
      this.remappedChildSessions.set(tabId, nextRemap);
      this.options.onChildFramesRemapped?.(tabId, nextRemap);
    } else {
      this.remappedChildSessions.delete(tabId);
    }

    if (staleSessionIds.size > 0 || staleFrameIds.size > 0) {
      if (this.options.onChildFramesInvalidated) {
        this.options.onChildFramesInvalidated(tabId, {
          sessionIds: staleSessionIds,
          frameIds: staleFrameIds,
        });
      } else {
        this.options.onDocumentChanged?.(tabId);
      }
    }
  }

  private async softDetachIdleTab(tabId: number): Promise<void> {
    this.clearIdleTimer(tabId);
    if (!this.canSoftDetachIdleTab(tabId)) return;
    const versionBeforeProbe = this.attachmentVersions.get(tabId) ?? 0;
    const [preDetachDoc, preDetachChildFrames] = await Promise.all([
      this.probeRootDocumentSignature(tabId),
      this.probeChildFrameSignatures(tabId),
    ]);
    if (
      (this.attachmentVersions.get(tabId) ?? 0) !== versionBeforeProbe ||
      this.idleTimers.has(tabId) ||
      !this.canSoftDetachIdleTab(tabId)
    ) {
      return;
    }
    const previousAttachmentId = this.attachmentIds.get(tabId);
    this.attachmentVersions.set(tabId, (this.attachmentVersions.get(tabId) ?? 0) + 1);
    this.attachedTabs.delete(tabId);
    this.softDetachedTabs.add(tabId);
    this.softDetachedDocSignatures.set(tabId, preDetachDoc);
    if (previousAttachmentId !== undefined) {
      this.softDetachedAttachmentIds.set(tabId, previousAttachmentId);
    } else {
      this.softDetachedAttachmentIds.delete(tabId);
    }
    if (preDetachChildFrames.size > 0) {
      this.softDetachedFrameSessions.set(tabId, preDetachChildFrames);
    } else {
      this.softDetachedFrameSessions.delete(tabId);
    }
    this.attachmentIds.delete(tabId);
    // Preserve `this.tabOwners`, `this.claimAttempts`, and historical
    // `consoleBuffers` / `consoleSequences` / `networkBuffers` / `networkSequences`
    // so `since` cursors remain monotonic across transparent reattach, and do NOT
    // fire `onDocumentChanged(tabId)`.
    this.options.onSoftDetached?.(tabId);
    this.backgroundExecution.invalidate(tabId);
    this.passiveNetworkEnabledTabs.delete(tabId);
    this.networkRequestMeta.delete(tabId);
    this.activeEmulationTabs.delete(tabId);
    this.clearFrameState(tabId);
    const detach = (async () => {
      try {
        await this.api.detach({ tabId });
      } catch (err) {
        console.debug("[bsk cdp] idle soft-detach failed (likely tab already closed)", err);
      }
    })().finally(() => {
      if (this.detachInFlight.get(tabId) === detach) {
        this.detachInFlight.delete(tabId);
      }
    });
    this.detachInFlight.set(tabId, detach);
    await cleanupWait(detach);
  }

  private async command(
    rawTarget: CdpDebuggee,
    method: string,
    params: object,
    readTimeoutMs?: number,
    beforeDispatch?: () => void,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const target = this.resolveTarget(rawTarget);
    const { tabId } = target;
    const rootState =
      method === "Page.getFrameTree" && !target.sessionId && typeof tabId === "number"
        ? this.frameDiscoveryState(tabId)
        : undefined;
    const rootBefore = rootState?.rootFrameId;
    const version = typeof tabId === "number" ? (this.attachmentVersions.get(tabId) ?? 0) : 0;
    const result = await this.readGate.run(
      target,
      method,
      () => {
        beforeDispatch?.();
        return this.runTrackedSendCommand(target, method, params);
      },
      readTimeoutMs,
      signal,
    );
    // Page.enable does not replay navigation for an already loaded tab. Learn
    // its root from every tree-read path, including guarded passive reads.
    // A delayed reply must not overwrite a newer attachment or root event.
    if (
      rootState &&
      typeof tabId === "number" &&
      this.frameDiscovery.get(tabId) === rootState &&
      (this.attachmentVersions.get(tabId) ?? 0) === version &&
      rootState.rootFrameId === rootBefore
    ) {
      const frame = (result as { frameTree?: CdpFrameTreeNode } | undefined)?.frameTree?.frame;
      if (typeof frame?.id === "string" && frame.id && !frame.parentId)
        rootState.rootFrameId = frame.id;
    }
    return result;
  }

  private async enablePageDomain(tabId: number): Promise<void> {
    await this.command({ tabId }, "Page.enable", {});
  }

  private async enableConsoleDomains(tabId: number, signal?: AbortSignal): Promise<void> {
    const attachmentId = this.getAttachmentId(tabId);
    if (attachmentId === undefined) throw new Error("debugger detached");
    const check = () => {
      signal?.throwIfAborted();
      if (this.getAttachmentId(tabId) !== attachmentId)
        throw new Error("Debugger attachment changed during console capture");
    };
    check();
    if (this.consoleDomainsEnabledTabs.get(tabId) === attachmentId) return;
    // Runtime carries page console calls and exceptions, so its failure is the
    // caller's error. Log only adds browser-generated entries and stays
    // best-effort. Either failure leaves the tab unmarked so the next read
    // retries instead of silently returning no console output.
    await this.command({ tabId }, "Runtime.enable", {}, READ_TIMEOUT_MS, check, signal);
    check();
    this.activeConsoleCaptureTabs.add(tabId);
    let logEnabled = true;
    try {
      await this.command({ tabId }, "Log.enable", {}, READ_TIMEOUT_MS, check, signal);
    } catch (err) {
      check();
      if (err instanceof CdpReadTimeoutError) throw err;
      logEnabled = false;
      console.debug("[bsk cdp] console domain enable failed", { tabId, method: "Log.enable", err });
    }
    check();
    // Runtime.enable replays stored console messages as events, which are not
    // ordered with its command reply. One more renderer round trip lets them
    // reach the buffer before the first read.
    await this.command(
      { tabId },
      "Runtime.evaluate",
      { expression: "0", returnByValue: true, silent: true },
      READ_TIMEOUT_MS,
      check,
      signal,
    );
    check();
    if (logEnabled) this.consoleDomainsEnabledTabs.set(tabId, attachmentId);
  }

  private async enableNetworkDomain(tabId: number): Promise<void> {
    if (this.networkDomainsEnabledTabs.has(tabId)) return;
    if (!this.passiveNetworkEnabledTabs.has(tabId)) {
      await this.command({ tabId }, "Network.enable", {});
      this.passiveNetworkEnabledTabs.add(tabId);
    }
    this.networkDomainsEnabledTabs.add(tabId);
  }

  private async enableNetworkDomainBestEffort(tabId: number): Promise<void> {
    if (this.passiveNetworkEnabledTabs.has(tabId) || this.networkDomainsEnabledTabs.has(tabId)) {
      return;
    }
    try {
      await this.command({ tabId }, "Network.enable", {});
      this.passiveNetworkEnabledTabs.add(tabId);
    } catch (err) {
      console.debug("[bsk cdp] network domain enable failed", { tabId, err });
    }
  }

  private enableFrameDiscovery(target: CdpTarget): Promise<void> {
    const state = this.frameDiscoveryState(target.tabId);
    const key = target.sessionId ?? "root";
    const existing = state.enabled.get(key);
    if (existing) return existing;
    // Auto-attach remains enabled for this debugger session, including later
    // navigation and new iframes. Reconfiguring it on every observation adds a
    // browser round trip and needlessly repeats child-target discovery.
    let issued = false;
    const work = this.readGate
      .run(target, "Target.setAutoAttach", () => {
        issued = true;
        return this.runTrackedSendCommand(target, "Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: [{ type: "iframe", exclude: false }],
        }).then(
          () => {
            if (state.enabled.get(key) === work) state.enabled.set(key, Promise.resolve());
          },
          (error) => {
            if (state.enabled.get(key) === work) state.enabled.delete(key);
            throw error;
          },
        );
      })
      .then(() => {})
      .catch((error) => {
        // Keep a timed-out configuration until Chrome actually settles it.
        if ((!issued || !(error instanceof CdpReadTimeoutError)) && state.enabled.get(key) === work)
          state.enabled.delete(key);
        throw error;
      });
    state.enabled.set(key, work);
    return work;
  }

  private bindFrameTargetHandler(): void {
    if (this.frameTargetSubscription) return;
    const listener = (source: CdpDebuggee, method: string, params: unknown) => {
      const tabId = source.tabId;
      if (typeof tabId !== "number") return;
      const raw = (params ?? {}) as Record<string, unknown>;
      const frame = raw.frame as
        | { id?: string; parentId?: string; loaderId?: string; url?: string }
        | undefined;
      if (
        !source.sessionId &&
        frame?.id &&
        !frame.parentId &&
        ["Page.frameNavigated", "Page.documentOpened"].includes(method)
      )
        this.frameDiscoveryState(tabId).rootFrameId = frame.id;
      if (source.sessionId) {
        const childState = this.frameDiscovery.get(tabId);
        if (
          childState &&
          frame?.id &&
          ["Page.frameNavigated", "Page.documentOpened"].includes(method) &&
          (!frame.parentId || childState.frameIds.get(source.sessionId) === frame.id)
        ) {
          childState.frameIds.set(source.sessionId, frame.id);
          if (typeof frame.loaderId === "string")
            childState.loaderIds.set(source.sessionId, frame.loaderId);
          if (typeof frame.url === "string") childState.frameUrls.set(source.sessionId, frame.url);
        } else if (
          childState &&
          method === "Page.navigatedWithinDocument" &&
          typeof raw.url === "string" &&
          raw.frameId === childState.frameIds.get(source.sessionId)
        ) {
          childState.frameUrls.set(source.sessionId, raw.url);
        }
      }
      const rootRouteChanged =
        method === "Page.navigatedWithinDocument" &&
        raw.frameId === this.frameDiscovery.get(tabId)?.rootFrameId;
      // A child navigation/detach does not replace the root document. Keep this
      // tab-wide invalidation limited to root changes; child lifetimes need
      // frame-scoped handling rather than discarding unrelated page refs.
      if (
        !source.sessionId &&
        (rootRouteChanged ||
          method === "DOM.documentUpdated" ||
          ((method === "Page.frameNavigated" || method === "Page.documentOpened") &&
            frame &&
            !frame.parentId))
      ) {
        this.unverifiedDialogDocSignatures.delete(tabId);
        this.remappedChildSessions.delete(tabId);
        this.options.onDocumentChanged?.(tabId);
      }
      const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : undefined;
      if (!sessionId) return;

      if (method === "Target.detachedFromTarget") {
        const state = this.frameDiscovery.get(tabId);
        state?.enabled.delete(sessionId);
        state?.frameIds.delete(sessionId);
        state?.loaderIds.delete(sessionId);
        state?.frameUrls.delete(sessionId);
        const remapped = this.remappedChildSessions.get(tabId);
        if (remapped) {
          for (const [oldSessionId, targetSessionId] of remapped) {
            if (oldSessionId === sessionId || targetSessionId === sessionId) {
              remapped.delete(oldSessionId);
            }
          }
          if (remapped.size === 0) this.remappedChildSessions.delete(tabId);
        }
        this.readGate.reset(tabId, sessionId);
        if (state?.sessions.delete(sessionId)) state.generation += 1;
        return;
      }
      if (method !== "Target.attachedToTarget") return;
      const targetInfo = raw.targetInfo as
        | { type?: string; targetId?: string; url?: string }
        | undefined;
      if (targetInfo?.type && targetInfo.type !== "iframe") return;

      const state = this.frameDiscoveryState(tabId);
      // Chromium iframe target IDs are their DevTools frame tokens. Remember
      // this before the first tree read so an unresponsive OOPIF can be omitted.
      if (targetInfo?.type === "iframe" && typeof targetInfo.targetId === "string")
        state.frameIds.set(sessionId, targetInfo.targetId);
      if (targetInfo?.type === "iframe" && typeof targetInfo.url === "string")
        state.frameUrls.set(sessionId, targetInfo.url);
      if (state.sessions.has(sessionId)) return;
      state.sessions.add(sessionId);
      state.generation += 1;

      const task = this.initializeFrameTarget({ tabId, sessionId });
      state.pending.add(task);
      void task.finally(() => {
        state.pending.delete(task);
      });
    };
    this.api.onEvent.addListener(listener);
    this.frameTargetSubscription = {
      dispose: () => this.api.onEvent.removeListener(listener),
    };
  }

  /** A late real failure may clear a previously timed-out configuration.
   * Retry it under the same bounded drain as newly attached targets. */
  private retryChildFrameDiscovery(tabId: number): void {
    const state = this.frameDiscovery.get(tabId);
    if (!state) return;
    for (const sessionId of state.sessions) {
      if (state.enabled.has(sessionId)) continue;
      const task = this.initializeFrameTarget({ tabId, sessionId });
      state.pending.add(task);
      void task.finally(() => {
        state.pending.delete(task);
      });
    }
  }

  private async initializeFrameTarget(target: CdpTarget): Promise<void> {
    try {
      await this.enableFrameDiscovery(target);
    } catch (err) {
      if (err instanceof CdpReadTimeoutError) {
        // The command is still in flight and Chrome keeps the child session
        // attached. Keep both the session and the pending configuration until
        // Chrome settles it instead of resending or losing the frame.
        console.debug("[bsk cdp] child frame discovery timed out", { target });
        return;
      }
      const state = this.frameDiscovery.get(target.tabId);
      if (state?.sessions.delete(target.sessionId as string)) state.generation += 1;
      console.debug("[bsk cdp] child frame target initialization failed", { target, err });
    }
  }

  private async drainFrameAttachTasks(tabId: number): Promise<void> {
    const deadline = Date.now() + FRAME_DISCOVERY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = this.frameDiscovery.get(tabId);
      const generation = state?.generation ?? 0;
      if (state?.pending.size && !(await settleBeforeDeadline([...state.pending], deadline))) break;

      // Target.setAutoAttach may enqueue the next attachedToTarget event after
      // its command promise settles. Wait for a short quiet window, then finish
      // only if neither the state object nor its generation changed.
      const quietTime = Math.min(FRAME_DISCOVERY_QUIET_MS, deadline - Date.now());
      if (quietTime <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, quietTime));
      const current = this.frameDiscovery.get(tabId);
      if (
        current === state &&
        (current?.generation ?? 0) === generation &&
        !current?.pending.size
      ) {
        return;
      }
    }
    console.debug("[bsk cdp] frame discovery did not reach quiescence before timeout", { tabId });
  }

  private frameDiscoveryState(tabId: number): FrameDiscoveryState {
    const existing = this.frameDiscovery.get(tabId);
    if (existing) return existing;
    const created: FrameDiscoveryState = {
      sessions: new Set(),
      pending: new Set(),
      generation: 0,
      enabled: new Map(),
      frameIds: new Map(),
      loaderIds: new Map(),
      frameUrls: new Map(),
    };
    this.frameDiscovery.set(tabId, created);
    return created;
  }

  private clearFrameState(tabId: number): void {
    this.frameDiscovery.delete(tabId);
    this.readGate.reset(tabId);
  }

  pendingDialogs(tabId?: number): PendingJavaScriptDialog[] {
    return [...this.pendingDialogEntries.values()]
      .filter((entry) => tabId === undefined || entry.dialog.tab_id === tabId)
      .map((entry) => ({ ...entry.dialog }));
  }

  onDialogChanged(
    handler: (
      tabId: number,
      dialog: PendingJavaScriptDialog | null,
      reason?: "decision_timeout",
    ) => void,
  ): { dispose(): void } {
    this.dialogListeners.add(handler);
    return { dispose: () => this.dialogListeners.delete(handler) };
  }

  private emitDialogChanged(
    tabId: number,
    dialog: PendingJavaScriptDialog | null,
    reason?: "decision_timeout",
  ): void {
    for (const listener of this.dialogListeners) listener(tabId, dialog, reason);
  }

  async resolveDialog(
    id: string,
    accept: boolean,
    text?: string,
    guard: Pick<CdpDispatchGuard, "signal" | "onDispatch"> = {},
  ): Promise<JavaScriptDialogInfo> {
    const entry = [...this.pendingDialogEntries.values()].find((item) => item.dialog.id === id);
    if (!entry) throw new Error("Dialog is no longer pending");
    if (entry.resolving) throw new Error("Dialog decision is already in progress");
    if (text !== undefined && (!accept || entry.dialog.type !== "prompt"))
      throw new Error("text is only valid when accepting a prompt");
    guard.signal?.throwIfAborted();
    if (
      this.options.canControlDialog &&
      !(await this.options.canControlDialog(entry.dialog.tab_id))
    )
      throw new Error("Tab is no longer agent controlled");
    // Scope checks can await tab metadata; repeat identity checks at native dispatch.
    if (this.pendingDialogEntries.get(entry.dialog.tab_id) !== entry)
      throw new Error("Dialog is no longer pending");
    if (entry.resolving) throw new Error("Dialog decision is already in progress");
    entry.resolving = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let closeListener: ((result: JavaScriptDialogInfo | Error) => void) | undefined;
    const closed = new Promise<JavaScriptDialogInfo>((resolve, reject) => {
      closeListener = (result) => (result instanceof Error ? reject(result) : resolve(result));
      entry.closed.add(closeListener);
      timeout = setTimeout(() => reject(new Error("Browser did not confirm dialog closure")), 2000);
    });
    // Attach a rejection handler immediately, including when native dispatch fails first.
    void closed.catch(() => {});
    try {
      const activeAttachment = () =>
        this.getAttachmentId(entry.dialog.tab_id) ?? this.attachingIds.get(entry.dialog.tab_id);
      if (activeAttachment() !== entry.attachmentId) {
        throw new Error("Debugger attachment changed before dispatch");
      }
      await this.command(
        { ...entry.source, tabId: entry.dialog.tab_id },
        "Page.handleJavaScriptDialog",
        {
          accept,
          // CDP treats omitted promptText as empty, so preserve the full native
          // default privately instead of reusing the bounded status preview.
          ...(accept && entry.dialog.type === "prompt"
            ? { promptText: text ?? entry.defaultPrompt ?? "" }
            : {}),
        },
        undefined,
        () => {
          guard.signal?.throwIfAborted();
          if (activeAttachment() !== entry.attachmentId)
            throw new Error("Debugger attachment changed before dispatch");
          if (this.pendingDialogEntries.get(entry.dialog.tab_id) !== entry)
            throw new Error("Dialog changed before native dispatch");
          guard.onDispatch?.();
        },
        guard.signal,
      );
      const result = await closed;
      const verify = this.postDialogVerifications.get(entry.dialog.tab_id);
      if (verify) await cleanupWait(verify.catch(() => {}));
      return result;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (closeListener) entry.closed.delete(closeListener);
      entry.resolving = false;
    }
  }

  private schedulePostDialogVerification(tabId: number): void {
    const pending = this.unverifiedDialogDocSignatures.get(tabId);
    if (!pending) return;
    if (!this.attachedTabs.has(tabId)) {
      if (this.attachingIds.get(tabId) !== pending.attachmentId) {
        this.unverifiedDialogDocSignatures.delete(tabId);
      }
      return;
    }
    if (this.getAttachmentId(tabId) !== pending.attachmentId) {
      this.unverifiedDialogDocSignatures.delete(tabId);
      return;
    }
    if (this.pendingDialogEntries.has(tabId)) return;
    this.unverifiedDialogDocSignatures.delete(tabId);
    const task = (async () => {
      const current = await this.probeRootDocumentSignature(tabId);
      if (!this.attachedTabs.has(tabId) || this.getAttachmentId(tabId) !== pending.attachmentId) {
        return;
      }
      if (current.dialogOpen) {
        this.unverifiedDialogDocSignatures.set(tabId, pending);
        if (!this.pendingDialogEntries.has(tabId)) {
          queueMicrotask(() => this.schedulePostDialogVerification(tabId));
        }
        return;
      }
      if (!sameRootDocumentSignature(pending.expected, current)) {
        this.attachmentIds.set(tabId, crypto.randomUUID());
        this.remappedChildSessions.delete(tabId);
        this.options.onDocumentChanged?.(tabId);
      }
    })().finally(() => {
      if (this.postDialogVerifications.get(tabId) === task) {
        this.postDialogVerifications.delete(tabId);
      }
      if (this.attachedTabs.has(tabId)) {
        this.touchTabActivity(tabId);
      }
    });
    this.postDialogVerifications.set(tabId, task);
  }

  private bindDialogHandler(): void {
    if (this.dialogSubscription) return;
    const listener = (source: CdpDebuggee, method: string, params: unknown) => {
      const tabId = source.tabId;
      if (typeof tabId !== "number") return;
      if (method === "Page.javascriptDialogOpening") {
        const generation = (this.dialogGenerations.get(tabId) ?? 0) + 1;
        this.dialogGenerations.set(tabId, generation);
        const task = this.onJavaScriptDialogOpening(source, params, generation).finally(() => {
          if (this.dialogOpeningInFlight.get(tabId) === task) {
            this.dialogOpeningInFlight.delete(tabId);
          }
          if (this.attachedTabs.has(tabId)) {
            this.touchTabActivity(tabId);
          }
        });
        this.dialogOpeningInFlight.set(tabId, task);
        void task;
      } else if (method === "Page.javascriptDialogClosed") {
        this.dialogGenerations.set(tabId, (this.dialogGenerations.get(tabId) ?? 0) + 1);
        const entry = this.pendingDialogEntries.get(tabId);
        if (!entry) return;
        const info: JavaScriptDialogInfo = {
          tab_id: tabId,
          type: entry.dialog.type,
          message: entry.dialog.message,
          url: entry.dialog.url,
          default_prompt: entry.dialog.default_prompt,
          has_browser_handler: entry.hasBrowserHandler,
          handled: (params as { result?: boolean })?.result ? "accepted" : "dismissed",
          sequence: entry.dialog.sequence,
        };
        clearTimeout(entry.timer);
        this.pendingDialogEntries.delete(tabId);
        this.appendDialog(tabId, info);
        this.schedulePostDialogVerification(tabId);
        for (const close of entry.closed) close(info);
        this.emitDialogChanged(tabId, null);
        this.touchTabActivity(tabId);
      }
    };
    this.api.onEvent.addListener(listener);
    this.dialogSubscription = { dispose: () => this.api.onEvent.removeListener(listener) };
  }

  private async onJavaScriptDialogOpening(
    source: CdpDebuggee,
    params: unknown,
    generation: number,
  ): Promise<void> {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    this.touchTabActivity(tabId);
    const attachmentId = this.getAttachmentId(tabId) ?? this.attachingIds.get(tabId);
    if (!attachmentId) return;
    const attachmentVersion = this.attachmentVersions.get(tabId) ?? 0;
    const parsed = parseDialogOpeningParams(params);
    try {
      if (this.options.canControlDialog && !(await this.options.canControlDialog(tabId))) return;
      const currentAttachmentId = this.getAttachmentId(tabId) ?? this.attachingIds.get(tabId);
      if (
        !currentAttachmentId ||
        (this.attachmentVersions.get(tabId) ?? 0) !== attachmentVersion ||
        this.dialogGenerations.get(tabId) !== generation
      )
        return;
      const sequence = (this.dialogSequences.get(tabId) ?? 0) + 1;
      this.dialogSequences.set(tabId, sequence);
      const dialog: PendingJavaScriptDialog = {
        id: crypto.randomUUID(),
        tab_id: tabId,
        type: parsed.type,
        message: parsed.message,
        url: parsed.url,
        default_prompt:
          parsed.defaultPrompt === undefined
            ? undefined
            : truncateDialogField(parsed.defaultPrompt),
        sequence,
        decision_deadline: Date.now() + 60000,
      };
      const timer = setTimeout(() => {
        // A bounded fallback rejects; never confirms on behalf of an absent agent.
        if (this.pendingDialogEntries.get(tabId)?.dialog.id !== dialog.id) return;
        this.emitDialogChanged(tabId, dialog, "decision_timeout");
        void this.resolveDialog(dialog.id, false).catch(() => {});
      }, 60000);
      const deferEmit = this.attachingIds.has(tabId) && !this.attachedTabs.has(tabId);
      this.pendingDialogEntries.set(tabId, {
        dialog,
        source,
        attachmentId: currentAttachmentId,
        defaultPrompt: parsed.defaultPrompt,
        hasBrowserHandler: parsed.hasBrowserHandler,
        resolving: false,
        ...(deferEmit ? { emitOnAttach: true } : {}),
        timer,
        closed: new Set(),
      });
      if (!deferEmit) {
        this.emitDialogChanged(tabId, dialog);
      }
    } catch (error) {
      console.debug("[bsk cdp] dialog state unavailable", error);
    }
  }

  private appendDialog(tabId: number, entry: JavaScriptDialogInfo): void {
    const buf = this.dialogBuffers.get(tabId) ?? [];
    buf.push(entry);
    while (buf.length > MAX_DIALOG_BUFFER) {
      buf.shift();
    }
    this.dialogBuffers.set(tabId, buf);
  }

  private clearDialogState(tabId: number): void {
    const pending = this.pendingDialogEntries.get(tabId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingDialogEntries.delete(tabId);
      for (const close of pending.closed)
        close(new Error("Debugger attachment changed; dialog outcome is unknown"));
      this.emitDialogChanged(tabId, null);
    }
    this.dialogGenerations.set(tabId, (this.dialogGenerations.get(tabId) ?? 0) + 1);
    this.dialogBuffers.delete(tabId);
    this.dialogSequences.delete(tabId);
  }

  private bindConsoleHandler(): void {
    if (this.consoleSubscription) return;
    const listener = (source: chrome.debugger.Debuggee, method: string, params: unknown) => {
      const tabId = source.tabId;
      if (typeof tabId !== "number") return;
      switch (method) {
        case "Runtime.consoleAPICalled":
          this.appendConsole(tabId, parseConsoleApiCalled(params));
          break;
        case "Runtime.exceptionThrown":
          this.appendConsole(tabId, parseExceptionThrown(params));
          break;
        case "Log.entryAdded":
          this.appendConsole(tabId, parseLogEntry(params));
          break;
      }
    };
    this.api.onEvent.addListener(listener);
    this.consoleSubscription = {
      dispose: () => this.api.onEvent.removeListener(listener),
    };
  }

  private appendConsole(tabId: number, entry: ParsedConsoleEntry | null): void {
    if (!entry) return;
    const sequence = (this.consoleSequences.get(tabId) ?? 0) + 1;
    this.consoleSequences.set(tabId, sequence);
    appendBoundedEntry(this.consoleBuffers, tabId, { ...entry, sequence }, MAX_CONSOLE_BUFFER);
  }

  private clearConsoleState(tabId: number): void {
    this.consoleBuffers.delete(tabId);
    this.consoleSequences.delete(tabId);
    this.consoleDomainsEnabledTabs.delete(tabId);
    this.activeConsoleCaptureTabs.delete(tabId);
  }

  private bindNetworkHandler(): void {
    if (this.networkSubscription) return;
    const listener = (source: chrome.debugger.Debuggee, method: string, params: unknown) => {
      const tabId = source.tabId;
      if (typeof tabId !== "number") return;
      switch (method) {
        case "Network.requestWillBeSent":
          this.rememberNetworkRequest(tabId, params);
          break;
        case "Network.responseReceived":
          this.appendNetwork(
            tabId,
            parseNetworkResponse(this.getNetworkRequest(tabId, params), params),
          );
          break;
        case "Network.loadingFailed":
          this.appendNetwork(
            tabId,
            parseNetworkFailure(this.getNetworkRequest(tabId, params, true), params),
          );
          break;
        case "Network.loadingFinished":
          this.getNetworkRequest(tabId, params, true);
          break;
      }
    };
    this.api.onEvent.addListener(listener);
    this.networkSubscription = {
      dispose: () => this.api.onEvent.removeListener(listener),
    };
  }

  private appendNetwork(tabId: number, entry: ParsedNetworkEntry | null): void {
    if (!entry) return;
    const sequence = (this.networkSequences.get(tabId) ?? 0) + 1;
    this.networkSequences.set(tabId, sequence);
    appendBoundedEntry(this.networkBuffers, tabId, { ...entry, sequence }, MAX_NETWORK_BUFFER);
  }

  /** Remember `requestWillBeSent` metadata so responses/failures can be attributed. */
  private rememberNetworkRequest(tabId: number, params: unknown): void {
    const raw = (params ?? {}) as Record<string, unknown>;
    const id = typeof raw.requestId === "string" ? raw.requestId : undefined;
    const request = (raw.request ?? {}) as Record<string, unknown>;
    if (!id || typeof request.url !== "string") return;
    const url = truncateText(request.url, MAX_NETWORK_FIELD_LENGTH);
    const method = truncateOptionalText(
      typeof request.method === "string" ? request.method : undefined,
      MAX_NETWORK_FIELD_LENGTH,
    );
    const resourceType = truncateOptionalText(
      typeof raw.type === "string" ? raw.type : undefined,
      MAX_NETWORK_FIELD_LENGTH,
    );
    const tabMeta = this.networkRequestMeta.get(tabId) ?? new Map<string, NetworkRequestMeta>();
    tabMeta.delete(id);
    tabMeta.set(id, {
      url: url.text,
      method: method?.text,
      resourceType: resourceType?.text,
      truncated:
        url.truncated || (method?.truncated ?? false) || (resourceType?.truncated ?? false),
    });
    while (tabMeta.size > MAX_NETWORK_REQUEST_META) {
      const oldest = tabMeta.keys().next().value;
      if (oldest === undefined) break;
      tabMeta.delete(oldest);
    }
    this.networkRequestMeta.set(tabId, tabMeta);
  }

  /** Keep metadata through response headers; consume it only when loading ends. */
  private getNetworkRequest(
    tabId: number,
    params: unknown,
    finished = false,
  ): NetworkRequestMeta | undefined {
    const raw = (params ?? {}) as Record<string, unknown>;
    const id = typeof raw.requestId === "string" ? raw.requestId : undefined;
    if (!id) return undefined;
    const tabMeta = this.networkRequestMeta.get(tabId);
    const info = tabMeta?.get(id);
    if (finished) tabMeta?.delete(id);
    if (tabMeta?.size === 0) this.networkRequestMeta.delete(tabId);
    return info;
  }

  private clearNetworkState(tabId: number): void {
    this.networkBuffers.delete(tabId);
    this.networkSequences.delete(tabId);
    this.networkDomainsEnabledTabs.delete(tabId);
    this.passiveNetworkEnabledTabs.delete(tabId);
    this.networkRequestMeta.delete(tabId);
  }

  private bindAutoDetach(): void {
    if (this.detachSubscription) return;
    const listener = (source: chrome.debugger.Debuggee, _reason: string) => {
      if (typeof source.tabId === "number") {
        this.clearIdleTimer(source.tabId);
        this.options.onDocumentChanged?.(source.tabId);
        this.attachedTabs.delete(source.tabId);
        this.clearSoftDetachState(source.tabId);
        this.retainedAttachments.delete(source.tabId);
        this.dialogOpeningInFlight.delete(source.tabId);
        this.attachmentIds.delete(source.tabId);
        this.attachmentVersions.set(
          source.tabId,
          (this.attachmentVersions.get(source.tabId) ?? 0) + 1,
        );
        this.backgroundExecution.invalidate(source.tabId);
        this.activeEmulationTabs.delete(source.tabId);
        if (_reason === "target_closed") {
          this.claimAttempts.delete(source.tabId);
          this.tabOwners.delete(source.tabId);
          this.backgroundExecution.forget(source.tabId);
        }
        this.clearDialogState(source.tabId);
        this.clearConsoleState(source.tabId);
        this.clearNetworkState(source.tabId);
        this.clearFrameState(source.tabId);
      }
    };
    this.api.onDetach.addListener(listener);
    this.detachSubscription = {
      dispose: () => this.api.onDetach.removeListener(listener),
    };
  }

  /** Remove internal Chrome event listeners; tests and SW teardown call this. */
  dispose(): void {
    this.inputClock.invalidate();
    this.clearAllIdleTimers();
    for (const tabId of this.pendingDialogEntries.keys()) this.clearDialogState(tabId);
    this.dialogListeners.clear();
    this.detachSubscription?.dispose();
    this.detachSubscription = null;
    this.dialogSubscription?.dispose();
    this.dialogSubscription = null;
    this.consoleSubscription?.dispose();
    this.consoleSubscription = null;
    this.networkSubscription?.dispose();
    this.networkSubscription = null;
    this.frameTargetSubscription?.dispose();
    this.frameTargetSubscription = null;
  }

  /** Detach tabs only when no other live session has claimed them. */
  async detachSession(sessionId: string): Promise<void> {
    const owned = new Set([...this.tabOwners.keys(), ...this.claimAttempts.keys()]);
    await Promise.all(Array.from(owned, (tabId) => this.releaseSessionTab(sessionId, tabId)));
  }

  /** Clean up ownership and fence any in-flight attachment when a tab closes. */
  forgetClosedTab(tabId: number): void {
    this.clearIdleTimer(tabId);
    this.claimAttempts.delete(tabId);
    this.tabOwners.delete(tabId);
    this.backgroundExecution.forget(tabId);
    void this.detach(tabId);
  }

  /** Reconcile debugger attachments with the current set of live sessions. */
  async syncSessions(liveSessionIds: ReadonlySet<string>): Promise<void> {
    const generation = ++this.syncGeneration;
    const releases: Promise<void>[] = [];
    const seen = new Set<string>();
    const queueRelease = (sessionId: string, tabId: number) => {
      const key = `${sessionId}:${tabId}`;
      if (seen.has(key)) return;
      seen.add(key);
      releases.push(this.releaseSessionTab(sessionId, tabId));
    };
    for (const [tabId, owners] of this.tabOwners) {
      for (const sessionId of owners) {
        if (!liveSessionIds.has(sessionId)) queueRelease(sessionId, tabId);
      }
    }
    for (const [tabId, claims] of this.claimAttempts) {
      for (const sessionId of claims.keys()) {
        if (!liveSessionIds.has(sessionId)) queueRelease(sessionId, tabId);
      }
    }
    await Promise.all(releases);
    if (generation !== this.syncGeneration) return;
    const unowned: Promise<void>[] = [];
    for (const tabId of new Set([
      ...this.attachedTabs,
      ...this.softDetachedTabs,
      ...this.attachInFlight.keys(),
      ...this.detachInFlight.keys(),
    ])) {
      if (!this.tabOwners.get(tabId)?.size && !this.claimAttempts.get(tabId)?.size) {
        unowned.push(this.detach(tabId));
      }
    }
    await Promise.all(unowned);
  }
}

function appendBoundedEntry<T>(
  buffers: Map<number, T[]>,
  tabId: number,
  entry: T,
  maxEntries: number,
): void {
  const buffer = buffers.get(tabId) ?? [];
  buffer.push(entry);
  while (buffer.length > maxEntries) buffer.shift();
  buffers.set(tabId, buffer);
}

function readBufferedEntries<
  TEntry extends { sequence: number },
  TProjected extends { sequence: number; truncated: boolean },
>(
  buffer: TEntry[],
  currentSequence: number,
  since: number | undefined,
  limit: number,
  project: (entry: TEntry) => TProjected,
): { entries: TProjected[]; nextSince: number; truncated: boolean } {
  const hasCursor = typeof since === "number";
  const candidates = hasCursor ? buffer.filter((entry) => entry.sequence > since) : buffer;
  const limited = hasCursor ? candidates.slice(0, limit) : candidates.slice(-limit);
  const entries = limited.map(project);
  const oldestSequence = buffer[0]?.sequence ?? currentSequence + 1;
  const droppedEntries =
    currentSequence > buffer.length && (!hasCursor || (since ?? 0) < oldestSequence - 1);
  return {
    entries,
    nextSince: entries.at(-1)?.sequence ?? currentSequence,
    truncated:
      droppedEntries ||
      candidates.length > limited.length ||
      entries.some((entry) => entry.truncated),
  };
}

function parseDialogOpeningParams(params: unknown): ParsedDialogOpening {
  const raw = (params ?? {}) as Record<string, unknown>;
  const type = normalizeDialogType(raw.type);
  const message = truncateDialogField(typeof raw.message === "string" ? raw.message : "");
  const url = typeof raw.url === "string" ? truncateDialogField(raw.url) : undefined;
  const defaultPrompt = typeof raw.defaultPrompt === "string" ? raw.defaultPrompt : undefined;
  const hasBrowserHandler =
    typeof raw.hasBrowserHandler === "boolean" ? raw.hasBrowserHandler : undefined;
  return { type, message, url, defaultPrompt, hasBrowserHandler };
}

function normalizeDialogType(value: unknown): JavaScriptDialogType {
  switch (value) {
    case "alert":
    case "confirm":
    case "prompt":
    case "beforeunload":
      return value;
    default:
      return "alert";
  }
}

function truncateDialogField(value: string): string {
  if (value.length <= MAX_DIALOG_FIELD_LENGTH) return value;
  return `${value.slice(0, MAX_DIALOG_FIELD_LENGTH)}... [truncated]`;
}

export function parseConsoleApiCalled(params: unknown): ParsedConsoleEntry | null {
  const raw = (params ?? {}) as Record<string, unknown>;
  const args = Array.isArray(raw.args) ? raw.args : [];
  const text = args.map(remoteObjectToText).filter(Boolean).join(" ");
  const stackTrace = parseStackTrace(raw.stackTrace);
  const top = stackTrace[0];
  return makeConsoleEntry({
    kind: "console",
    level: typeof raw.type === "string" ? raw.type : "log",
    text,
    url: top?.url,
    line: top?.line,
    column: top?.column,
    timestamp: typeof raw.timestamp === "number" ? raw.timestamp : undefined,
    stack_trace: stackTrace,
  });
}

export function parseExceptionThrown(params: unknown): ParsedConsoleEntry | null {
  const raw = (params ?? {}) as Record<string, unknown>;
  const details = (raw.exceptionDetails ?? {}) as Record<string, unknown>;
  const exception = (details.exception ?? {}) as Record<string, unknown>;
  const text =
    firstLine(remoteObjectToText(exception)) ||
    firstLine(typeof details.text === "string" ? details.text : undefined) ||
    "Uncaught (unknown error)";
  return makeConsoleEntry({
    kind: "exception",
    level: "error",
    text,
    url: typeof details.url === "string" ? details.url : undefined,
    line: typeof details.lineNumber === "number" ? details.lineNumber + 1 : undefined,
    column: typeof details.columnNumber === "number" ? details.columnNumber + 1 : undefined,
    timestamp: typeof raw.timestamp === "number" ? raw.timestamp : undefined,
    stack_trace: parseStackTrace(details.stackTrace),
  });
}

export function parseLogEntry(params: unknown): ParsedConsoleEntry | null {
  const raw = (params ?? {}) as Record<string, unknown>;
  const entry = (raw.entry ?? {}) as Record<string, unknown>;
  return makeConsoleEntry({
    kind: "log",
    level: typeof entry.level === "string" ? entry.level : "info",
    text: typeof entry.text === "string" ? entry.text : "",
    url: typeof entry.url === "string" ? entry.url : undefined,
    line: typeof entry.lineNumber === "number" ? entry.lineNumber : undefined,
    timestamp: typeof entry.timestamp === "number" ? entry.timestamp : undefined,
    stack_trace: [],
  });
}

function makeConsoleEntry(input: {
  kind: ConsoleEntryKind;
  level: string;
  text: string;
  url?: string;
  line?: number;
  column?: number;
  timestamp?: number;
  stack_trace: ConsoleStackFrame[];
}): ParsedConsoleEntry {
  const projected = truncateText(input.text, MAX_CONSOLE_FIELD_LENGTH);
  return {
    kind: input.kind,
    level: input.level,
    text: projected.text,
    url: truncateOptionalConsoleField(input.url),
    line: input.line,
    column: input.column,
    timestamp: input.timestamp,
    stack_trace: input.stack_trace.slice(0, MAX_CONSOLE_STACK_FRAMES).map((frame) => ({
      function_name: truncateOptionalConsoleField(frame.function_name),
      url: truncateOptionalConsoleField(frame.url),
      line: frame.line,
      column: frame.column,
    })),
    truncated: projected.truncated || input.stack_trace.length > MAX_CONSOLE_STACK_FRAMES,
  };
}

function projectConsoleEntry(
  entry: ConsoleEntry,
  maxTextChars: number,
  includeStack: boolean,
): ConsoleEntry {
  const projected = truncateText(entry.text, maxTextChars);
  return {
    sequence: entry.sequence,
    kind: entry.kind,
    level: entry.level,
    text: projected.text,
    url: entry.url,
    line: entry.line,
    column: entry.column,
    timestamp: entry.timestamp,
    ...(includeStack && entry.stack_trace && entry.stack_trace.length > 0
      ? { stack_trace: entry.stack_trace }
      : {}),
    truncated: entry.truncated || projected.truncated,
  };
}

function remoteObjectToText(value: unknown): string {
  const raw = (value ?? {}) as Record<string, unknown>;
  if ("value" in raw && raw.value !== undefined) return String(raw.value);
  if (typeof raw.description === "string") return raw.description;
  if (typeof raw.unserializableValue === "string") return raw.unserializableValue;
  if (typeof raw.type === "string") return `[${raw.type}]`;
  return "";
}

function parseStackTrace(value: unknown): ConsoleStackFrame[] {
  const raw = (value ?? {}) as Record<string, unknown>;
  const frames = Array.isArray(raw.callFrames) ? raw.callFrames : [];
  return frames
    .filter(
      (frame): frame is Record<string, unknown> => frame !== null && typeof frame === "object",
    )
    .map((frame) => ({
      function_name:
        typeof frame.functionName === "string" && frame.functionName.length > 0
          ? frame.functionName
          : undefined,
      url: typeof frame.url === "string" && frame.url.length > 0 ? frame.url : undefined,
      line: typeof frame.lineNumber === "number" ? frame.lineNumber + 1 : undefined,
      column: typeof frame.columnNumber === "number" ? frame.columnNumber + 1 : undefined,
    }));
}

function firstLine(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.split(/\r?\n/, 1)[0] || undefined;
}

function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
}

function truncateOptionalText(
  value: string | undefined,
  maxChars: number,
): { text: string; truncated: boolean } | undefined {
  return value === undefined ? undefined : truncateText(value, maxChars);
}

function truncateOptionalConsoleField(value: string | undefined): string | undefined {
  return truncateOptionalText(value, MAX_CONSOLE_FIELD_LENGTH)?.text;
}

function parseNetworkResponse(
  info: NetworkRequestMeta | undefined,
  params: unknown,
): ParsedNetworkEntry | null {
  const raw = (params ?? {}) as Record<string, unknown>;
  const response = (raw.response ?? {}) as Record<string, unknown>;
  const hasResponseUrl = typeof response.url === "string";
  const url = hasResponseUrl ? (response.url as string) : info?.url;
  if (!url) return null;
  return makeNetworkEntry({
    kind: "response",
    method: info?.method,
    url,
    status: typeof response.status === "number" ? response.status : undefined,
    status_text: typeof response.statusText === "string" ? response.statusText : undefined,
    mime_type: typeof response.mimeType === "string" ? response.mimeType : undefined,
    resource_type: typeof raw.type === "string" ? raw.type : info?.resourceType,
    timestamp: typeof raw.timestamp === "number" ? raw.timestamp : undefined,
    truncated: info?.truncated === true,
  });
}

function parseNetworkFailure(
  info: NetworkRequestMeta | undefined,
  params: unknown,
): ParsedNetworkEntry | null {
  const raw = (params ?? {}) as Record<string, unknown>;
  return makeNetworkEntry({
    kind: "failure",
    method: info?.method,
    url: info?.url,
    error_text: typeof raw.errorText === "string" ? raw.errorText : undefined,
    resource_type: typeof raw.type === "string" ? raw.type : info?.resourceType,
    timestamp: typeof raw.timestamp === "number" ? raw.timestamp : undefined,
    truncated: info?.truncated === true,
  });
}

function makeNetworkEntry(input: {
  kind: NetworkEntryKind;
  method?: string;
  url?: string;
  status?: number;
  status_text?: string;
  mime_type?: string;
  resource_type?: string;
  error_text?: string;
  timestamp?: number;
  truncated?: boolean;
}): ParsedNetworkEntry {
  const projectedMethod = truncateOptionalText(input.method, MAX_NETWORK_FIELD_LENGTH);
  const projectedUrl = truncateOptionalText(input.url, MAX_NETWORK_FIELD_LENGTH);
  const projectedStatusText = truncateOptionalText(input.status_text, MAX_NETWORK_FIELD_LENGTH);
  const projectedMimeType = truncateOptionalText(input.mime_type, MAX_NETWORK_FIELD_LENGTH);
  const projectedResourceType = truncateOptionalText(input.resource_type, MAX_NETWORK_FIELD_LENGTH);
  const projectedError =
    input.error_text !== undefined
      ? truncateText(input.error_text, MAX_NETWORK_FIELD_LENGTH)
      : undefined;
  return {
    kind: input.kind,
    method: projectedMethod?.text,
    url: projectedUrl?.text,
    status: input.status,
    status_text: projectedStatusText?.text,
    mime_type: projectedMimeType?.text,
    resource_type: projectedResourceType?.text,
    error_text: projectedError?.text,
    timestamp: input.timestamp,
    truncated:
      input.truncated === true ||
      (projectedMethod?.truncated ?? false) ||
      (projectedUrl?.truncated ?? false) ||
      (projectedStatusText?.truncated ?? false) ||
      (projectedMimeType?.truncated ?? false) ||
      (projectedResourceType?.truncated ?? false) ||
      (projectedError?.truncated ?? false),
  };
}

function projectNetworkEntry(entry: NetworkEntry, maxTextChars: number): NetworkEntry {
  const projectedUrl = truncateOptionalText(entry.url, maxTextChars);
  const projectedError =
    entry.error_text !== undefined ? truncateText(entry.error_text, maxTextChars) : undefined;
  return {
    sequence: entry.sequence,
    kind: entry.kind,
    method: entry.method,
    url: projectedUrl?.text,
    status: entry.status,
    status_text: entry.status_text,
    mime_type: entry.mime_type,
    resource_type: entry.resource_type,
    error_text: projectedError?.text,
    timestamp: entry.timestamp,
    truncated:
      entry.truncated || (projectedUrl?.truncated ?? false) || (projectedError?.truncated ?? false),
  };
}

function rethrowReadTimeout(err: unknown): void {
  if (err instanceof CdpReadTimeoutError) throw err;
}

function normalizeError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === "string") return new Error(err);
  if (err && typeof err === "object" && "message" in err) {
    return new Error(String((err as { message: unknown }).message));
  }
  return new Error("unknown chrome.debugger error");
}

/** Caller-side cleanup budget; the underlying promise remains fenced and its
 * late completion is still observed. A deadline is not native cancellation. */
async function cleanupWait(work: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
