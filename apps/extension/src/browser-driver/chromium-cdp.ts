// Chromium `BrowserDriver` implementation. Wraps `chrome.debugger.*`
// so each tool implementation can think in terms of typed `send<T>` /
// `sendToFrame<T>` calls and a single per-tab discriminated-union state machine.
//
// Lifecycle notes:
// * `chrome.debugger.attach()` will fail with "Another debugger is
//   already attached" if invoked twice for the same tab — each tab's
//   lifecycle is tracked in `tabs: Map<number, TabAttachment>` as
//   `Detached | Attaching | Attached | SoftDetached`.
// * Closing a tab implicitly detaches; higher-level code calls `detach()`
//   explicitly when a session stops so the "Agent controlling" infobar
//   stays visible only while needed, and idle tabs soft-detach after 75s
//   once all active leases (`retainTabAttachment` / `onEvent`) are released.
// * Transient OOPIF `sessionId` strings never leave `browser-driver/`:
//   upper layers address frames and nodes via `FrameDocumentHandle` /
//   `FrameNodeHandle`, and `ChromiumCdp` validates `frameId` + `loaderId`
//   (+ optional `documentElementBackendNodeId`) internally before routing.

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
  type FrameDocumentHandle,
  type FrameNodeHandle,
  omitFrameSubtrees,
  StaleFrameHandleError,
} from "./frame-graph";
import { NativeInputClock } from "./native-input-clock";
import { sampleNativeInputClock } from "./native-input-probe";

export type CdpDebuggee = chrome.debugger.Debuggee & { sessionId?: string };

export type TabEventListener = (source: CdpDebuggee, method: string, params: unknown) => void;

/** Guards checked at native dispatch, after any asynchronous connection setup. */
export interface CdpDispatchGuard {
  signal?: AbortSignal;
  /** Only use this live (or soft-detached) attachment; never reconnect a hard-detached tab. */
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
  onEvent: chrome.events.Event<(source: CdpDebuggee, method: string, params: unknown) => void>;
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
  rootNavigationEpoch: number;
  sessions: Set<string>;
  pending: Set<Promise<void>>;
  generation: number;
  enabled: Map<string, Promise<void>>;
  frameIds: Map<string, string>;
}

export interface TabLease {
  readonly kind: "retain" | "subscription";
  readonly reason: string;
}

export interface FrameRoute {
  sessionId?: string;
  loaderId: string;
  authoritative: boolean;
  parentFrameId?: string;
  url?: string;
  urlFragment?: string;
  documentElementBackendNodeId?: number;
  documentOpened?: boolean;
}

interface EmulationDomainState {
  deviceMetrics: boolean;
  userAgent: boolean;
  touch: boolean;
}

interface EnabledDomainsState {
  pageEnabled: boolean;
  consoleEnabled: boolean;
  passiveNetworkEnabled: boolean;
  networkEnabled: boolean;
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

interface DeferredRootDocumentCheck {
  expected: RootDocumentSignature;
  verification?: Promise<void>;
}

interface PendingDialogState {
  dialog: PendingJavaScriptDialog;
  attachmentId: string;
  defaultPrompt?: string;
  hasBrowserHandler?: boolean;
  source: CdpDebuggee;
  resolving: boolean;
  timer: ReturnType<typeof setTimeout>;
  closed: Set<(result: JavaScriptDialogInfo | Error) => void>;
}

interface TabHistoryState {
  owners: Set<string>;
  claims: Map<string, object>;
  dialogBuffer: JavaScriptDialogInfo[];
  dialogSequence: number;
  dialogGeneration: number;
  consoleBuffer: ConsoleEntry[];
  consoleSequence: number;
  softDetachConsoleWaterMark?: number;
  networkBuffer: NetworkEntry[];
  networkSequence: number;
}

interface SoftDetachSnapshot {
  attachmentId: string;
  rootSignature: RootDocumentSignature;
  frames: Map<string, FrameRoute>;
}

/**
 * Single discriminated-union lifecycle for one browser tab's debugger state.
 * Every per-tab field lives on its active variant rather than scattered across parallel Maps.
 */
export type TabAttachment =
  | {
      kind: "detached";
      version: number;
      detachInFlight?: Promise<void>;
      fencedAttach?: Promise<void>;
      leases: Set<TabLease>;
      eventListeners: Set<TabEventListener>;
      history: TabHistoryState;
    }
  | {
      kind: "attaching";
      version: number;
      attachingId: string;
      rawAttached: boolean;
      attachInFlight: Promise<void>;
      previousSoftDetach?: SoftDetachSnapshot;
      frames: Map<string, FrameRoute>;
      frameDiscovery: FrameDiscoveryState;
      leases: Set<TabLease>;
      eventListeners: Set<TabEventListener>;
      inFlightCommands: number;
      domains: EnabledDomainsState;
      emulation?: EmulationDomainState;
      networkRequestMeta: Map<string, NetworkRequestMeta>;
      openDialog?: Promise<void>;
      pendingDialog?: PendingDialogState;
      deferredRootCheck?: DeferredRootDocumentCheck;
      history: TabHistoryState;
    }
  | {
      kind: "attached";
      version: number;
      attachmentId: string;
      frames: Map<string, FrameRoute>;
      frameDiscovery: FrameDiscoveryState;
      leases: Set<TabLease>;
      eventListeners: Set<TabEventListener>;
      idleTimer?: ReturnType<typeof setTimeout>;
      inFlightCommands: number;
      domains: EnabledDomainsState;
      emulation?: EmulationDomainState;
      networkRequestMeta: Map<string, NetworkRequestMeta>;
      openDialog?: Promise<void>;
      pendingDialog?: PendingDialogState;
      deferredRootCheck?: DeferredRootDocumentCheck;
      history: TabHistoryState;
    }
  | {
      kind: "soft_detached";
      version: number;
      snapshot: SoftDetachSnapshot;
      detachInFlight?: Promise<void>;
      leases: Set<TabLease>;
      eventListeners: Set<TabEventListener>;
      history: TabHistoryState;
    };

type ActiveTabAttachment = Extract<TabAttachment, { kind: "attaching" | "attached" }>;

function createFrameDiscoveryState(): FrameDiscoveryState {
  return {
    rootNavigationEpoch: 0,
    sessions: new Set(),
    pending: new Set(),
    generation: 0,
    enabled: new Map(),
    frameIds: new Map(),
  };
}

function createEnabledDomainsState(): EnabledDomainsState {
  return {
    pageEnabled: false,
    consoleEnabled: false,
    passiveNetworkEnabled: false,
    networkEnabled: false,
  };
}

function createHistoryState(): TabHistoryState {
  return {
    owners: new Set(),
    claims: new Map(),
    dialogBuffer: [],
    dialogSequence: 0,
    dialogGeneration: 0,
    consoleBuffer: [],
    consoleSequence: 0,
    networkBuffer: [],
    networkSequence: 0,
  };
}

function isActiveAttachment(entry: TabAttachment | undefined): entry is ActiveTabAttachment {
  return entry?.kind === "attached" || entry?.kind === "attaching";
}

function maxConsoleTimestamp(entries: readonly ConsoleEntry[]): number | undefined {
  let max: number | undefined;
  for (const entry of entries) {
    if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) {
      max = max === undefined ? entry.timestamp : Math.max(max, entry.timestamp);
    }
  }
  return max;
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
  /** Invalidate child-frame refs when child frames disappear or navigate across idle soft-detach. */
  onChildFramesInvalidated?: (tabId: number, staleFrameIds: ReadonlySet<string>) => void;
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

function sameChildFrameRoute(before: FrameRoute, after: FrameRoute | undefined): boolean {
  if (!after || !after.authoritative || !before.loaderId || !after.loaderId) return false;
  return (
    before.loaderId === after.loaderId &&
    before.url === after.url &&
    before.urlFragment === after.urlFragment
  );
}

/**
 * Wrapper around `chrome.debugger` that owns the single per-tab `TabAttachment`
 * state machine and seals `cdpSessionId` routing behind `FrameDocumentHandle` / `FrameNodeHandle`.
 */
export class ChromiumCdp {
  private readonly api: CdpDebuggerApi;
  private readonly inputClock = new NativeInputClock(() => sampleNativeInputClock(this.api));
  private readonly readGate = new CdpReadGate();
  private readonly tabs = new Map<number, TabAttachment>();
  private readonly backgroundExecution = new BackgroundExecution(
    (tabId) => this.getAttachmentId(tabId),
    (tabId, enabled) =>
      this.runTrackedSendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled }),
  );
  private readonly dialogListeners = new Set<
    (tabId: number, dialog: PendingJavaScriptDialog | null, reason?: "decision_timeout") => void
  >();
  private syncGeneration = 0;
  private eventSubscription: { dispose(): void } | null = null;
  private detachSubscription: { dispose(): void } | null = null;

  constructor(
    api: CdpDebuggerApi = chromeDebuggerApi,
    private readonly options: ChromiumCdpOptions = {},
  ) {
    this.api = api;
    this.bindEvents();
    this.bindAutoDetach();
  }

  private ensureTabEntry(tabId: number): TabAttachment {
    const existing = this.tabs.get(tabId);
    if (existing) return existing;
    const created: TabAttachment = {
      kind: "detached",
      version: 0,
      leases: new Set(),
      eventListeners: new Set(),
      history: createHistoryState(),
    };
    this.tabs.set(tabId, created);
    return created;
  }

  private maybePruneDetachedEntry(tabId: number): void {
    const entry = this.tabs.get(tabId);
    if (!entry || entry.kind !== "detached") return;
    if (
      entry.version === 0 &&
      !entry.detachInFlight &&
      !entry.fencedAttach &&
      entry.leases.size === 0 &&
      entry.eventListeners.size === 0 &&
      entry.history.owners.size === 0 &&
      entry.history.claims.size === 0 &&
      entry.history.dialogBuffer.length === 0 &&
      entry.history.dialogSequence === 0 &&
      entry.history.consoleBuffer.length === 0 &&
      entry.history.consoleSequence === 0 &&
      entry.history.networkBuffer.length === 0 &&
      entry.history.networkSequence === 0
    ) {
      this.tabs.delete(tabId);
    }
  }

  /** Identity of this actual debugger attachment, independent of frame topology. */
  getAttachmentId(tabId: number): string | undefined {
    const entry = this.tabs.get(tabId);
    return entry?.kind === "attached" ? entry.attachmentId : undefined;
  }

  private activeOrAttachingId(tabId: number): string | undefined {
    const entry = this.tabs.get(tabId);
    if (entry?.kind === "attached") return entry.attachmentId;
    if (entry?.kind === "attaching" && entry.rawAttached) return entry.attachingId;
    return undefined;
  }

  /** Prevent idle soft-detach while a leased operation (download, screencast, debug capture) is active. */
  retainTabAttachment(tabId: number, reason = "retain"): () => void {
    return this.acquireLease(tabId, { kind: "retain", reason });
  }

  private acquireLease(tabId: number, lease: TabLease): () => void {
    const entry = this.ensureTabEntry(tabId);
    entry.leases.add(lease);
    this.clearIdleTimer(tabId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.tabs.get(tabId);
      current?.leases.delete(lease);
      if (current?.kind === "attached") {
        this.touchTabActivity(tabId);
      } else {
        this.maybePruneDetachedEntry(tabId);
      }
    };
  }

  /**
   * Subscribe to CDP events for `tabId` while holding an automatic idle lease.
   * Disposing the subscription releases the lease so the tab regains 75s Soft-Detach.
   */
  onEvent(tabId: number, handler: TabEventListener): { dispose(): void } {
    const entry = this.ensureTabEntry(tabId);
    entry.eventListeners.add(handler);
    const releaseLease = this.acquireLease(tabId, {
      kind: "subscription",
      reason: "event_subscription",
    });
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.tabs.get(tabId)?.eventListeners.delete(handler);
        releaseLease();
      },
    };
  }

  /** True when `source` originated from `handle`'s current live CDP target in `tabId`. */
  isEventFromFrame(source: CdpDebuggee, handle: FrameDocumentHandle): boolean {
    if (source.tabId !== handle.tabId) return false;
    if (!handle.frameId) return !source.sessionId;
    const entry = this.tabs.get(handle.tabId);
    if (isActiveAttachment(entry)) {
      const route = entry.frames.get(handle.frameId);
      if (route) return (source.sessionId ?? undefined) === route.sessionId;
      for (const [sessionId, mappedFrameId] of entry.frameDiscovery.frameIds) {
        if (mappedFrameId === handle.frameId) return source.sessionId === sessionId;
      }
      if (entry.frameDiscovery.rootFrameId === handle.frameId) return !source.sessionId;
    }
    return !source.sessionId;
  }

  /** True when `frameId` and `parentFrameId` (or the root target when omitted) live in distinct CDP targets. */
  hasOwnFrameTarget(tabId: number, frameId: string, parentFrameId?: string): boolean {
    const entry = this.tabs.get(tabId);
    if (!isActiveAttachment(entry)) return false;
    const childRoute = entry.frames.get(frameId);
    if (!childRoute) return false;
    if (parentFrameId === undefined) return Boolean(childRoute.sessionId);
    const parentRoute = entry.frames.get(parentFrameId);
    if (!parentRoute) return false;
    return childRoute.sessionId !== parentRoute.sessionId;
  }

  /** Cache verified `documentElementBackendNodeId` on a frame's live route until document replacement. */
  recordFrameDocumentElement(
    tabId: number,
    frameId: string,
    loaderId: string,
    documentElementBackendNodeId: number,
  ): void {
    const entry = this.tabs.get(tabId);
    if (!isActiveAttachment(entry) || !frameId) return;
    const route = entry.frames.get(frameId);
    if (!route || route.loaderId !== loaderId || route.documentOpened) return;
    route.documentElementBackendNodeId = documentElementBackendNodeId;
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
    const entry = this.ensureTabEntry(tabId);
    const attempt = {};
    entry.history.claims.set(sessionId, attempt);
    const retained = this.backgroundExecution.has(sessionId, tabId);
    this.trackSessionTab(sessionId, tabId);
    this.backgroundExecution.retain(sessionId, tabId);
    try {
      await this.ensureAttached(tabId);
      if (!this.backgroundExecution.has(sessionId, tabId)) {
        throw new Error("Background execution was released during setup");
      }
    } catch (error) {
      const current = this.tabs.get(tabId);
      if (!retained && current?.history.claims.get(sessionId) === attempt) {
        current.history.claims.delete(sessionId);
        this.backgroundExecution.release(sessionId, tabId);
        await cleanupWait(this.backgroundExecution.synchronize(tabId)).catch(() => {});
        this.maybePruneDetachedEntry(tabId);
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
    let entry = this.tabs.get(tabId);
    if ((entry?.kind === "detached" || entry?.kind === "soft_detached") && entry.detachInFlight) {
      await entry.detachInFlight;
      entry = this.tabs.get(tabId);
    }
    if (entry?.kind === "detached" && entry.fencedAttach) {
      await entry.fencedAttach;
      return;
    }
    if (entry?.kind === "attaching") {
      await entry.attachInFlight;
      await this.verifyRootDocumentAfterDialog(tabId);
      this.touchTabActivity(tabId);
      return;
    }
    if (entry?.kind === "attached") {
      await this.verifyRootDocumentAfterDialog(tabId);
      this.touchTabActivity(tabId);
      return;
    }

    const base = this.ensureTabEntry(tabId);
    const version = base.version;
    const previousSoftDetach = base.kind === "soft_detached" ? base.snapshot : undefined;
    let resolveAttach!: () => void;
    let rejectAttach!: (err: Error) => void;
    const attachInFlight = new Promise<void>((resolve, reject) => {
      resolveAttach = resolve;
      rejectAttach = reject;
    });

    const attachingEntry: Extract<TabAttachment, { kind: "attaching" }> = {
      kind: "attaching",
      version,
      attachingId: previousSoftDetach?.attachmentId ?? crypto.randomUUID(),
      rawAttached: false,
      attachInFlight,
      previousSoftDetach,
      frames: new Map(),
      frameDiscovery: createFrameDiscoveryState(),
      leases: base.leases,
      eventListeners: base.eventListeners,
      inFlightCommands: 0,
      domains: createEnabledDomainsState(),
      networkRequestMeta: new Map(),
      history: base.history,
    };
    this.tabs.set(tabId, attachingEntry);

    const check = () => {
      const current = this.tabs.get(tabId);
      if (current !== attachingEntry || current.version !== version) {
        throw new Error("Debugger attachment was released during setup");
      }
    };

    try {
      await this.api.attach({ tabId }, CDP_PROTOCOL_VERSION);
      attachingEntry.rawAttached = true;
      try {
        check();
        const pageEnabled = this.enablePageDomain(tabId);
        if (
          previousSoftDetach !== undefined &&
          !(await cleanupWait(pageEnabled, READ_TIMEOUT_MS)) &&
          !attachingEntry.pendingDialog
        ) {
          throw new Error(
            "Chrome did not respond during debugger reattachment. Close any open browser dialog and retry.",
          );
        }
        await pageEnabled;
        attachingEntry.domains.pageEnabled = true;
        check();
        await this.enableNetworkDomainBestEffort(tabId);
        check();

        let rootDocumentUnchanged = false;
        if (previousSoftDetach !== undefined) {
          const currentDocSignature = await this.probeRootDocumentSignature(tabId);
          check();
          rootDocumentUnchanged = sameRootDocumentSignature(
            previousSoftDetach.rootSignature,
            currentDocSignature,
          );
          if (!rootDocumentUnchanged) {
            const previousAttachmentId = attachingEntry.attachingId;
            attachingEntry.attachingId = crypto.randomUUID();
            if (
              attachingEntry.pendingDialog &&
              attachingEntry.pendingDialog.attachmentId === previousAttachmentId
            ) {
              attachingEntry.pendingDialog.attachmentId = attachingEntry.attachingId;
            }
            this.options.onDocumentChanged?.(tabId);
          } else if (currentDocSignature.dialogOpen) {
            attachingEntry.deferredRootCheck = { expected: previousSoftDetach.rootSignature };
          }
          if (currentDocSignature.frameId) {
            const existingRoot = attachingEntry.frames.get(currentDocSignature.frameId);
            attachingEntry.frames.set(currentDocSignature.frameId, {
              loaderId: currentDocSignature.loaderId ?? existingRoot?.loaderId ?? "",
              authoritative: true,
              url: currentDocSignature.url ?? existingRoot?.url,
              urlFragment: currentDocSignature.urlFragment ?? existingRoot?.urlFragment,
              documentElementBackendNodeId: currentDocSignature.documentElementBackendNodeId,
            });
          }
        }

        await this.enableFrameDiscovery({ tabId }).catch((err) => {
          console.debug("[bsk cdp] frame discovery unavailable", { tabId, err });
        });
        check();

        if (previousSoftDetach !== undefined && rootDocumentUnchanged) {
          const hadChildFrames = [...previousSoftDetach.frames.entries()].some(
            ([frameId, route]) =>
              frameId !== previousSoftDetach.rootSignature.frameId ||
              route.sessionId !== undefined ||
              route.parentFrameId !== undefined,
          );
          if (hadChildFrames || attachingEntry.frameDiscovery.sessions.size > 0) {
            await this.reconcileSoftDetachedChildFrames(
              tabId,
              attachingEntry,
              previousSoftDetach,
              check,
            );
          }
        }
        check();

        const attachedEntry: Extract<TabAttachment, { kind: "attached" }> = {
          kind: "attached",
          version: attachingEntry.version,
          attachmentId: attachingEntry.attachingId,
          frames: attachingEntry.frames,
          frameDiscovery: attachingEntry.frameDiscovery,
          leases: attachingEntry.leases,
          eventListeners: attachingEntry.eventListeners,
          inFlightCommands: attachingEntry.inFlightCommands,
          domains: attachingEntry.domains,
          emulation: attachingEntry.emulation,
          networkRequestMeta: attachingEntry.networkRequestMeta,
          openDialog: attachingEntry.openDialog,
          pendingDialog: attachingEntry.pendingDialog,
          deferredRootCheck: attachingEntry.deferredRootCheck,
          history: attachingEntry.history,
        };
        this.tabs.set(tabId, attachedEntry);
        this.touchTabActivity(tabId);
        resolveAttach();
      } catch (err) {
        if (attachingEntry.pendingDialog) {
          const pendingDialog = attachingEntry.pendingDialog;
          attachingEntry.pendingDialog = undefined;
          clearTimeout(pendingDialog.timer);
          for (const close of pendingDialog.closed) {
            close(new Error("Debugger attachment changed; dialog outcome is unknown"));
          }
          this.emitDialogChanged(tabId, null);
        }
        this.readGate.reset(tabId);
        const current = this.tabs.get(tabId);
        let restoredEntry:
          | Extract<TabAttachment, { kind: "detached" | "soft_detached" }>
          | undefined;
        if (current === attachingEntry) {
          restoredEntry = previousSoftDetach
            ? {
                kind: "soft_detached",
                version: attachingEntry.version,
                snapshot: previousSoftDetach,
                leases: attachingEntry.leases,
                eventListeners: attachingEntry.eventListeners,
                history: attachingEntry.history,
              }
            : {
                kind: "detached",
                version: attachingEntry.version,
                fencedAttach: attachInFlight,
                leases: attachingEntry.leases,
                eventListeners: attachingEntry.eventListeners,
                history: attachingEntry.history,
              };
          this.tabs.set(tabId, restoredEntry);
        } else {
          this.backgroundExecution.invalidate(tabId);
        }
        const rollbackDetach = this.api.detach({ tabId }).catch((detachErr) => {
          console.debug("[bsk cdp] rollback detach failed", { tabId, detachErr });
        });
        if (restoredEntry?.kind === "soft_detached") {
          restoredEntry.detachInFlight = rollbackDetach;
        }
        await rollbackDetach;
        if (
          restoredEntry?.kind === "soft_detached" &&
          restoredEntry.detachInFlight === rollbackDetach
        ) {
          restoredEntry.detachInFlight = undefined;
        }
        throw err;
      }
    } catch (rawErr) {
      const normalized = normalizeError(rawErr);
      const latest = this.tabs.get(tabId);
      if (latest === attachingEntry) {
        this.tabs.set(
          tabId,
          previousSoftDetach
            ? {
                kind: "soft_detached",
                version: attachingEntry.version,
                snapshot: previousSoftDetach,
                leases: attachingEntry.leases,
                eventListeners: attachingEntry.eventListeners,
                history: attachingEntry.history,
              }
            : {
                kind: "detached",
                version: attachingEntry.version,
                leases: attachingEntry.leases,
                eventListeners: attachingEntry.eventListeners,
                history: attachingEntry.history,
              },
        );
        this.maybePruneDetachedEntry(tabId);
      } else if (latest?.kind === "detached" && latest.fencedAttach === attachInFlight) {
        latest.fencedAttach = undefined;
        this.maybePruneDetachedEntry(tabId);
      }
      void attachInFlight.catch(() => {});
      rejectAttach(normalized);
      throw normalized;
    }

    await attachInFlight;
    await this.verifyRootDocumentAfterDialog(tabId);
  }

  /**
   * Send a CDP command to the tab's root session and decode the result as `T`.
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

  /**
   * Route a node/frame-scoped CDP command via a stable `FrameDocumentHandle` / `FrameNodeHandle`:
   * 1. Transparently reattaches when `SoftDetached` (respecting `guard.attachmentId` without resurrecting hard-detached tabs);
   * 2. Resolves `handle.frameId` to its current `{ tabId, sessionId }` route and validates `loaderId` (+ optional `documentElementBackendNodeId`);
   * 3. Deterministically rejects with `StaleFrameHandleError` if the target frame navigated or underwent `document.open()` replacement.
   */
  async sendToFrame<T = unknown>(
    handle: FrameDocumentHandle | FrameNodeHandle,
    method: string,
    params?: object,
    guard?: CdpDispatchGuard,
  ): Promise<T> {
    const { tabId } = handle;
    guard?.signal?.throwIfAborted();

    const currentBefore = this.tabs.get(tabId);
    if (currentBefore?.kind === "attaching") {
      await currentBefore.attachInFlight;
    }
    guard?.signal?.throwIfAborted();

    if (guard?.attachmentId !== undefined) {
      const state = this.tabs.get(tabId);
      if (state?.kind === "soft_detached" && state.snapshot.attachmentId === guard.attachmentId) {
        await this.ensureAttached(tabId);
      } else if (state?.kind === "attached") {
        await this.verifyRootDocumentAfterDialog(tabId);
        this.touchTabActivity(tabId);
      }
      guard.signal?.throwIfAborted();
      if (this.getAttachmentId(tabId) !== guard.attachmentId) {
        throw new Error("Debugger attachment changed before dispatch");
      }
    } else {
      await this.ensureAttached(tabId);
      guard?.signal?.throwIfAborted();
    }

    // Legacy root shorthand (`frameId === ""` and `loaderId === ""`) routes directly to `{ tabId }`.
    if (!handle.frameId && !handle.loaderId) {
      if (guard) {
        return this.sendGuarded<T>({ tabId }, method, params, guard);
      }
      return this.sendToTarget<T>({ tabId }, method, params);
    }

    const route = await this.resolveValidatedFrameRoute(handle, method, guard?.signal);
    const target: CdpTarget = {
      tabId,
      ...(route.sessionId ? { sessionId: route.sessionId } : {}),
    };

    try {
      return (await this.command(
        target,
        method,
        params ?? {},
        undefined,
        () => {
          guard?.signal?.throwIfAborted();
          if (
            guard?.attachmentId !== undefined &&
            this.getAttachmentId(tabId) !== guard.attachmentId
          ) {
            throw new Error("Debugger attachment changed before dispatch");
          }
          const liveEntry = this.tabs.get(tabId);
          const liveRoute =
            liveEntry?.kind === "attached" ? liveEntry.frames.get(handle.frameId) : undefined;
          if (
            !liveRoute ||
            liveRoute.sessionId !== route.sessionId ||
            liveRoute.loaderId !== handle.loaderId ||
            (handle.documentElementBackendNodeId !== undefined &&
              method !== "Runtime.releaseObjectGroup" &&
              method !== "Runtime.releaseObject" &&
              (liveRoute.documentOpened ||
                (liveRoute.documentElementBackendNodeId !== undefined &&
                  liveRoute.documentElementBackendNodeId !== handle.documentElementBackendNodeId)))
          ) {
            throw new StaleFrameHandleError(tabId, handle.frameId);
          }
          guard?.onDispatch?.();
        },
        guard?.signal,
      )) as T;
    } catch (err) {
      throw normalizeError(err);
    }
  }

  private async resolveValidatedFrameRoute(
    handle: FrameDocumentHandle | FrameNodeHandle,
    method: string,
    signal?: AbortSignal,
  ): Promise<FrameRoute> {
    const { tabId, frameId, loaderId } = handle;
    const isCleanup = method === "Runtime.releaseObjectGroup" || method === "Runtime.releaseObject";
    let entry = this.tabs.get(tabId);
    if (entry?.kind !== "attached") throw new Error("debugger detached");

    let route = entry.frames.get(frameId);
    const needsRefresh =
      !route || !route.authoritative || (entry.frameDiscovery.pending.size > 0 && !route.sessionId);
    if (needsRefresh) {
      await this.refreshFrameRoutes(tabId, signal);
      entry = this.tabs.get(tabId);
      if (entry?.kind !== "attached") throw new Error("debugger detached");
      route = entry.frames.get(frameId);
    }

    if (!route) {
      throw new StaleFrameHandleError(
        tabId,
        frameId,
        `Frame ${frameId} is no longer present in tab ${tabId}`,
      );
    }
    if (route.loaderId !== loaderId || (route.sessionId !== undefined && !loaderId)) {
      throw new StaleFrameHandleError(
        tabId,
        frameId,
        `Frame ${frameId} loader changed in tab ${tabId}`,
      );
    }

    if (handle.documentElementBackendNodeId !== undefined && !isCleanup) {
      if (route.documentElementBackendNodeId === undefined || route.documentOpened) {
        const liveDocElementId = await this.probeFrameDocumentElementBackendNodeId(
          tabId,
          frameId,
          route,
          signal,
        );
        if (liveDocElementId !== undefined) {
          route.documentElementBackendNodeId = liveDocElementId;
          route.documentOpened = false;
        } else if (route.documentOpened) {
          throw new StaleFrameHandleError(
            tabId,
            frameId,
            `Frame ${frameId} document was replaced via document.open()`,
          );
        }
      }
      if (
        route.documentElementBackendNodeId !== undefined &&
        route.documentElementBackendNodeId !== handle.documentElementBackendNodeId
      ) {
        throw new StaleFrameHandleError(
          tabId,
          frameId,
          `Frame ${frameId} documentElement changed in tab ${tabId}`,
        );
      }
    }

    return route;
  }

  private async probeFrameDocumentElementBackendNodeId(
    tabId: number,
    frameId: string,
    route: FrameRoute,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    const target: CdpTarget = {
      tabId,
      ...(route.sessionId ? { sessionId: route.sessionId } : {}),
    };
    const isTargetRoot = !route.parentFrameId || route.sessionId !== undefined;
    if (isTargetRoot) {
      try {
        const doc = (await this.command(
          target,
          "DOM.getDocument",
          { depth: 1 },
          READ_TIMEOUT_MS,
          undefined,
          signal,
        )) as {
          root?: { children?: { nodeType?: number; backendNodeId?: number }[] };
        };
        const docElementId = doc.root?.children?.find(
          (child) => child.nodeType === 1,
        )?.backendNodeId;
        if (typeof docElementId === "number") return docElementId;
      } catch (err) {
        rethrowReadTimeout(err);
      }
    }
    const objectGroup = `bsk-frame-doc-${crypto.randomUUID()}`;
    try {
      const world = (await this.command(
        target,
        "Page.createIsolatedWorld",
        { frameId, worldName: "bsk-document-identity" },
        READ_TIMEOUT_MS,
        undefined,
        signal,
      )) as { executionContextId?: number };
      if (typeof world.executionContextId !== "number") return undefined;
      const reply = (await this.command(
        target,
        "Runtime.evaluate",
        {
          expression: "document.documentElement",
          contextId: world.executionContextId,
          objectGroup,
          serializationOptions: {
            serialization: "deep",
            additionalParameters: { maxNodeDepth: 0, includeShadowTree: "none" },
          },
        },
        READ_TIMEOUT_MS,
        undefined,
        signal,
      )) as {
        result?: { deepSerializedValue?: { type?: string; value?: { backendNodeId?: number } } };
      };
      const serialized = reply.result?.deepSerializedValue;
      if (serialized?.type === "node" && typeof serialized.value?.backendNodeId === "number") {
        return serialized.value.backendNodeId;
      }
      return undefined;
    } catch (err) {
      rethrowReadTimeout(err);
      return undefined;
    } finally {
      await this.command(target, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
    }
  }

  private async refreshFrameRoutes(tabId: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const entry = this.tabs.get(tabId);
    if (!isActiveAttachment(entry)) return;
    await this.enableFrameDiscovery({ tabId }).catch(rethrowReadTimeout);
    this.retryChildFrameDiscovery(tabId);
    await this.drainFrameAttachTasks(tabId);
    signal?.throwIfAborted();

    const current = this.tabs.get(tabId);
    if (!isActiveAttachment(current)) return;

    const sources: CdpFrameTreeSource[] = [];
    const root = (await this.command(
      { tabId },
      "Page.getFrameTree",
      {},
      READ_TIMEOUT_MS,
      undefined,
      signal,
    )) as { frameTree?: CdpFrameTreeNode };
    if (root.frameTree) {
      sources.push({ target: { tabId }, tree: root.frameTree });
    }

    const sessions = [...current.frameDiscovery.sessions];
    const childTrees = await Promise.all(
      sessions.map(async (sessionId): Promise<CdpFrameTreeSource | null> => {
        const target = { tabId, sessionId };
        try {
          const reply = (await this.command(
            target,
            "Page.getFrameTree",
            {},
            READ_TIMEOUT_MS,
            undefined,
            signal,
          )) as { frameTree?: CdpFrameTreeNode };
          if (reply.frameTree && isActiveAttachment(this.tabs.get(tabId))) {
            current.frameDiscovery.frameIds.set(sessionId, reply.frameTree.frame.id);
          }
          return reply.frameTree ? { target, tree: reply.frameTree } : null;
        } catch {
          return null;
        }
      }),
    );
    for (const source of childTrees) {
      if (source) sources.push(source);
    }

    const latest = this.tabs.get(tabId);
    if (!isActiveAttachment(latest)) return;
    this.syncRoutesFromSources(latest, sources);
  }

  private syncRoutesFromSources(
    entry: ActiveTabAttachment,
    sources: readonly CdpFrameTreeSource[],
  ): void {
    const discovered = buildFrameGraph(sources);
    if (!discovered) return;
    entry.frameDiscovery.rootFrameId = discovered.rootFrameId;
    const nextFrames = new Map<string, FrameRoute>();
    for (const frame of discovered.frames) {
      const prev = entry.frames.get(frame.frameId);
      const loaderId = frame.loaderId ?? "";
      const sameDoc =
        prev !== undefined &&
        prev.sessionId === frame.target.sessionId &&
        prev.loaderId === loaderId &&
        !prev.documentOpened;
      nextFrames.set(frame.frameId, {
        ...(frame.target.sessionId ? { sessionId: frame.target.sessionId } : {}),
        loaderId,
        authoritative:
          frame.frameId === discovered.rootFrameId ||
          frame.target.sessionId !== undefined ||
          Boolean(frame.loaderId),
        ...(frame.parentFrameId ? { parentFrameId: frame.parentFrameId } : {}),
        ...(frame.url ? { url: frame.url } : {}),
        ...(frame.urlFragment !== undefined ? { urlFragment: frame.urlFragment } : {}),
        ...(sameDoc && prev.documentElementBackendNodeId !== undefined
          ? { documentElementBackendNodeId: prev.documentElementBackendNodeId }
          : {}),
        ...(prev?.documentOpened && prev.loaderId === loaderId ? { documentOpened: true } : {}),
      });
    }
    entry.frames = nextFrames;
  }

  private harvestTreeIntoRoutes(
    entry: ActiveTabAttachment,
    target: CdpTarget,
    tree: CdpFrameTreeNode,
    isSubtreeRoot = true,
  ): void {
    const frameId = tree.frame.id;
    if (!frameId) return;
    if (!target.sessionId && isSubtreeRoot && !tree.frame.parentId) {
      entry.frameDiscovery.rootFrameId = frameId;
    } else if (target.sessionId && isSubtreeRoot) {
      entry.frameDiscovery.frameIds.set(target.sessionId, frameId);
    }

    let ownedByOtherChildSession = false;
    for (const [sessionId, mappedFrameId] of entry.frameDiscovery.frameIds) {
      if (
        mappedFrameId === frameId &&
        sessionId !== target.sessionId &&
        entry.frameDiscovery.sessions.has(sessionId)
      ) {
        ownedByOtherChildSession = true;
        break;
      }
    }
    const existing = entry.frames.get(frameId);
    if (
      !ownedByOtherChildSession &&
      existing?.sessionId &&
      existing.sessionId !== target.sessionId &&
      entry.frameDiscovery.sessions.has(existing.sessionId)
    ) {
      ownedByOtherChildSession = true;
    }

    if (ownedByOtherChildSession) {
      if (existing && tree.frame.parentId && !existing.parentFrameId) {
        existing.parentFrameId = tree.frame.parentId;
      }
    } else {
      const authoritative = isSubtreeRoot || Boolean(tree.frame.loaderId);
      if (authoritative || !existing) {
        const loaderId = tree.frame.loaderId ?? (authoritative ? "" : (existing?.loaderId ?? ""));
        const sameDoc =
          existing !== undefined &&
          existing.sessionId === target.sessionId &&
          existing.loaderId === loaderId &&
          !existing.documentOpened;
        entry.frames.set(frameId, {
          ...(target.sessionId ? { sessionId: target.sessionId } : {}),
          loaderId,
          authoritative: authoritative || Boolean(existing?.authoritative),
          ...(tree.frame.parentId || existing?.parentFrameId
            ? { parentFrameId: tree.frame.parentId ?? existing?.parentFrameId }
            : {}),
          ...(tree.frame.url || existing?.url ? { url: tree.frame.url ?? existing?.url } : {}),
          ...(tree.frame.urlFragment !== undefined || existing?.urlFragment !== undefined
            ? { urlFragment: tree.frame.urlFragment ?? existing?.urlFragment }
            : {}),
          ...(sameDoc && existing.documentElementBackendNodeId !== undefined
            ? { documentElementBackendNodeId: existing.documentElementBackendNodeId }
            : {}),
          ...(existing?.documentOpened && existing.loaderId === loaderId
            ? { documentOpened: true }
            : {}),
        });
      }
    }

    for (const child of tree.childFrames ?? []) {
      this.harvestTreeIntoRoutes(entry, target, child, false);
    }
  }

  /** Resolve the tab's current root `FrameDocumentHandle` (attaching or reattaching if needed). */
  async getMainFrameHandle(tabId: number, signal?: AbortSignal): Promise<FrameDocumentHandle> {
    signal?.throwIfAborted();
    await this.ensureAttached(tabId);
    signal?.throwIfAborted();
    const entry = this.tabs.get(tabId);
    if (entry?.kind === "attached" && entry.frameDiscovery.rootFrameId) {
      const cached = entry.frames.get(entry.frameDiscovery.rootFrameId);
      if (cached?.authoritative) {
        return {
          tabId,
          frameId: entry.frameDiscovery.rootFrameId,
          loaderId: cached.loaderId,
          ...(cached.documentElementBackendNodeId !== undefined
            ? { documentElementBackendNodeId: cached.documentElementBackendNodeId }
            : {}),
        };
      }
    }
    const reply = (await this.command(
      { tabId },
      "Page.getFrameTree",
      {},
      READ_TIMEOUT_MS,
      undefined,
      signal,
    )) as { frameTree?: CdpFrameTreeNode };
    const rootFrame = reply.frameTree?.frame;
    if (!rootFrame?.id) throw new Error("Page.getFrameTree returned no root frame");
    return {
      tabId,
      frameId: rootFrame.id,
      loaderId: rootFrame.loaderId ?? "",
    };
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
      const entry = this.tabs.get(tabId);
      const frameId =
        target.sessionId && isActiveAttachment(entry)
          ? entry.frameDiscovery.frameIds.get(target.sessionId)
          : undefined;
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

    const activeEntry = this.tabs.get(tabId);
    const sessions = isActiveAttachment(activeEntry)
      ? [...activeEntry.frameDiscovery.sessions]
      : [];
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
          const current = this.tabs.get(tabId);
          if (reply.frameTree && isActiveAttachment(current)) {
            current.frameDiscovery.frameIds.set(sessionId, reply.frameTree.frame.id);
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
    const entryAfterTrees = this.tabs.get(tabId);
    if (isActiveAttachment(entryAfterTrees)) {
      this.syncRoutesFromSources(entryAfterTrees, sources);
    }
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
          isolateChildTimeout(err, parent.target);
        }
      }),
    );
    check();
    return omitFrameSubtrees(discovered, unavailable);
  }

  /** Return a cursor marking the current dialog sequence for `tabId`. */
  dialogCursor(tabId: number): DialogCursor {
    return this.tabs.get(tabId)?.history.dialogSequence ?? 0;
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
    const buf = this.tabs.get(tabId)?.history.dialogBuffer ?? [];
    return buf.filter((entry) => entry.sequence > cursor);
  }

  /**
   * Enable console capture for this tab on first use within the current attachment.
   * Does not retain an idle lease: once idle for 75s without active leases, the tab
   * can still soft-detach cleanly.
   */
  async ensureConsoleCapture(tabId: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.isAttached(tabId)) {
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
    const history = this.tabs.get(tabId)?.history;
    const { entries, nextSince, truncated } = readBufferedEntries(
      history?.consoleBuffer ?? [],
      history?.consoleSequence ?? 0,
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
    if (!this.isAttached(tabId)) {
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
    const history = this.tabs.get(tabId)?.history;
    const { entries, nextSince, truncated } = readBufferedEntries(
      history?.networkBuffer ?? [],
      history?.networkSequence ?? 0,
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

  private clearRetainLeases(entry: TabAttachment): void {
    for (const lease of [...entry.leases]) {
      if (lease.kind === "retain") entry.leases.delete(lease);
    }
  }

  private resetDiagnosticHistory(history: TabHistoryState): void {
    history.dialogGeneration += 1;
    history.dialogBuffer.length = 0;
    history.dialogSequence = 0;
    history.consoleBuffer.length = 0;
    history.consoleSequence = 0;
    history.softDetachConsoleWaterMark = undefined;
    history.networkBuffer.length = 0;
    history.networkSequence = 0;
  }

  private closePendingDialogOnDetach(tabId: number, entry: TabAttachment | undefined): void {
    if (!isActiveAttachment(entry) || !entry.pendingDialog) return;
    const pending = entry.pendingDialog;
    entry.pendingDialog = undefined;
    entry.openDialog = undefined;
    clearTimeout(pending.timer);
    for (const close of pending.closed) {
      close(new Error("Debugger attachment changed; dialog outcome is unknown"));
    }
    this.emitDialogChanged(tabId, null);
  }

  /** Detach if attached; never throws. */
  async detach(tabId: number, expectedAttachmentId?: string): Promise<void> {
    if (expectedAttachmentId !== undefined && this.getAttachmentId(tabId) !== expectedAttachmentId)
      return;
    const entry = this.tabs.get(tabId);
    if (!entry) return;

    this.clearIdleTimer(tabId);
    const nextVersion = entry.version + 1;
    const wasAttached = entry.kind === "attached";
    const wasSoftDetached = entry.kind === "soft_detached";
    const existingDetach =
      entry.kind === "detached" || entry.kind === "soft_detached"
        ? entry.detachInFlight
        : undefined;

    const existingFencedAttach =
      entry.kind === "attaching"
        ? entry.attachInFlight
        : entry.kind === "detached"
          ? entry.fencedAttach
          : undefined;

    this.clearRetainLeases(entry);
    if (!wasAttached && !wasSoftDetached && !existingDetach) {
      this.closePendingDialogOnDetach(tabId, entry);
      if (entry.kind === "attaching") {
        this.resetDiagnosticHistory(entry.history);
        this.readGate.reset(tabId);
        this.backgroundExecution.invalidate(tabId);
        this.tabs.set(tabId, {
          kind: "detached",
          version: nextVersion,
          fencedAttach: existingFencedAttach,
          leases: entry.leases,
          eventListeners: entry.eventListeners,
          history: entry.history,
        });
      } else {
        entry.version = nextVersion;
      }
      this.maybePruneDetachedEntry(tabId);
      return;
    }

    this.closePendingDialogOnDetach(tabId, entry);
    this.resetDiagnosticHistory(entry.history);
    this.readGate.reset(tabId);
    this.backgroundExecution.invalidate(tabId);

    const detachedEntry: Extract<TabAttachment, { kind: "detached" }> = {
      kind: "detached",
      version: nextVersion,
      detachInFlight: existingDetach,
      fencedAttach: existingFencedAttach,
      leases: entry.leases,
      eventListeners: entry.eventListeners,
      history: entry.history,
    };
    this.tabs.set(tabId, detachedEntry);

    if (wasAttached || wasSoftDetached) {
      this.options.onDocumentChanged?.(tabId);
    }

    if (!wasAttached) {
      if (existingDetach) await cleanupWait(existingDetach);
      this.maybePruneDetachedEntry(tabId);
      return;
    }

    if (existingDetach) await cleanupWait(existingDetach);
    const detachWork = (async () => {
      try {
        await this.api.detach({ tabId });
      } catch (err) {
        console.debug("[bsk cdp] detach failed (likely tab already closed)", err);
      }
    })().finally(() => {
      const current = this.tabs.get(tabId);
      if (current?.kind === "detached" && current.detachInFlight === detachWork) {
        current.detachInFlight = undefined;
        this.maybePruneDetachedEntry(tabId);
      }
    });
    const current = this.tabs.get(tabId);
    if (current?.kind === "detached") {
      current.detachInFlight = detachWork;
    }
    await cleanupWait(detachWork);
  }

  /** True iff `ensureAttached(tabId)` has succeeded since the last detach. */
  isAttached(tabId: number): boolean {
    return this.tabs.get(tabId)?.kind === "attached";
  }

  /** Remember that `sessionId` used CDP on `tabId` so stop can detach it. */
  trackSessionTab(sessionId: string, tabId: number): void {
    const entry = this.ensureTabEntry(tabId);
    entry.history.owners.add(sessionId);
  }

  /** Identity of the latest acquisition, including repeated use on one attachment. */
  getSessionClaimId(sessionId: string, tabId: number): object | undefined {
    return this.tabs.get(tabId)?.history.claims.get(sessionId);
  }

  /** Release one session's claim, preserving attachments still used by another. */
  async releaseSessionTab(
    sessionId: string,
    tabId: number,
    guard?: { ifClaim: object },
  ): Promise<void> {
    if (guard && this.getSessionClaimId(sessionId, tabId) !== guard.ifClaim) return;
    const entry = this.tabs.get(tabId);
    entry?.history.claims.delete(sessionId);
    this.backgroundExecution.release(sessionId, tabId);
    entry?.history.owners.delete(sessionId);

    const hasOwners = () => (this.tabs.get(tabId)?.history.owners.size ?? 0) > 0;
    const attaching = entry?.kind === "attaching" ? entry.attachInFlight : undefined;
    if (attaching && !(await cleanupWait(attaching.catch(() => {})))) {
      if (!hasOwners()) await this.detach(tabId);
      return;
    }
    try {
      if (!(await cleanupWait(this.backgroundExecution.synchronize(tabId))))
        throw new Error("Background execution cleanup timed out");
    } catch (error) {
      await this.detach(tabId);
      throw error;
    } finally {
      if (!hasOwners()) {
        await this.detach(tabId);
        this.maybePruneDetachedEntry(tabId);
      }
    }
  }

  /** Debug body reads must never resurrect a detached / returned tab. */
  async sendAttached<T = unknown>(
    target: CdpDebuggee & { tabId: number },
    method: string,
    params?: object,
  ): Promise<T> {
    if (!this.isAttached(target.tabId)) throw new Error("debugger detached");
    return this.runTrackedSendCommand(target, method, params) as Promise<T>;
  }

  /** Best-effort detach of every cached tab. Used on session.stop. */
  async detachAll(): Promise<void> {
    this.inputClock.invalidate();
    this.clearAllIdleTimers();
    const attachedTabIds: number[] = [];
    const notifyTabIds: number[] = [];
    const inFlightDetaches: Promise<void>[] = [];

    for (const [tabId, entry] of this.tabs) {
      if (entry.kind === "attached") {
        attachedTabIds.push(tabId);
        notifyTabIds.push(tabId);
      } else if (entry.kind === "soft_detached") {
        notifyTabIds.push(tabId);
        if (entry.detachInFlight) inFlightDetaches.push(entry.detachInFlight);
      } else if (entry.kind === "detached" && entry.detachInFlight) {
        inFlightDetaches.push(entry.detachInFlight);
      }
      this.closePendingDialogOnDetach(tabId, entry);
      this.clearRetainLeases(entry);
      entry.history.owners.clear();
      entry.history.claims.clear();
      this.resetDiagnosticHistory(entry.history);
      this.tabs.set(tabId, {
        kind: "detached",
        version: entry.version + 1,
        fencedAttach:
          entry.kind === "attaching"
            ? entry.attachInFlight
            : entry.kind === "detached"
              ? entry.fencedAttach
              : undefined,
        leases: entry.leases,
        eventListeners: entry.eventListeners,
        history: entry.history,
      });
      this.maybePruneDetachedEntry(tabId);
    }

    this.backgroundExecution.clear();
    this.readGate.clear();
    for (const tabId of notifyTabIds) {
      this.options.onDocumentChanged?.(tabId);
    }

    await Promise.all([
      ...inFlightDetaches.map((detach) => cleanupWait(detach)),
      ...attachedTabIds.map(async (tabId) => {
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
      const entry = this.tabs.get(tabId);
      if (isActiveAttachment(entry)) {
        entry.inFlightCommands += 1;
      }
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
          const entry = this.tabs.get(tabId);
          if (isActiveAttachment(entry)) {
            entry.inFlightCommands = Math.max(0, entry.inFlightCommands - 1);
          }
          if (entry?.kind === "attached") {
            this.touchTabActivity(tabId);
          }
        }
      });
  }

  private recordEmulationCommand(tabId: number, method: string, params?: object): void {
    const entry = this.tabs.get(tabId);
    if (!isActiveAttachment(entry)) return;
    const raw = (params ?? {}) as Record<string, unknown>;
    const current = entry.emulation ?? {
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
    entry.emulation =
      current.deviceMetrics || current.userAgent || current.touch ? current : undefined;
  }

  private hasActiveEmulation(entry: Extract<TabAttachment, { kind: "attached" }>): boolean {
    const state = entry.emulation;
    return Boolean(state && (state.deviceMetrics || state.userAgent || state.touch));
  }

  private idleDetachDelayMs(): number {
    if (this.options.idleDetachMs !== undefined) return this.options.idleDetachMs;
    return this.api === chromeDebuggerApi ? DEFAULT_IDLE_DETACH_MS : 0;
  }

  private clearIdleTimer(tabId: number): void {
    const entry = this.tabs.get(tabId);
    if (entry?.kind === "attached" && entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  }

  private clearAllIdleTimers(): void {
    for (const entry of this.tabs.values()) {
      if (entry.kind === "attached" && entry.idleTimer !== undefined) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = undefined;
      }
    }
  }

  private touchTabActivity(tabId: number): void {
    const entry = this.tabs.get(tabId);
    if (entry?.kind !== "attached") return;
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    const delayMs = this.idleDetachDelayMs();
    if (delayMs <= 0 || entry.leases.size > 0) return;
    entry.idleTimer = setTimeout(() => {
      const current = this.tabs.get(tabId);
      if (current?.kind === "attached") current.idleTimer = undefined;
      void this.softDetachIdleTab(tabId);
    }, delayMs);
  }

  private canSoftDetachIdleTab(tabId: number): boolean {
    const entry = this.tabs.get(tabId);
    if (entry?.kind !== "attached") return false;
    // Guard 1: No active leases (`retainTabAttachment` or `onEvent`), in-flight CDP commands, or pending frame tasks.
    if (
      entry.leases.size > 0 ||
      entry.inFlightCommands > 0 ||
      entry.frameDiscovery.pending.size > 0
    ) {
      return false;
    }
    // Guard 2: No persistent backgroundExecution anti-throttling or active Emulation override.
    if (this.backgroundExecution.hasAny(tabId) || this.hasActiveEmulation(entry)) {
      return false;
    }
    // Guard 3: No pending or opening native JavaScript dialog or post-dialog verification.
    if (entry.openDialog || entry.pendingDialog || entry.deferredRootCheck) {
      return false;
    }
    return true;
  }

  private async probeRootDocumentSignature(
    tabId: number,
    outRootTree?: { tree?: CdpFrameTreeNode },
  ): Promise<RootDocumentSignature> {
    try {
      let treeReply: unknown;
      const treeOk = await cleanupWait(
        this.api.sendCommand({ tabId }, "Page.getFrameTree", {}).then((res) => {
          treeReply = res;
        }),
      );
      if (!treeOk) return { probed: false };
      const frameTree = (treeReply as { frameTree?: CdpFrameTreeNode } | undefined)?.frameTree;
      if (outRootTree && frameTree) outRootTree.tree = frameTree;
      const currentEntry = this.tabs.get(tabId);
      if (frameTree && isActiveAttachment(currentEntry)) {
        this.harvestTreeIntoRoutes(currentEntry, { tabId }, frameTree, true);
      }
      const frame = frameTree?.frame as
        | {
            id?: string;
            parentId?: string;
            loaderId?: string;
            url?: string;
            urlFragment?: string;
          }
        | undefined;
      const frameIdentity =
        frame && !frame.parentId
          ? {
              frameId: typeof frame.id === "string" ? frame.id : undefined,
              loaderId: typeof frame.loaderId === "string" ? frame.loaderId : undefined,
              url: typeof frame.url === "string" ? frame.url : undefined,
              urlFragment: typeof frame.urlFragment === "string" ? frame.urlFragment : undefined,
            }
          : {};
      const entryForDialog = this.tabs.get(tabId);
      const dialogOpening = isActiveAttachment(entryForDialog)
        ? entryForDialog.openDialog
        : undefined;
      if (dialogOpening) {
        await cleanupWait(dialogOpening);
      }
      const afterDialogEntry = this.tabs.get(tabId);
      if (isActiveAttachment(afterDialogEntry) && afterDialogEntry.openDialog) {
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

  private async captureSnapshotFramesForSoftDetach(
    tabId: number,
    entry: Extract<TabAttachment, { kind: "attached" }>,
    rootTree: CdpFrameTreeNode | undefined,
    rootDoc: RootDocumentSignature,
  ): Promise<Map<string, FrameRoute>> {
    const sources: CdpFrameTreeSource[] = [];
    if (rootTree) {
      sources.push({ target: { tabId }, tree: rootTree });
    }
    const sessions = [...entry.frameDiscovery.sessions];
    const unresolvedChildFrames = new Map<string, FrameRoute>();

    await Promise.all(
      sessions.map(async (sessionId) => {
        try {
          let reply: unknown;
          const ok = await cleanupWait(
            this.api.sendCommand({ tabId, sessionId }, "Page.getFrameTree", {}).then((res) => {
              reply = res;
            }),
          );
          const tree = ok
            ? (reply as { frameTree?: CdpFrameTreeNode } | undefined)?.frameTree
            : undefined;
          if (tree?.frame?.id) {
            sources.push({ target: { tabId, sessionId }, tree });
            return;
          }
        } catch {
          // Fall back to cached frameId so stale refs are still invalidated if probing failed.
        }
        const fallbackFrameId = entry.frameDiscovery.frameIds.get(sessionId);
        if (fallbackFrameId) {
          unresolvedChildFrames.set(fallbackFrameId, {
            sessionId,
            loaderId: "",
            authoritative: false,
          });
        }
      }),
    );

    const snapshotFrames = new Map<string, FrameRoute>();
    const discovered = buildFrameGraph(sources);
    if (discovered) {
      for (const frame of discovered.frames) {
        snapshotFrames.set(frame.frameId, {
          ...(frame.target.sessionId ? { sessionId: frame.target.sessionId } : {}),
          loaderId: frame.loaderId ?? "",
          authoritative:
            frame.frameId === discovered.rootFrameId ||
            (frame.target.sessionId !== undefined && Boolean(frame.loaderId)) ||
            Boolean(frame.loaderId),
          ...(frame.parentFrameId ? { parentFrameId: frame.parentFrameId } : {}),
          ...(frame.url ? { url: frame.url } : {}),
          ...(frame.urlFragment !== undefined ? { urlFragment: frame.urlFragment } : {}),
          ...(frame.frameId === rootDoc.frameId &&
          rootDoc.documentElementBackendNodeId !== undefined
            ? { documentElementBackendNodeId: rootDoc.documentElementBackendNodeId }
            : {}),
        });
      }
    }
    for (const [frameId, fallback] of unresolvedChildFrames) {
      if (!snapshotFrames.get(frameId)?.loaderId) {
        snapshotFrames.set(frameId, fallback);
      }
    }
    for (const [frameId, prevRoute] of entry.frames) {
      if (!snapshotFrames.has(frameId) && prevRoute.sessionId) {
        snapshotFrames.set(frameId, {
          sessionId: prevRoute.sessionId,
          loaderId: "",
          authoritative: false,
          ...(prevRoute.parentFrameId ? { parentFrameId: prevRoute.parentFrameId } : {}),
        });
      }
    }
    return snapshotFrames;
  }

  private async reconcileSoftDetachedChildFrames(
    tabId: number,
    attachingEntry: Extract<TabAttachment, { kind: "attaching" }>,
    previousSoftDetach: SoftDetachSnapshot,
    check: () => void,
  ): Promise<void> {
    await this.drainFrameAttachTasks(tabId);
    check();

    const sources: CdpFrameTreeSource[] = [];
    try {
      let rootReply: unknown;
      const ok = await cleanupWait(
        this.api.sendCommand({ tabId }, "Page.getFrameTree", {}).then((res) => {
          rootReply = res;
        }),
      );
      const tree = ok
        ? (rootReply as { frameTree?: CdpFrameTreeNode } | undefined)?.frameTree
        : undefined;
      if (tree) sources.push({ target: { tabId }, tree });
    } catch {
      // Root failure is surfaced by root signature checks or subsequent reads.
    }
    check();

    const sessions = [...attachingEntry.frameDiscovery.sessions];
    await Promise.all(
      sessions.map(async (sessionId) => {
        try {
          let reply: unknown;
          const ok = await cleanupWait(
            this.api.sendCommand({ tabId, sessionId }, "Page.getFrameTree", {}).then((res) => {
              reply = res;
            }),
          );
          const tree = ok
            ? (reply as { frameTree?: CdpFrameTreeNode } | undefined)?.frameTree
            : undefined;
          if (tree?.frame?.id) {
            attachingEntry.frameDiscovery.frameIds.set(sessionId, tree.frame.id);
            sources.push({ target: { tabId, sessionId }, tree });
          }
        } catch {
          // Unreadable child target fails continuity check below and invalidates its frameId.
        }
      }),
    );
    check();

    if (sources.length > 0) {
      this.syncRoutesFromSources(attachingEntry, sources);
    }

    const rootFrameId = previousSoftDetach.rootSignature.frameId;
    const staleFrameIds = new Set<string>();
    for (const [frameId, prevRoute] of previousSoftDetach.frames) {
      if (frameId === rootFrameId && !prevRoute.parentFrameId && !prevRoute.sessionId) continue;
      const nextRoute = attachingEntry.frames.get(frameId);
      if (
        !sameChildFrameRoute(prevRoute, nextRoute) ||
        (nextRoute?.sessionId !== undefined &&
          !attachingEntry.frameDiscovery.sessions.has(nextRoute.sessionId))
      ) {
        staleFrameIds.add(frameId);
      }
    }

    if (staleFrameIds.size > 0) {
      if (this.options.onChildFramesInvalidated) {
        this.options.onChildFramesInvalidated(tabId, staleFrameIds);
      } else {
        this.options.onDocumentChanged?.(tabId);
      }
    }
  }

  private async softDetachIdleTab(tabId: number): Promise<void> {
    this.clearIdleTimer(tabId);
    if (!this.canSoftDetachIdleTab(tabId)) return;
    const beforeEntry = this.tabs.get(tabId);
    if (beforeEntry?.kind !== "attached") return;
    const versionBeforeProbe = beforeEntry.version;

    const rootTreeBox: { tree?: CdpFrameTreeNode } = {};
    const preDetachDoc = await this.probeRootDocumentSignature(tabId, rootTreeBox);
    const midEntry = this.tabs.get(tabId);
    if (
      midEntry?.kind !== "attached" ||
      midEntry.version !== versionBeforeProbe ||
      midEntry.idleTimer !== undefined ||
      !this.canSoftDetachIdleTab(tabId)
    ) {
      return;
    }

    const preDetachFrames = await this.captureSnapshotFramesForSoftDetach(
      tabId,
      midEntry,
      rootTreeBox.tree,
      preDetachDoc,
    );
    const liveEntry = this.tabs.get(tabId);
    if (
      liveEntry?.kind !== "attached" ||
      liveEntry.version !== versionBeforeProbe ||
      liveEntry.idleTimer !== undefined ||
      !this.canSoftDetachIdleTab(tabId)
    ) {
      return;
    }

    liveEntry.history.softDetachConsoleWaterMark =
      maxConsoleTimestamp(liveEntry.history.consoleBuffer) ??
      liveEntry.history.softDetachConsoleWaterMark;

    const softDetachedEntry: Extract<TabAttachment, { kind: "soft_detached" }> = {
      kind: "soft_detached",
      version: liveEntry.version + 1,
      snapshot: {
        attachmentId: liveEntry.attachmentId,
        rootSignature: preDetachDoc,
        frames: preDetachFrames,
      },
      leases: liveEntry.leases,
      eventListeners: liveEntry.eventListeners,
      history: liveEntry.history,
    };
    this.tabs.set(tabId, softDetachedEntry);

    this.options.onSoftDetached?.(tabId);
    this.backgroundExecution.invalidate(tabId);
    this.readGate.reset(tabId);

    const detachWork = (async () => {
      try {
        await this.api.detach({ tabId });
      } catch (err) {
        console.debug("[bsk cdp] idle soft-detach failed (likely tab already closed)", err);
      }
    })().finally(() => {
      const current = this.tabs.get(tabId);
      if (current === softDetachedEntry && current.detachInFlight === detachWork) {
        current.detachInFlight = undefined;
      }
    });
    softDetachedEntry.detachInFlight = detachWork;
    await cleanupWait(detachWork);
  }

  private async command(
    target: CdpDebuggee,
    method: string,
    params: object,
    readTimeoutMs?: number,
    beforeDispatch?: () => void,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const { tabId } = target;
    const entryBefore = typeof tabId === "number" ? this.tabs.get(tabId) : undefined;
    const discoveryBefore =
      method === "Page.getFrameTree" && isActiveAttachment(entryBefore)
        ? entryBefore.frameDiscovery
        : undefined;
    const rootEpochBefore = discoveryBefore?.rootNavigationEpoch;
    const version = entryBefore?.version ?? 0;
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
    if (discoveryBefore && typeof tabId === "number") {
      const entryAfter = this.tabs.get(tabId);
      if (
        isActiveAttachment(entryAfter) &&
        entryAfter.frameDiscovery === discoveryBefore &&
        entryAfter.version === version &&
        (Boolean(target.sessionId) ||
          entryAfter.frameDiscovery.rootNavigationEpoch === rootEpochBefore)
      ) {
        const frameTree = (result as { frameTree?: CdpFrameTreeNode } | undefined)?.frameTree;
        if (frameTree) {
          this.harvestTreeIntoRoutes(
            entryAfter,
            { tabId, ...(target.sessionId ? { sessionId: target.sessionId } : {}) },
            frameTree,
            true,
          );
        }
      }
    }
    return result;
  }

  private async enablePageDomain(tabId: number): Promise<void> {
    await this.command({ tabId }, "Page.enable", {});
  }

  private async enableConsoleDomains(tabId: number, signal?: AbortSignal): Promise<void> {
    const entry = this.tabs.get(tabId);
    if (entry?.kind !== "attached") throw new Error("debugger detached");
    const attachmentId = entry.attachmentId;
    const check = () => {
      signal?.throwIfAborted();
      if (this.getAttachmentId(tabId) !== attachmentId)
        throw new Error("Debugger attachment changed during console capture");
    };
    check();
    if (entry.domains.consoleEnabled) return;
    await this.command({ tabId }, "Runtime.enable", {}, READ_TIMEOUT_MS, check, signal);
    check();
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
    await this.command(
      { tabId },
      "Runtime.evaluate",
      { expression: "0", returnByValue: true, silent: true },
      READ_TIMEOUT_MS,
      check,
      signal,
    );
    check();
    const current = this.tabs.get(tabId);
    if (current?.kind === "attached" && current.attachmentId === attachmentId) {
      current.history.softDetachConsoleWaterMark = undefined;
      if (logEnabled) current.domains.consoleEnabled = true;
    }
  }

  private async enableNetworkDomain(tabId: number): Promise<void> {
    const entry = this.tabs.get(tabId);
    if (!isActiveAttachment(entry) || entry.domains.networkEnabled) return;
    if (!entry.domains.passiveNetworkEnabled) {
      await this.command({ tabId }, "Network.enable", {});
      const current = this.tabs.get(tabId);
      if (isActiveAttachment(current)) current.domains.passiveNetworkEnabled = true;
    }
    const current = this.tabs.get(tabId);
    if (isActiveAttachment(current)) current.domains.networkEnabled = true;
  }

  private async enableNetworkDomainBestEffort(tabId: number): Promise<void> {
    const entry = this.tabs.get(tabId);
    if (
      !isActiveAttachment(entry) ||
      entry.domains.passiveNetworkEnabled ||
      entry.domains.networkEnabled
    ) {
      return;
    }
    try {
      await this.command({ tabId }, "Network.enable", {});
      const current = this.tabs.get(tabId);
      if (isActiveAttachment(current)) current.domains.passiveNetworkEnabled = true;
    } catch (err) {
      console.debug("[bsk cdp] network domain enable failed", { tabId, err });
    }
  }

  private enableFrameDiscovery(target: CdpTarget): Promise<void> {
    const entry = this.tabs.get(target.tabId);
    if (!isActiveAttachment(entry)) return Promise.resolve();
    const state = entry.frameDiscovery;
    const key = target.sessionId ?? "root";
    const existing = state.enabled.get(key);
    if (existing) return existing;
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
        if ((!issued || !(error instanceof CdpReadTimeoutError)) && state.enabled.get(key) === work)
          state.enabled.delete(key);
        throw error;
      });
    state.enabled.set(key, work);
    return work;
  }

  private bindEvents(): void {
    if (this.eventSubscription) return;
    const listener = (source: CdpDebuggee, method: string, params: unknown) => {
      const tabId = source.tabId;
      if (typeof tabId !== "number") return;
      this.handleDialogEvent(tabId, source, method, params);
      this.handleConsoleEvent(tabId, method, params);
      this.handleNetworkEvent(tabId, method, params);
      this.handleFrameTargetEvent(tabId, source, method, params);
      const entry = this.tabs.get(tabId);
      if (entry?.eventListeners.size) {
        for (const subscriber of [...entry.eventListeners]) {
          try {
            subscriber(source, method, params);
          } catch (err) {
            console.debug("[bsk cdp] tab event subscriber threw", { tabId, method, err });
          }
        }
      }
    };
    this.api.onEvent.addListener(listener);
    this.eventSubscription = {
      dispose: () => this.api.onEvent.removeListener(listener),
    };
  }

  private handleFrameTargetEvent(
    tabId: number,
    source: CdpDebuggee,
    method: string,
    params: unknown,
  ): void {
    const entry = this.tabs.get(tabId);
    if (!isActiveAttachment(entry)) return;
    const raw = (params ?? {}) as Record<string, unknown>;
    const frame = raw.frame as
      | {
          id?: string;
          parentId?: string;
          loaderId?: string;
          url?: string;
          urlFragment?: string;
        }
      | undefined;

    if (
      !source.sessionId &&
      frame?.id &&
      !frame.parentId &&
      (method === "Page.frameNavigated" || method === "Page.documentOpened")
    ) {
      entry.frameDiscovery.rootFrameId = frame.id;
      entry.frameDiscovery.rootNavigationEpoch += 1;
    }

    if (method === "Page.frameNavigated" && typeof frame?.id === "string" && frame.id) {
      if (!source.sessionId && !frame.parentId) {
        entry.frames.clear();
        entry.frames.set(frame.id, {
          loaderId: typeof frame.loaderId === "string" ? frame.loaderId : "",
          authoritative: true,
          ...(typeof frame.url === "string" ? { url: frame.url } : {}),
          ...(typeof frame.urlFragment === "string" ? { urlFragment: frame.urlFragment } : {}),
        });
      } else {
        const existing = entry.frames.get(frame.id);
        entry.frames.set(frame.id, {
          ...(source.sessionId ? { sessionId: source.sessionId } : {}),
          loaderId: typeof frame.loaderId === "string" ? frame.loaderId : "",
          authoritative: true,
          ...(frame.parentId || existing?.parentFrameId
            ? { parentFrameId: frame.parentId ?? existing?.parentFrameId }
            : {}),
          ...(typeof frame.url === "string" ? { url: frame.url } : {}),
          ...(typeof frame.urlFragment === "string" ? { urlFragment: frame.urlFragment } : {}),
        });
      }
    } else if (method === "Page.documentOpened" && typeof frame?.id === "string" && frame.id) {
      const existing = entry.frames.get(frame.id);
      if (existing) {
        existing.documentElementBackendNodeId = undefined;
        existing.documentOpened = true;
        if (typeof frame.loaderId === "string" && frame.loaderId) {
          existing.loaderId = frame.loaderId;
        }
      } else {
        entry.frames.set(frame.id, {
          ...(source.sessionId ? { sessionId: source.sessionId } : {}),
          loaderId: typeof frame.loaderId === "string" ? frame.loaderId : "",
          authoritative: Boolean(frame.loaderId) || !frame.parentId,
          ...(frame.parentId ? { parentFrameId: frame.parentId } : {}),
          ...(typeof frame.url === "string" ? { url: frame.url } : {}),
          documentOpened: true,
        });
      }
    } else if (method === "DOM.documentUpdated") {
      for (const route of entry.frames.values()) {
        if ((route.sessionId ?? undefined) === (source.sessionId ?? undefined)) {
          route.documentElementBackendNodeId = undefined;
        }
      }
    } else if (method === "Page.frameDetached" && typeof raw.frameId === "string") {
      entry.frames.delete(raw.frameId);
    }

    const rootRouteChanged =
      method === "Page.navigatedWithinDocument" && raw.frameId === entry.frameDiscovery.rootFrameId;
    if (
      !source.sessionId &&
      (rootRouteChanged ||
        method === "DOM.documentUpdated" ||
        ((method === "Page.frameNavigated" || method === "Page.documentOpened") &&
          frame &&
          !frame.parentId))
    ) {
      this.options.onDocumentChanged?.(tabId);
    }

    const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : undefined;
    if (!sessionId) return;

    if (method === "Target.detachedFromTarget") {
      const state = entry.frameDiscovery;
      state.enabled.delete(sessionId);
      state.frameIds.delete(sessionId);
      for (const [frameId, route] of entry.frames) {
        if (route.sessionId === sessionId) {
          entry.frames.delete(frameId);
        }
      }
      this.readGate.reset(tabId, sessionId);
      if (state.sessions.delete(sessionId)) state.generation += 1;
      return;
    }
    if (method !== "Target.attachedToTarget") return;
    const targetInfo = raw.targetInfo as { type?: string; targetId?: string } | undefined;
    if (targetInfo?.type && targetInfo.type !== "iframe") return;

    const state = entry.frameDiscovery;
    if (targetInfo?.type === "iframe" && typeof targetInfo.targetId === "string") {
      state.frameIds.set(sessionId, targetInfo.targetId);
      const existing = entry.frames.get(targetInfo.targetId);
      if (existing && existing.sessionId !== sessionId) {
        entry.frames.delete(targetInfo.targetId);
      }
    }
    if (state.sessions.has(sessionId)) return;
    state.sessions.add(sessionId);
    state.generation += 1;

    const task = this.initializeFrameTarget({ tabId, sessionId });
    state.pending.add(task);
    void task.finally(() => {
      state.pending.delete(task);
    });
  }

  private retryChildFrameDiscovery(tabId: number): void {
    const entry = this.tabs.get(tabId);
    if (!isActiveAttachment(entry)) return;
    const state = entry.frameDiscovery;
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
      await this.command(target, "Page.enable", {}, READ_TIMEOUT_MS).catch((err) => {
        rethrowReadTimeout(err);
      });
    } catch (err) {
      if (err instanceof CdpReadTimeoutError) {
        console.debug("[bsk cdp] child frame discovery timed out", { target });
        return;
      }
      const entry = this.tabs.get(target.tabId);
      if (
        isActiveAttachment(entry) &&
        entry.frameDiscovery.sessions.delete(target.sessionId as string)
      ) {
        entry.frameDiscovery.generation += 1;
      }
      console.debug("[bsk cdp] child frame target initialization failed", { target, err });
    }
  }

  private async drainFrameAttachTasks(tabId: number): Promise<void> {
    const deadline = Date.now() + FRAME_DISCOVERY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const entry = this.tabs.get(tabId);
      const state = isActiveAttachment(entry) ? entry.frameDiscovery : undefined;
      const generation = state?.generation ?? 0;
      if (state?.pending.size && !(await settleBeforeDeadline([...state.pending], deadline))) break;

      const quietTime = Math.min(FRAME_DISCOVERY_QUIET_MS, deadline - Date.now());
      if (quietTime <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, quietTime));
      const latest = this.tabs.get(tabId);
      const current = isActiveAttachment(latest) ? latest.frameDiscovery : undefined;
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

  pendingDialogs(tabId?: number): PendingJavaScriptDialog[] {
    const result: PendingJavaScriptDialog[] = [];
    for (const [id, entry] of this.tabs) {
      if (tabId !== undefined && id !== tabId) continue;
      if (isActiveAttachment(entry) && entry.pendingDialog) {
        result.push({ ...entry.pendingDialog.dialog });
      }
    }
    return result;
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
    let pending: PendingDialogState | undefined;
    for (const tab of this.tabs.values()) {
      if (isActiveAttachment(tab) && tab.pendingDialog?.dialog.id === id) {
        pending = tab.pendingDialog;
        break;
      }
    }
    if (!pending) throw new Error("Dialog is no longer pending");
    if (pending.resolving) throw new Error("Dialog decision is already in progress");
    if (text !== undefined && (!accept || pending.dialog.type !== "prompt"))
      throw new Error("text is only valid when accepting a prompt");
    guard.signal?.throwIfAborted();
    const dialogTabId = pending.dialog.tab_id;
    if (this.options.canControlDialog && !(await this.options.canControlDialog(dialogTabId)))
      throw new Error("Tab is no longer agent controlled");
    const currentPending = () => {
      const tab = this.tabs.get(dialogTabId);
      return isActiveAttachment(tab) ? tab.pendingDialog : undefined;
    };
    if (currentPending() !== pending) throw new Error("Dialog is no longer pending");
    if (pending.resolving) throw new Error("Dialog decision is already in progress");
    pending.resolving = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let closeListener: ((result: JavaScriptDialogInfo | Error) => void) | undefined;
    const closed = new Promise<JavaScriptDialogInfo>((resolve, reject) => {
      closeListener = (result) => (result instanceof Error ? reject(result) : resolve(result));
      pending.closed.add(closeListener);
      timeout = setTimeout(() => reject(new Error("Browser did not confirm dialog closure")), 2000);
    });
    void closed.catch(() => {});
    try {
      const activeAttachment = () => this.activeOrAttachingId(dialogTabId);
      if (activeAttachment() !== pending.attachmentId) {
        throw new Error("Debugger attachment changed before dispatch");
      }
      await this.command(
        { ...pending.source, tabId: dialogTabId },
        "Page.handleJavaScriptDialog",
        {
          accept,
          ...(accept && pending.dialog.type === "prompt"
            ? { promptText: text ?? pending.defaultPrompt ?? "" }
            : {}),
        },
        undefined,
        () => {
          guard.signal?.throwIfAborted();
          if (activeAttachment() !== pending.attachmentId)
            throw new Error("Debugger attachment changed before dispatch");
          if (currentPending() !== pending)
            throw new Error("Dialog changed before native dispatch");
          guard.onDispatch?.();
        },
        guard.signal,
      );
      const result = await closed;
      await this.verifyRootDocumentAfterDialog(dialogTabId);
      return result;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (closeListener) pending.closed.delete(closeListener);
      pending.resolving = false;
    }
  }

  private async verifyRootDocumentAfterDialog(tabId: number): Promise<void> {
    const entry = this.tabs.get(tabId);
    if (entry?.kind !== "attached" || !entry.deferredRootCheck || entry.openDialog) return;
    const pending = entry.deferredRootCheck;
    const version = entry.version;
    pending.verification ??= (async () => {
      try {
        const current = await this.probeRootDocumentSignature(tabId);
        const live = this.tabs.get(tabId);
        if (live?.kind !== "attached" || live.deferredRootCheck !== pending || live.openDialog)
          return;
        live.deferredRootCheck = undefined;
        if (current.dialogOpen || !sameRootDocumentSignature(pending.expected, current)) {
          live.attachmentId = crypto.randomUUID();
          this.options.onDocumentChanged?.(tabId);
        }
      } finally {
        pending.verification = undefined;
        const live = this.tabs.get(tabId);
        if (live?.kind === "attached" && live.version === version) {
          this.touchTabActivity(tabId);
        }
      }
    })();
    await pending.verification;
  }

  private handleDialogEvent(
    tabId: number,
    source: CdpDebuggee,
    method: string,
    params: unknown,
  ): void {
    const entry = this.tabs.get(tabId);
    if (!isActiveAttachment(entry)) return;
    if (method === "Page.javascriptDialogOpening") {
      if (!this.activeOrAttachingId(tabId)) return;
      const generation = entry.history.dialogGeneration + 1;
      entry.history.dialogGeneration = generation;
      const opening = this.onJavaScriptDialogOpening(source, params, generation);
      const latest = this.tabs.get(tabId);
      if (isActiveAttachment(latest) && latest.history.dialogGeneration === generation) {
        latest.openDialog = opening;
      }
    } else if (method === "Page.javascriptDialogClosed") {
      entry.history.dialogGeneration += 1;
      entry.openDialog = undefined;
      this.touchTabActivity(tabId);
      if (entry.deferredRootCheck) {
        void this.verifyRootDocumentAfterDialog(tabId).catch((err) => {
          console.debug("[bsk cdp] post-dialog document verification failed", { tabId, err });
        });
      }
      const pending = entry.pendingDialog;
      if (!pending) return;
      const info: JavaScriptDialogInfo = {
        tab_id: tabId,
        type: pending.dialog.type,
        message: pending.dialog.message,
        url: pending.dialog.url,
        default_prompt: pending.dialog.default_prompt,
        has_browser_handler: pending.hasBrowserHandler,
        handled: (params as { result?: boolean })?.result ? "accepted" : "dismissed",
        sequence: pending.dialog.sequence,
      };
      clearTimeout(pending.timer);
      entry.pendingDialog = undefined;
      appendBoundedList(entry.history.dialogBuffer, info, MAX_DIALOG_BUFFER);
      for (const close of pending.closed) close(info);
      this.emitDialogChanged(tabId, null);
    }
  }

  private async onJavaScriptDialogOpening(
    source: CdpDebuggee,
    params: unknown,
    generation: number,
  ): Promise<void> {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    this.touchTabActivity(tabId);
    const attachmentId = this.activeOrAttachingId(tabId);
    const initial = this.tabs.get(tabId);
    if (!attachmentId || !isActiveAttachment(initial)) return;
    const attachmentVersion = initial.version;
    const parsed = parseDialogOpeningParams(params);
    try {
      if (this.options.canControlDialog && !(await this.options.canControlDialog(tabId))) return;
      const currentAttachmentId = this.activeOrAttachingId(tabId);
      const current = this.tabs.get(tabId);
      if (
        !currentAttachmentId ||
        !isActiveAttachment(current) ||
        current.version !== attachmentVersion ||
        current.history.dialogGeneration !== generation
      )
        return;
      const sequence = current.history.dialogSequence + 1;
      current.history.dialogSequence = sequence;
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
        const live = this.tabs.get(tabId);
        if (!isActiveAttachment(live) || live.pendingDialog?.dialog.id !== dialog.id) return;
        this.emitDialogChanged(tabId, dialog, "decision_timeout");
        void this.resolveDialog(dialog.id, false).catch(() => {});
      }, 60000);
      current.pendingDialog = {
        dialog,
        source,
        attachmentId: currentAttachmentId,
        defaultPrompt: parsed.defaultPrompt,
        hasBrowserHandler: parsed.hasBrowserHandler,
        resolving: false,
        timer,
        closed: new Set(),
      };
      this.emitDialogChanged(tabId, dialog);
    } catch (error) {
      console.debug("[bsk cdp] dialog state unavailable", error);
    }
  }

  private handleConsoleEvent(tabId: number, method: string, params: unknown): void {
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
  }

  private appendConsole(tabId: number, parsed: ParsedConsoleEntry | null): void {
    if (!parsed) return;
    const entry = this.ensureTabEntry(tabId);
    const waterMark = entry.history.softDetachConsoleWaterMark;
    if (
      waterMark !== undefined &&
      typeof parsed.timestamp === "number" &&
      parsed.timestamp <= waterMark
    ) {
      return;
    }
    const sequence = entry.history.consoleSequence + 1;
    entry.history.consoleSequence = sequence;
    appendBoundedList(entry.history.consoleBuffer, { ...parsed, sequence }, MAX_CONSOLE_BUFFER);
  }

  private handleNetworkEvent(tabId: number, method: string, params: unknown): void {
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
  }

  private appendNetwork(tabId: number, parsed: ParsedNetworkEntry | null): void {
    if (!parsed) return;
    const entry = this.ensureTabEntry(tabId);
    const sequence = entry.history.networkSequence + 1;
    entry.history.networkSequence = sequence;
    appendBoundedList(entry.history.networkBuffer, { ...parsed, sequence }, MAX_NETWORK_BUFFER);
  }

  /** Remember `requestWillBeSent` metadata so responses/failures can be attributed. */
  private rememberNetworkRequest(tabId: number, params: unknown): void {
    const entry = this.tabs.get(tabId);
    if (!isActiveAttachment(entry)) return;
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
    const tabMeta = entry.networkRequestMeta;
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
  }

  /** Keep metadata through response headers; consume it only when loading ends. */
  private getNetworkRequest(
    tabId: number,
    params: unknown,
    finished = false,
  ): NetworkRequestMeta | undefined {
    const entry = this.tabs.get(tabId);
    if (!isActiveAttachment(entry)) return undefined;
    const raw = (params ?? {}) as Record<string, unknown>;
    const id = typeof raw.requestId === "string" ? raw.requestId : undefined;
    if (!id) return undefined;
    const info = entry.networkRequestMeta.get(id);
    if (finished) entry.networkRequestMeta.delete(id);
    return info;
  }

  private bindAutoDetach(): void {
    if (this.detachSubscription) return;
    const listener = (source: chrome.debugger.Debuggee, reason: string) => {
      const tabId = source.tabId;
      if (typeof tabId !== "number") return;
      this.clearIdleTimer(tabId);
      const entry = this.tabs.get(tabId);
      this.options.onDocumentChanged?.(tabId);
      if (entry) {
        this.closePendingDialogOnDetach(tabId, entry);
        this.clearRetainLeases(entry);
        if (reason === "target_closed") {
          entry.leases.clear();
          entry.eventListeners.clear();
          entry.history.claims.clear();
          entry.history.owners.clear();
          this.backgroundExecution.forget(tabId);
        }
        this.resetDiagnosticHistory(entry.history);
        this.tabs.set(tabId, {
          kind: "detached",
          version: entry.version + 1,
          detachInFlight:
            entry.kind === "detached" || entry.kind === "soft_detached"
              ? entry.detachInFlight
              : undefined,
          fencedAttach:
            entry.kind === "attaching"
              ? entry.attachInFlight
              : entry.kind === "detached"
                ? entry.fencedAttach
                : undefined,
          leases: entry.leases,
          eventListeners: entry.eventListeners,
          history: entry.history,
        });
        this.maybePruneDetachedEntry(tabId);
      } else if (reason === "target_closed") {
        this.backgroundExecution.forget(tabId);
      }
      this.backgroundExecution.invalidate(tabId);
      this.readGate.reset(tabId);
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
    for (const [tabId, entry] of this.tabs) {
      this.closePendingDialogOnDetach(tabId, entry);
      if (isActiveAttachment(entry)) {
        entry.openDialog = undefined;
        entry.deferredRootCheck = undefined;
      }
      entry.leases.clear();
      entry.eventListeners.clear();
    }
    this.dialogListeners.clear();
    this.detachSubscription?.dispose();
    this.detachSubscription = null;
    this.eventSubscription?.dispose();
    this.eventSubscription = null;
  }

  /** Detach tabs only when no other live session has claimed them. */
  async detachSession(sessionId: string): Promise<void> {
    const owned: number[] = [];
    for (const [tabId, entry] of this.tabs) {
      if (entry.history.owners.has(sessionId) || entry.history.claims.has(sessionId)) {
        owned.push(tabId);
      }
    }
    await Promise.all(owned.map((tabId) => this.releaseSessionTab(sessionId, tabId)));
  }

  /** Clean up ownership and fence any in-flight attachment when a tab closes. */
  forgetClosedTab(tabId: number): void {
    this.clearIdleTimer(tabId);
    const entry = this.tabs.get(tabId);
    if (entry) {
      entry.leases.clear();
      entry.eventListeners.clear();
      entry.history.claims.clear();
      entry.history.owners.clear();
    }
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
    for (const [tabId, entry] of this.tabs) {
      for (const sessionId of entry.history.owners) {
        if (!liveSessionIds.has(sessionId)) queueRelease(sessionId, tabId);
      }
      for (const sessionId of entry.history.claims.keys()) {
        if (!liveSessionIds.has(sessionId)) queueRelease(sessionId, tabId);
      }
    }
    await Promise.all(releases);
    if (generation !== this.syncGeneration) return;
    const unowned: Promise<void>[] = [];
    for (const [tabId, entry] of this.tabs) {
      const hasAttachmentState =
        entry.kind === "attached" ||
        entry.kind === "soft_detached" ||
        entry.kind === "attaching" ||
        Boolean(entry.detachInFlight);
      if (
        hasAttachmentState &&
        entry.history.owners.size === 0 &&
        entry.history.claims.size === 0
      ) {
        unowned.push(this.detach(tabId));
      }
    }
    await Promise.all(unowned);
  }
}

function appendBoundedList<T>(buffer: T[], entry: T, maxEntries: number): void {
  buffer.push(entry);
  while (buffer.length > maxEntries) buffer.shift();
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
async function cleanupWait(work: Promise<unknown>, timeoutMs = 1000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
