// Shared helpers used by every `tool.*` handler — target-tab
// resolution, session lookup, RpcError detection, and the minimal
// CDP-runner shape every handler depends on.
//
// Lives in its own module so M7+ navigation / interaction code reuses
// exactly the same sandbox + visibility rules as the M6 observation
// handlers (review parity).

import type { CdpDispatchGuard, DialogCursor } from "@/browser-driver/chromium-cdp";

export type { CdpDispatchGuard };

import {
  type FrameDocumentGraph,
  type FrameDocumentGraphOptions,
  type FrameDocumentHandle,
  type FrameNodeHandle,
  StaleFrameHandleError,
  type TabEventSource,
  toFrameDocumentHandle,
  toRootFrameHandle,
} from "@/browser-driver/frame-handles";
import type { NativeInputTimestamp } from "@/browser-driver/native-input-clock";
import { shareScreencasts } from "@/browser-driver/screencast-coordinator";
import {
  isAgentControlledTab,
  type SessionContext,
  type SessionManager,
} from "@/session-manager/manager";
import { normaliseRef } from "@/session-manager/ref-store";
import type {
  ConsoleResult,
  JavaScriptDialogInfo,
  PendingJavaScriptDialog,
  RpcError,
} from "@/transport/types";
import { rpcError } from "./errors";

const DEFAULT_BUFFERED_READ_LIMIT = 50;
const MAX_BUFFERED_READ_LIMIT = 200;
const DEFAULT_MAX_TEXT_CHARS = 1000;
const MAX_TEXT_CHARS = 4096;

/**
 * Subset of `chrome.tabs` we depend on across tool handlers. Kept on
 * a thin interface so vitest can inject a fake without monkey-patching
 * the global `chrome` object.
 */
export interface ChromeTabsApi {
  get(tabId: number): Promise<chrome.tabs.Tab>;
  query(query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
}

export const chromeTabsApi: ChromeTabsApi = {
  get: (tabId) => chrome.tabs.get(tabId),
  query: (q) => chrome.tabs.query(q),
};

export interface ResolvedTargetTab {
  tabId: number;
  windowId: number;
  active: boolean;
  url?: string;
  pendingUrl?: string;
}

export type { DialogCursor, FrameDocumentGraphOptions };

/**
 * Typed CDP driver surface every tool handler uses. Backed by `ChromiumCdp`
 * in production; unit tests construct typed stubs via `createStubCdpRunner`.
 *
 * Contextual `CooperationController` hooks (`runBrowserMutation`, `resourceCleanup`,
 * `beginDomMutation`, `verifyPointerTarget`) and shared-tab-stripped background
 * execution hooks (`acquireBackgroundExecution`, `ownsBackgroundExecution`,
 * `restoreBackgroundExecution`) remain capability-gated.
 */
export interface CdpRunner {
  /** Measure the browser's native epoch conversion before arming page input. */
  prepareInputTimestamp(): Promise<NativeInputTimestamp>;
  /** Fence a browser API effect at invocation, after asynchronous ownership checks. */
  runBrowserMutation?<T>(operation: () => Promise<T>): Promise<T>;
  /** Only release resources acquired by this request; never restore page/user state. */
  resourceCleanup?: CdpRunner;
  /** Validate the observed decision before a tool's own scripted form mutation. */
  beginDomMutation?(): Promise<void>;
  /** Shared control validates the live pointer target again after hover. */
  verifyPointerTarget?(
    target: { handle: FrameNodeHandle },
    point: { x: number; y: number },
    /** Intentional displacement from the observed action point, in viewport CSS pixels. */
    offset?: { x: number; y: number },
  ): Promise<void>;
  send<T = unknown>(
    tabId: number,
    method: string,
    params?: object,
    signal?: AbortSignal,
  ): Promise<T>;
  /** Stable frame/node handle dispatch; validates `frameId` + `loaderId` inside `ChromiumCdp`. */
  sendToFrame<T = unknown>(
    handle: FrameDocumentHandle | FrameNodeHandle,
    method: string,
    params?: object,
    guard?: CdpDispatchGuard,
  ): Promise<T>;
  getMainFrameHandle(tabId: number, signal?: AbortSignal): Promise<FrameDocumentHandle>;
  getFrameDocuments(
    tabId: number,
    signal?: AbortSignal,
    options?: FrameDocumentGraphOptions,
  ): Promise<FrameDocumentGraph>;
  isEventFromFrame(source: TabEventSource, handle: FrameDocumentHandle): boolean;
  hasOwnFrameTarget(tabId: number, frameId: string, parentFrameId?: string): boolean;
  recordFrameDocumentElement(
    tabId: number,
    frameId: string,
    loaderId: string,
    documentElementBackendNodeId: number,
  ): void;
  detach(tabId: number, expectedAttachmentId?: string): Promise<void>;
  getAttachmentId(tabId: number): string | undefined;
  retainTabAttachment(tabId: number): () => void;
  ensureAttachedToUrl(tabId: number, expectedUrl: string | undefined): Promise<void>;
  acquireBackgroundExecution?(sessionId: string, tabId: number): Promise<void>;
  /** Whether this session requests the persistent override, regardless of applied CDP state. */
  ownsBackgroundExecution?(sessionId: string, tabId: number): boolean;
  releaseBackgroundExecution(sessionId: string, tabId: number): Promise<void>;
  /** Resend this session's owned override, even when the applied-state cache reports it active. */
  restoreBackgroundExecution?(sessionId: string, tabId: number): Promise<void>;
  trackSessionTab(sessionId: string, tabId: number): void;
  releaseSessionTab(sessionId: string, tabId: number): Promise<void>;
  onEvent(
    tabId: number,
    handler: (source: TabEventSource, method: string, params: unknown) => void,
  ): {
    dispose(): void;
  };
  dialogCursor(tabId: number): DialogCursor;
  dialogsSince(tabId: number, cursor: DialogCursor): JavaScriptDialogInfo[];
  pendingDialogs(tabId?: number): PendingJavaScriptDialog[];
  resolveDialog(
    id: string,
    accept: boolean,
    text?: string,
    guard?: Pick<CdpDispatchGuard, "signal" | "onDispatch">,
  ): Promise<JavaScriptDialogInfo>;
  onDialogChanged(
    handler: (
      tabId: number,
      dialog: PendingJavaScriptDialog | null,
      reason?: "decision_timeout",
    ) => void,
  ): { dispose(): void };
  ensureConsoleCapture(tabId: number, signal?: AbortSignal): Promise<void>;
  consoleEntriesSince(
    tabId: number,
    since: number | undefined,
    limit: number,
    maxTextChars: number,
    includeStack: boolean,
  ): ConsoleResult;
}

export interface PinnedSelectorTarget {
  readonly handle: FrameNodeHandle;
  readonly backendNodeId: number;
  readonly frameId?: string;
  readonly usedSelector: string;
}

const pinnedSelectorTargets = new WeakMap<object, ReadonlyMap<string, PinnedSelectorTarget>>();

function sharePinnedSelectorTargets(source: object, target: object): void {
  const existing = pinnedSelectorTargets.get(source);
  if (existing) pinnedSelectorTargets.set(target, existing);
}

export function withPinnedSelectorTargets<T extends CdpRunner>(
  cdp: T,
  targets: ReadonlyMap<string, PinnedSelectorTarget>,
): T {
  const merged = new Map(pinnedSelectorTargets.get(cdp));
  for (const [selector, entry] of targets) merged.set(selector, entry);
  const wrapped = delegateCdpRunner(cdp, {});
  pinnedSelectorTargets.set(wrapped, merged);
  return wrapped;
}

export function lookupPinnedSelectorTarget(
  cdp: CdpRunner,
  tabId: number,
  selector: string,
): PinnedSelectorTarget | undefined {
  const entry = pinnedSelectorTargets.get(cdp)?.get(selector);
  return entry && entry.handle.tabId === tabId ? entry : undefined;
}

export interface DelegateCdpRunnerOptions<T extends CdpRunner = CdpRunner> {
  /** Keys hidden from both property lookup and the `in` operator. */
  omit?: ReadonlySet<PropertyKey>;
  /** Methods whose `this` should be bound to the wrapper Proxy (so internal `this.send` calls stay guarded). */
  bindReceiver?: ReadonlySet<PropertyKey>;
  /** Optional dynamic method interceptor (used by `sessionCdpRunner`). */
  intercept?: (target: T, key: PropertyKey, value: unknown, wrapper: T) => unknown;
}

/**
 * Wrap `base` via prototype-preserving delegation so overriding `send` /
 * `sendToFrame` / hooks never silently strips `CdpRunner` capabilities or
 * breaks `"method" in runner` invariants.
 */
export function delegateCdpRunner<T extends CdpRunner = CdpRunner>(
  base: T,
  overrides: Partial<CdpRunner>,
  options?: DelegateCdpRunnerOptions<T>,
): T {
  const omit = options?.omit;
  const bindReceiver = options?.bindReceiver;
  const intercept = options?.intercept;
  const wrapper = new Proxy(base, {
    has(target, key) {
      if (omit?.has(key)) return false;
      if (Object.prototype.hasOwnProperty.call(overrides, key)) {
        const desc = Object.getOwnPropertyDescriptor(overrides, key);
        if (desc?.get || desc?.value !== undefined) return true;
        return false;
      }
      return Reflect.has(target, key);
    },
    get(target, key, receiver) {
      if (omit?.has(key)) return undefined;
      if (Object.prototype.hasOwnProperty.call(overrides, key)) {
        const desc = Object.getOwnPropertyDescriptor(overrides, key);
        if (desc?.get) return desc.get.call(wrapper);
        if (desc?.value !== undefined) return desc.value;
      }
      const raw = Reflect.get(target, key, receiver === wrapper ? target : receiver);
      const intercepted = intercept ? intercept(target, key, raw, wrapper) : undefined;
      if (intercepted !== undefined) return intercepted;
      if (typeof raw !== "function") return raw;
      return bindReceiver?.has(key) ? raw.bind(wrapper) : raw.bind(target);
    },
  });
  shareScreencasts(base, wrapper);
  sharePinnedSelectorTargets(base, wrapper);
  return wrapper;
}

/**
 * Construct a complete, strongly-typed `CdpRunner` test double from a minimal
 * `{ send, ... }` partial so unit tests exercise the exact `sendToFrame` /
 * `getFrameDocuments` driver contract without polluting production `CdpRunner`
 * with optional mock-only methods.
 */
export type CdpRunnerStubOverrides = Partial<Omit<CdpRunner, "send">> & {
  send: (tabId: number, method: string, params?: object, signal?: AbortSignal) => Promise<unknown>;
};

export function createStubCdpRunner<T extends CdpRunnerStubOverrides>(
  overrides: T,
): CdpRunner & Omit<NoInfer<T>, keyof CdpRunner> {
  const { send, sendToFrame: rawSendToFrame, ...restOverrides } = overrides;
  const typedSend = send as CdpRunner["send"];
  const resolveSelf = (self: unknown): CdpRunner =>
    self !== null &&
    typeof self === "object" &&
    typeof (self as Partial<CdpRunner>).send === "function" &&
    typeof (self as Partial<CdpRunner>).getAttachmentId === "function"
      ? (self as CdpRunner)
      : stub;
  const applyDispatchGuard = (
    self: CdpRunner,
    handle: FrameDocumentHandle | FrameNodeHandle,
    guard?: CdpDispatchGuard,
  ) => {
    guard?.signal?.throwIfAborted();
    if (guard?.allowReattach === false && self.getAttachmentId(handle.tabId) === undefined) {
      throw new Error("debugger detached");
    }
    if (guard?.attachmentId !== undefined) {
      const currentAttachment = self.getAttachmentId(handle.tabId);
      if (currentAttachment !== guard.attachmentId) {
        throw new Error("Debugger attachment changed before dispatch");
      }
    }
    guard?.onDispatch?.();
  };

  let wrappedSendToFrame: CdpRunner["sendToFrame"] | undefined;
  if (rawSendToFrame) {
    const mockFn = rawSendToFrame as CdpRunner["sendToFrame"] & {
      getMockImplementation?: () => CdpRunner["sendToFrame"] | undefined;
      mockImplementation?: (fn: CdpRunner["sendToFrame"]) => unknown;
    };
    if (
      typeof mockFn.getMockImplementation === "function" &&
      typeof mockFn.mockImplementation === "function"
    ) {
      const impl = mockFn.getMockImplementation();
      if (impl && impl.length < 4) {
        mockFn.mockImplementation(async function <R = unknown>(
          this: unknown,
          handle: FrameDocumentHandle | FrameNodeHandle,
          _method: string,
          _params?: object,
          guard?: CdpDispatchGuard,
        ): Promise<R> {
          applyDispatchGuard(resolveSelf(this), handle, guard);
          return (await impl.apply(
            this,
            arguments as unknown as Parameters<CdpRunner["sendToFrame"]>,
          )) as R;
        });
      }
      wrappedSendToFrame = mockFn;
    } else if (rawSendToFrame.length < 4) {
      wrappedSendToFrame = async function <R = unknown>(
        this: unknown,
        handle: FrameDocumentHandle | FrameNodeHandle,
        _method: string,
        _params?: object,
        guard?: CdpDispatchGuard,
      ): Promise<R> {
        applyDispatchGuard(resolveSelf(this), handle, guard);
        return (await rawSendToFrame.apply(
          this,
          arguments as unknown as Parameters<CdpRunner["sendToFrame"]>,
        )) as R;
      };
    } else {
      wrappedSendToFrame = rawSendToFrame;
    }
  }

  const stub: CdpRunner = {
    prepareInputTimestamp: async () => ({
      timestamp: Date.now(),
      nativeTimestamp: Date.now() / 1000,
      assertValid: () => {},
    }),
    send: typedSend,
    sendToFrame: async function <R = unknown>(
      this: unknown,
      handle: FrameDocumentHandle | FrameNodeHandle,
      method: string,
      params?: object,
      guard?: CdpDispatchGuard,
    ): Promise<R> {
      const self = resolveSelf(this);
      applyDispatchGuard(self, handle, guard);
      if (guard?.signal !== undefined) {
        return self.send<R>(handle.tabId, method, params, guard.signal);
      }
      return params !== undefined
        ? self.send<R>(handle.tabId, method, params)
        : self.send<R>(handle.tabId, method);
    },
    getMainFrameHandle: async function (this: unknown, tabId: number, signal?: AbortSignal) {
      const self = resolveSelf(this);
      signal?.throwIfAborted();
      try {
        const tree = await (signal !== undefined
          ? self.send<{ frameTree?: { frame?: { id?: string; loaderId?: string } } }>(
              tabId,
              "Page.getFrameTree",
              {},
              signal,
            )
          : self.send<{ frameTree?: { frame?: { id?: string; loaderId?: string } } }>(
              tabId,
              "Page.getFrameTree",
              {},
            ));
        const rootFrame = tree?.frameTree?.frame;
        if (rootFrame?.id) {
          return toFrameDocumentHandle(tabId, {
            frameId: rootFrame.id,
            loaderId: rootFrame.loaderId ?? "",
          });
        }
      } catch (err) {
        if (
          err instanceof Error &&
          (err.name === "AbortError" || err.name === "CdpReadTimeoutError")
        ) {
          throw err;
        }
      }
      return toFrameDocumentHandle(tabId, { frameId: "root", loaderId: "" });
    },
    getFrameDocuments: async function (
      this: unknown,
      tabId: number,
      signal?: AbortSignal,
      _options?: FrameDocumentGraphOptions,
    ): Promise<FrameDocumentGraph> {
      const self = resolveSelf(this);
      signal?.throwIfAborted();
      try {
        type RawFrameNode = {
          frame?: {
            id?: string;
            parentId?: string;
            loaderId?: string;
            url?: string;
            urlFragment?: string;
          };
          childFrames?: RawFrameNode[];
        };
        const tree = await (signal !== undefined
          ? self.send<{ frameTree?: RawFrameNode }>(tabId, "Page.getFrameTree", {}, signal)
          : self.send<{ frameTree?: RawFrameNode }>(tabId, "Page.getFrameTree", {}));
        const rootFrame = tree?.frameTree?.frame;
        if (rootFrame?.id) {
          const rootLoaderId = rootFrame.loaderId ?? "";
          const frames: FrameDocumentGraph["frames"][number][] = [
            {
              handle: toFrameDocumentHandle(tabId, {
                frameId: rootFrame.id,
                loaderId: rootLoaderId,
              }),
              frameId: rootFrame.id,
              loaderId: rootLoaderId,
              ...(rootFrame.url ? { url: rootFrame.url } : {}),
              ...(rootFrame.urlFragment !== undefined
                ? { urlFragment: rootFrame.urlFragment }
                : {}),
              processKey: "root",
              isOutOfProcess: false,
            },
          ];
          const walkChildren = (children: RawFrameNode[] | undefined, fallbackParentId: string) => {
            for (const child of children ?? []) {
              if (!child.frame?.id) continue;
              const childLoader = child.frame.loaderId ?? "";
              frames.push({
                handle: toFrameDocumentHandle(tabId, {
                  frameId: child.frame.id,
                  loaderId: childLoader,
                }),
                frameId: child.frame.id,
                loaderId: childLoader,
                parentFrameId: child.frame.parentId ?? fallbackParentId,
                ...(child.frame.url ? { url: child.frame.url } : {}),
                ...(child.frame.urlFragment !== undefined
                  ? { urlFragment: child.frame.urlFragment }
                  : {}),
                processKey: "root",
                isOutOfProcess: false,
              });
              walkChildren(child.childFrames, child.frame.id);
            }
          };
          walkChildren(tree.frameTree?.childFrames, rootFrame.id);
          const attachmentId = self.getAttachmentId(tabId);
          return {
            ...(attachmentId !== undefined ? { attachmentId } : {}),
            rootFrameId: rootFrame.id,
            frames,
          };
        }
      } catch (err) {
        if (
          err instanceof Error &&
          (err.name === "AbortError" || err.name === "CdpReadTimeoutError")
        ) {
          throw err;
        }
      }
      const attachmentId = self.getAttachmentId(tabId);
      return {
        ...(attachmentId !== undefined ? { attachmentId } : {}),
        rootFrameId: "",
        frames: [],
      };
    },
    isEventFromFrame: (source, handle) =>
      source.tabId === handle.tabId && (!handle.frameId ? source.isRootTarget : true),
    hasOwnFrameTarget: () => false,
    recordFrameDocumentElement: () => {},
    detach: async () => {},
    getAttachmentId: () => "stub-attachment",
    retainTabAttachment: () => () => {},
    ensureAttachedToUrl: async () => {},
    releaseBackgroundExecution: async () => {},
    trackSessionTab: () => {},
    releaseSessionTab: async () => {},
    onEvent: () => ({ dispose: () => {} }),
    dialogCursor: () => 0,
    dialogsSince: () => [],
    pendingDialogs: () => [],
    resolveDialog: async () => {
      throw new Error("No pending JavaScript dialog");
    },
    onDialogChanged: () => ({ dispose: () => {} }),
    ensureConsoleCapture: async () => {},
    consoleEntriesSince: (tabId) => ({
      tab_id: tabId,
      entries: [],
      next_since: 0,
      truncated: false,
    }),
    ...restOverrides,
    ...(wrappedSendToFrame ? { sendToFrame: wrappedSendToFrame } : {}),
  };
  return stub as CdpRunner & NoInfer<T>;
}

export function sendToFrameHandle<T = unknown>(
  cdp: CdpRunner,
  handle: FrameDocumentHandle | FrameNodeHandle,
  method: string,
  params?: object,
  guard?: CdpDispatchGuard,
): Promise<T> {
  if (guard !== undefined) {
    return cdp.sendToFrame<T>(handle, method, params, guard);
  }
  return params !== undefined
    ? cdp.sendToFrame<T>(handle, method, params)
    : cdp.sendToFrame<T>(handle, method);
}

const RELEASE_OBJECT_METHODS = new Set(["Runtime.releaseObjectGroup", "Runtime.releaseObject"]);

function buildFrameCleanupGuard(
  baseGuard: CdpDispatchGuard | undefined,
  callGuard: CdpDispatchGuard | undefined,
): CdpDispatchGuard {
  const attachmentId = callGuard?.attachmentId ?? baseGuard?.attachmentId;
  const ignoreFrameNavigation =
    callGuard?.ignoreFrameNavigation ?? baseGuard?.ignoreFrameNavigation;
  return {
    ...(attachmentId !== undefined ? { attachmentId } : {}),
    ...(ignoreFrameNavigation !== undefined ? { ignoreFrameNavigation } : {}),
    allowReattach: false,
  };
}

export function cdpRunnerForFrame(
  cdp: CdpRunner,
  handle: FrameDocumentHandle | FrameNodeHandle,
  guard?: CdpDispatchGuard,
): CdpRunner {
  const remapTarget = (
    target: FrameDocumentHandle | FrameNodeHandle,
  ): FrameDocumentHandle | FrameNodeHandle =>
    target.tabId === handle.tabId && !target.frameId && !target.loaderId ? handle : target;
  const resourceCleanup = cdp.resourceCleanup
    ? delegateCdpRunner(cdp.resourceCleanup, {
        send: <T = unknown>(_tabId: number, method: string, params?: object) =>
          cdp.resourceCleanup!.sendToFrame<T>(
            handle,
            method,
            params,
            buildFrameCleanupGuard(guard, undefined),
          ),
        sendToFrame: <T = unknown>(
          target: FrameDocumentHandle | FrameNodeHandle,
          method: string,
          params?: object,
          callGuard?: CdpDispatchGuard,
        ) =>
          cdp.resourceCleanup!.sendToFrame<T>(
            remapTarget(target),
            method,
            params,
            buildFrameCleanupGuard(guard, callGuard),
          ),
      })
    : undefined;
  return delegateCdpRunner(cdp, {
    ...(resourceCleanup ? { resourceCleanup } : {}),
    send: <T = unknown>(_tabId: number, method: string, params?: object, signal?: AbortSignal) => {
      if (RELEASE_OBJECT_METHODS.has(method)) {
        return (cdp.resourceCleanup ?? cdp).sendToFrame<T>(
          handle,
          method,
          params,
          buildFrameCleanupGuard(guard, undefined),
        );
      }
      const effectiveGuard = signal && !guard?.signal ? { ...guard, signal } : guard;
      if (effectiveGuard !== undefined) {
        return cdp.sendToFrame<T>(handle, method, params, effectiveGuard);
      }
      return params !== undefined
        ? cdp.sendToFrame<T>(handle, method, params)
        : cdp.sendToFrame<T>(handle, method);
    },
    sendToFrame: <T = unknown>(
      target: FrameDocumentHandle | FrameNodeHandle,
      method: string,
      params?: object,
      callGuard?: CdpDispatchGuard,
    ) => {
      const remapped = remapTarget(target);
      if (RELEASE_OBJECT_METHODS.has(method)) {
        return (cdp.resourceCleanup ?? cdp).sendToFrame<T>(
          remapped,
          method,
          params,
          buildFrameCleanupGuard(guard, callGuard),
        );
      }
      const mergedGuard =
        guard || callGuard
          ? {
              ...guard,
              ...callGuard,
              signal: callGuard?.signal ?? guard?.signal,
            }
          : undefined;
      if (mergedGuard !== undefined) {
        return cdp.sendToFrame<T>(remapped, method, params, mergedGuard);
      }
      return params !== undefined
        ? cdp.sendToFrame<T>(remapped, method, params)
        : cdp.sendToFrame<T>(remapped, method);
    },
  });
}

/**
 * Deterministic RAII scope for a CDP V8 `objectGroup`. Always calls
 * `Runtime.releaseObjectGroup` via `cdp.resourceCleanup ?? cdp` on exit
 * (including errors and cancellation) without resurrecting detached tabs.
 */
export async function withObjectGroup<T>(
  cdp: CdpRunner,
  target: number | FrameDocumentHandle | FrameNodeHandle,
  prefix: string,
  fn: (objectGroup: string) => Promise<T>,
): Promise<T> {
  const objectGroup = `${prefix}-${crypto.randomUUID()}`;
  const cleanup = cdp.resourceCleanup ?? cdp;
  const handle = typeof target === "number" ? toRootFrameHandle(target) : target;
  try {
    return await fn(objectGroup);
  } finally {
    try {
      await cleanup.sendToFrame(
        handle,
        "Runtime.releaseObjectGroup",
        { objectGroup },
        { allowReattach: false },
      );
    } catch {
      // Never let cleanup failures (detached tab, unowned tab, or navigated frame) mask caller outcome.
    }
  }
}

/**
 * Deterministic RAII scope for an individual V8 `RemoteObject` (`objectId`).
 * Always calls `Runtime.releaseObject` via `cdp.resourceCleanup ?? cdp` on exit
 * without resurrecting detached tabs.
 */
export async function withRemoteObject<T>(
  cdp: CdpRunner,
  target: number | FrameDocumentHandle | FrameNodeHandle,
  objectId: string,
  fn: (objectId: string) => Promise<T>,
): Promise<T> {
  const cleanup = cdp.resourceCleanup ?? cdp;
  const handle = typeof target === "number" ? toRootFrameHandle(target) : target;
  try {
    return await fn(objectId);
  } finally {
    try {
      await cleanup.sendToFrame(
        handle,
        "Runtime.releaseObject",
        { objectId },
        { allowReattach: false },
      );
    } catch {
      // Never let cleanup failures (detached tab, unowned tab, or navigated frame) mask caller outcome.
    }
  }
}

export { toFrameDocumentHandle, toRootFrameHandle };

const sessionRunners = new WeakMap<object, Map<string, CdpRunner>>();
const TAB_SCOPED_CDP_METHODS = new Set<PropertyKey>([
  "getFrameDocuments",
  "getMainFrameHandle",
  "ensureAttached",
  "ensureAttachedToUrl",
  "ensureConsoleCapture",
  "ensureNetworkCapture",
  "setDeviceMetricsOverride",
  "clearDeviceMetricsOverride",
  "setUserAgentOverride",
  "setTouchEmulationEnabled",
]);

/**
 * Bind a CDP runner to `sessionId` so any tab-attaching command automatically
 * records session ownership before touching the tab's debugger connection.
 */
export function sessionCdpRunner<T extends CdpRunner>(
  cdp: T,
  sessionId: string,
  isLive?: () => boolean,
): T {
  let bySession = sessionRunners.get(cdp);
  const existing = bySession?.get(sessionId);
  if (existing) return existing as T;

  const track = (tabId: number) => {
    if (typeof tabId === "number" && (!isLive || isLive())) {
      cdp.trackSessionTab(sessionId, tabId);
    }
  };
  const wrapper = delegateCdpRunner<T>(
    cdp,
    {
      send: <R = unknown>(
        tabId: number,
        method: string,
        params?: object,
        signal?: AbortSignal,
      ): Promise<R> => {
        track(tabId);
        if (signal !== undefined) {
          return cdp.send<R>(tabId, method, params, signal);
        }
        return params !== undefined
          ? cdp.send<R>(tabId, method, params)
          : cdp.send<R>(tabId, method);
      },
      sendToFrame: <R = unknown>(
        handle: FrameDocumentHandle | FrameNodeHandle,
        method: string,
        params?: object,
        guard?: CdpDispatchGuard,
      ): Promise<R> => {
        if (guard?.attachmentId === undefined && guard?.allowReattach !== false) {
          track(handle.tabId);
        }
        if (guard !== undefined) {
          return cdp.sendToFrame<R>(handle, method, params, guard);
        }
        return params !== undefined
          ? cdp.sendToFrame<R>(handle, method, params)
          : cdp.sendToFrame<R>(handle, method);
      },
    },
    {
      intercept: (target, key, raw, self) => {
        if (!TAB_SCOPED_CDP_METHODS.has(key) || typeof raw !== "function") return undefined;
        return function (this: unknown, tabId: number, ...rest: unknown[]) {
          track(tabId);
          return (raw as (tabId: number, ...args: unknown[]) => unknown).call(
            this === self ? target : this,
            tabId,
            ...rest,
          );
        };
      },
    },
  );
  if (!bySession) {
    bySession = new Map();
    sessionRunners.set(cdp, bySession);
  }
  bySession.set(sessionId, wrapper);
  sessionRunners.set(wrapper, new Map([[sessionId, wrapper]]));
  return wrapper;
}

export interface BufferedReadBounds {
  since: number | undefined;
  limit: number;
  maxTextChars: number;
}

/** Parse the common cursor and output bounds used by buffered read tools. */
export function parseBufferedReadBounds(params: {
  since?: number;
  limit?: number;
  max_text_chars?: number;
}): BufferedReadBounds | RpcError {
  const since = params.since;
  if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) {
    return { code: "invalid_params", message: "since must be a non-negative integer" };
  }
  const limit = boundedOptionalInteger(
    params.limit,
    DEFAULT_BUFFERED_READ_LIMIT,
    MAX_BUFFERED_READ_LIMIT,
    "limit",
  );
  if (isRpcError(limit)) return limit;
  const maxTextChars = boundedOptionalInteger(
    params.max_text_chars,
    DEFAULT_MAX_TEXT_CHARS,
    MAX_TEXT_CHARS,
    "max_text_chars",
  );
  if (isRpcError(maxTextChars)) return maxTextChars;
  return { since, limit, maxTextChars };
}

function boundedOptionalInteger(
  value: number | undefined,
  defaultValue: number,
  maxValue: number,
  field: string,
): number | RpcError {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { code: "invalid_params", message: `${field} must be a positive integer` };
  }
  return Math.min(value, maxValue);
}

/**
 * Look up an active session by its `session_id` param, returning the
 * matching `SessionContext` or a structured `RpcError`. Tool handlers
 * call this first so every code path emits identical error messages.
 */
export function lookupSession(
  manager: SessionManager,
  params: { session_id?: string },
  toolName: string,
): SessionContext | RpcError {
  if (!params?.session_id || typeof params.session_id !== "string") {
    return {
      code: "invalid_params",
      message: `${toolName} requires session_id`,
    };
  }
  const ctx = manager.get(params.session_id);
  if (!ctx) {
    return {
      code: "not_found",
      message: `session ${params.session_id} unknown`,
    };
  }
  return ctx;
}

/**
 * Resolve the target tab for a tool call. Explicit `tabId` values are
 * checked against the session visibility rules: user tabs and the
 * current session's Agent Window are visible, other sessions' Agent
 * Windows are not.
 *
 * Returns the resolved `{tabId, windowId, active}` triple, or an
 * `RpcError` the caller propagates verbatim.
 */
export async function resolveTargetTab(
  manager: SessionManager,
  ctx: SessionContext,
  tabId: number | undefined,
  api: ChromeTabsApi,
): Promise<ResolvedTargetTab | RpcError> {
  const target = await resolveVisibleTargetTab(manager, ctx, tabId, api);
  if (!isRpcError(target) && ctx.remote && !isAgentControlledTab(ctx, target.tabId)) {
    return {
      code: "permission_denied",
      message: "Authorize this tab with tab_borrow before reading or operating it",
    };
  }
  return target;
}

function isExcludedImplicitTarget(ctx: SessionContext, tabId: number): boolean {
  return (
    ((ctx.pendingRoutingTabs?.has(tabId) ?? false) && !isAgentControlledTab(ctx, tabId)) ||
    (ctx.temporaryInputTabs?.has(tabId) ?? false)
  );
}

async function resolveVisibleTargetTab(
  manager: SessionManager,
  ctx: SessionContext,
  tabId: number | undefined,
  api: ChromeTabsApi,
): Promise<ResolvedTargetTab | RpcError> {
  if (tabId !== undefined) {
    if (!Number.isSafeInteger(tabId) || tabId <= 0) {
      return {
        code: "invalid_params",
        message: "tab_id must be a positive integer",
      };
    }
    let tab: chrome.tabs.Tab;
    try {
      tab = await api.get(tabId);
    } catch (err) {
      return {
        code: "not_found",
        message: err instanceof Error ? err.message : `tab ${tabId} not found`,
      };
    }
    if (typeof tab.id !== "number" || typeof tab.windowId !== "number") {
      return {
        code: "not_found",
        message: `tab ${tabId} not found`,
      };
    }
    const owner = manager.findByWindowId(tab.windowId);
    if (owner && owner.sessionId !== ctx.sessionId) {
      return {
        code: "not_found",
        message: `tab ${tabId} not found in session scope`,
      };
    }
    return {
      tabId: tab.id,
      windowId: tab.windowId,
      active: tab.active === true,
      url: tab.url,
      pendingUrl: tab.pendingUrl,
    };
  }
  const tabs = await api.query({ active: true, windowId: ctx.agentWindowId });
  let first = tabs.find((t) => typeof t.id === "number");
  if (first?.id !== undefined && isExcludedImplicitTarget(ctx, first.id)) {
    // External arrivals and temporary input-deselection tabs must not become default targets.
    // Prefer the most recently accessed controlled page without activating tabs.
    const available = await api.query({ windowId: ctx.agentWindowId });
    first = available
      .filter(
        (tab) =>
          tab.id !== undefined &&
          tab.windowId === ctx.agentWindowId &&
          isAgentControlledTab(ctx, tab.id) &&
          !(ctx.temporaryInputTabs?.has(tab.id) ?? false),
      )
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
    if (!first) {
      return {
        code: "not_found",
        message: `no controlled tab available in Agent Window ${ctx.agentWindowId}; create or borrow a task tab`,
      };
    }
  }
  if (!first || typeof first.id !== "number") {
    return {
      code: "not_found",
      message: `no active tab in Agent Window ${ctx.agentWindowId}`,
    };
  }
  return {
    tabId: first.id,
    windowId: ctx.agentWindowId,
    active: first.active === true,
    url: first.url,
    pendingUrl: first.pendingUrl,
  };
}

export function isRpcError(v: unknown): v is RpcError {
  return (
    typeof v === "object" &&
    v !== null &&
    "code" in v &&
    "message" in v &&
    typeof (v as RpcError).code === "string"
  );
}

/** Re-export so M6/M7 tools keep a stable import path. */
export { normaliseRef };

export type ToolEffect = "passive_read" | "transient_input" | "browser_mutation";

const CDP_BLOCKED_PROTOCOLS = new Set([
  "chrome:",
  "chrome-extension:",
  "devtools:",
  "edge:",
  "brave:",
  "vivaldi:",
  "opera:",
]);

export function cdpBlockedUrlReason(url: string | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (CDP_BLOCKED_PROTOCOLS.has(parsed.protocol)) return parsed.protocol;
  if (parsed.protocol === "about:" && parsed.pathname !== "blank") return "about:";
  return null;
}

/**
 * Page CDP tools cannot inspect browser/extension internal pages. Check this
 * at the tool boundary so Chrome's low-level "Cannot access..." errors do not
 * leak as ambiguous page-read failures.
 */
export function enforceCdpAccessibleTarget(
  target: ResolvedTargetTab,
  toolName: string,
): RpcError | null {
  const reason = cdpBlockedUrlReason(target.url);
  if (!reason) return null;
  return rpcError(
    "permission_denied",
    "restricted_tab_url",
    `${toolName} cannot access tab ${target.tabId} because its URL is ${target.url}; navigate the Agent Window to a web page first`,
  );
}

function resolvedTargetFromChromeTab(
  tab: chrome.tabs.Tab,
  fallbackWindowId: number,
): ResolvedTargetTab | null {
  if (typeof tab.id !== "number") return null;
  return {
    tabId: tab.id,
    windowId: typeof tab.windowId === "number" ? tab.windowId : fallbackWindowId,
    active: tab.active === true,
    url: tab.url,
  };
}

/**
 * Resolve a target for page CDP reads. Explicit tab_ids stay exact and are
 * rejected when browser security blocks the URL. For default targeting, skip a
 * restricted Agent Window active tab if another CDP-accessible tab exists in
 * the same Agent Window.
 */
export async function resolveCdpAccessibleTargetTab(
  manager: SessionManager,
  ctx: SessionContext,
  tabId: number | undefined,
  api: ChromeTabsApi,
  toolName: string,
): Promise<ResolvedTargetTab | RpcError> {
  const target = await resolveTargetTab(manager, ctx, tabId, api);
  if (isRpcError(target)) return target;

  const restricted = enforceCdpAccessibleTarget(target, toolName);
  if (!restricted) return target;
  if (tabId !== undefined) return restricted;

  const tabs = await api.query({ windowId: ctx.agentWindowId });
  for (const tab of tabs) {
    if (ctx.remote && (tab.id === undefined || !isAgentControlledTab(ctx, tab.id))) continue;
    if (tab.id !== undefined && isExcludedImplicitTarget(ctx, tab.id)) continue;
    const candidate = resolvedTargetFromChromeTab(tab, ctx.agentWindowId);
    if (!candidate) continue;
    if (!enforceCdpAccessibleTarget(candidate, toolName)) return candidate;
  }
  return restricted;
}

/**
 * Sandbox guard: M7 write tools (click / fill / press / navigate*)
 * MUST refuse to touch a tab outside the session's Agent Window
 * (§6 — borrowing brings the tab into the Agent Window first).
 *
 * Returns an `RpcError` when the resolved target sits in a user window;
 * `null` on success.
 */
export function enforceAgentWindow(
  ctx: SessionContext,
  target: { tabId: number; windowId: number },
  toolName: string,
): RpcError | null {
  if (ctx.remote && !isAgentControlledTab(ctx, target.tabId)) {
    return {
      code: "permission_denied",
      message: "This tab has not been authorized for the remote task",
    };
  }
  if (target.windowId !== ctx.agentWindowId) {
    return rpcError(
      "permission_denied",
      "agent_window_scope",
      `${toolName} can only act on tabs inside the Agent Window (tab ${target.tabId} is in window ${target.windowId}; borrow it first)`,
    );
  }
  return null;
}

/**
 * Unified target-scope policy by tool effect. Passive reads may inspect user
 * tabs; any tool that dispatches page input must stay inside the Agent Window.
 */
export function enforceToolTargetScope(
  ctx: SessionContext,
  target: { tabId: number; windowId: number },
  effect: ToolEffect,
  toolName: string,
): RpcError | null {
  if (effect === "passive_read" && !ctx.remote) return null;
  return enforceAgentWindow(ctx, target, toolName);
}

const reportedTimeoutMsByParams = new WeakMap<object, number>();

export function withReportedTimeoutMs<T extends object>(params: T, reportedTimeoutMs: number): T {
  reportedTimeoutMsByParams.set(params, reportedTimeoutMs);
  return params;
}

export function readReportedTimeoutMs(params: unknown): number | undefined {
  return params !== null && typeof params === "object"
    ? reportedTimeoutMsByParams.get(params)
    : undefined;
}
