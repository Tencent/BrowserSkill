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
//   record the payload for tool results, and auto-accept so automation
//   can continue.

import type { JavaScriptDialogInfo, JavaScriptDialogType } from "@/transport/types";

/**
 * Minimal slice of `chrome.debugger` the rest of the extension
 * depends on. Stays as an explicit interface so vitest can inject a
 * fake without monkey-patching the real `chrome` global.
 */
export interface CdpDebuggerApi {
  attach(target: chrome.debugger.Debuggee, requiredVersion: string): Promise<void>;
  detach(target: chrome.debugger.Debuggee): Promise<void>;
  sendCommand(
    target: chrome.debugger.Debuggee,
    method: string,
    commandParams?: object,
  ): Promise<unknown>;
  /**
   * Fires for every CDP event (`Page.lifecycleEvent`, `DOM.documentUpdated`,
   * …). The first callback argument is the source debuggee; the second
   * is the CDP method name; the third is the payload.
   */
  onEvent: chrome.events.Event<
    (source: chrome.debugger.Debuggee, method: string, params: unknown) => void
  >;
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

const MAX_DIALOG_BUFFER = 32;
const MAX_DIALOG_FIELD_LENGTH = 4096;

interface ParsedDialogOpening {
  type: JavaScriptDialogType;
  message: string;
  url?: string;
  defaultPrompt?: string;
  hasBrowserHandler?: boolean;
}

/**
 * Wrapper around `chrome.debugger` that owns the "attach once per
 * tabId" cache and exposes typed `send<T>()`.
 */
export class ChromiumCdp {
  private readonly api: CdpDebuggerApi;
  private readonly attachedTabs = new Set<number>();
  private readonly attachInFlight = new Map<number, Promise<void>>();
  private readonly tabOwners = new Map<number, Set<string>>();
  private readonly dialogBuffers = new Map<number, JavaScriptDialogInfo[]>();
  private readonly dialogSequences = new Map<number, number>();
  private detachSubscription: { dispose(): void } | null = null;
  private dialogSubscription: { dispose(): void } | null = null;

  constructor(api: CdpDebuggerApi = chromeDebuggerApi) {
    this.api = api;
    this.bindAutoDetach();
    this.bindDialogHandler();
  }

  /** Attach to `tabId` if we haven't already in this driver. */
  async ensureAttached(tabId: number): Promise<void> {
    if (this.attachedTabs.has(tabId)) return;
    const existing = this.attachInFlight.get(tabId);
    if (existing) {
      await existing;
      return;
    }
    const attach = (async () => {
      await this.api.attach({ tabId }, CDP_PROTOCOL_VERSION);
      await this.enablePageDomain(tabId);
      this.attachedTabs.add(tabId);
    })()
      .catch((err) => {
        // Chrome surfaces "Another debugger is already attached" when
        // (rare) the user opened DevTools on the same tab. Don't swallow
        // — let the caller decide how to surface it.
        throw normalizeError(err);
      })
      .finally(() => {
        this.attachInFlight.delete(tabId);
      });
    this.attachInFlight.set(tabId, attach);
    await attach;
  }

  /**
   * Send a CDP command and decode the result as `T`. Throws on any
   * `chrome.runtime.lastError`.
   */
  async send<T = unknown>(tabId: number, method: string, params?: object): Promise<T> {
    if (!this.attachedTabs.has(tabId)) {
      await this.ensureAttached(tabId);
    }
    try {
      const result = await this.api.sendCommand({ tabId }, method, params ?? {});
      return result as T;
    } catch (err) {
      throw normalizeError(err);
    }
  }

  /** Return a cursor marking the current dialog sequence for `tabId`. */
  dialogCursor(tabId: number): DialogCursor {
    return this.dialogSequences.get(tabId) ?? 0;
  }

  /** Dialogs observed on `tabId` with sequence strictly greater than `cursor`. */
  dialogsSince(tabId: number, cursor: DialogCursor): JavaScriptDialogInfo[] {
    const buf = this.dialogBuffers.get(tabId) ?? [];
    return buf.filter((entry) => entry.sequence > cursor);
  }

  /** Detach if attached; never throws. */
  async detach(tabId: number): Promise<void> {
    this.attachInFlight.delete(tabId);
    if (!this.attachedTabs.has(tabId)) return;
    this.attachedTabs.delete(tabId);
    this.clearDialogState(tabId);
    try {
      await this.api.detach({ tabId });
    } catch (err) {
      // Tab may already be gone — Chrome auto-detaches on close. Log
      // at debug so production builds aren't noisy.
      console.debug("[bsk cdp] detach failed (likely tab already closed)", err);
    }
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

  /** Subscribe to all CDP events. Returned disposable removes the listener. */
  onEvent(handler: (source: chrome.debugger.Debuggee, method: string, params: unknown) => void): {
    dispose(): void;
  } {
    this.api.onEvent.addListener(handler);
    return {
      dispose: () => this.api.onEvent.removeListener(handler),
    };
  }

  /** Best-effort detach of every cached tab. Used on session.stop. */
  async detachAll(): Promise<void> {
    const tabs = Array.from(this.attachedTabs);
    this.attachInFlight.clear();
    this.tabOwners.clear();
    this.attachedTabs.clear();
    this.dialogBuffers.clear();
    this.dialogSequences.clear();
    await Promise.all(
      tabs.map(async (tabId) => {
        try {
          await this.api.detach({ tabId });
        } catch (err) {
          console.debug("[bsk cdp] detachAll: tab already gone", { tabId, err });
        }
      }),
    );
  }

  private async enablePageDomain(tabId: number): Promise<void> {
    await this.api.sendCommand({ tabId }, "Page.enable", {});
  }

  private bindDialogHandler(): void {
    if (this.dialogSubscription) return;
    const listener = (source: chrome.debugger.Debuggee, method: string, params: unknown) => {
      if (method !== "Page.javascriptDialogOpening") return;
      const tabId = source.tabId;
      if (typeof tabId !== "number") return;
      void this.onJavaScriptDialogOpening(tabId, params);
    };
    this.api.onEvent.addListener(listener);
    this.dialogSubscription = {
      dispose: () => this.api.onEvent.removeListener(listener),
    };
  }

  private async onJavaScriptDialogOpening(tabId: number, params: unknown): Promise<void> {
    const parsed = parseDialogOpeningParams(params);
    try {
      const handleParams: { accept: boolean; promptText?: string } = { accept: true };
      if (parsed.type === "prompt") {
        handleParams.promptText = parsed.defaultPrompt ?? "";
      }
      await this.api.sendCommand({ tabId }, "Page.handleJavaScriptDialog", handleParams);
      const sequence = (this.dialogSequences.get(tabId) ?? 0) + 1;
      this.dialogSequences.set(tabId, sequence);
      this.appendDialog(tabId, {
        tab_id: tabId,
        type: parsed.type,
        message: parsed.message,
        url: parsed.url,
        default_prompt: parsed.defaultPrompt,
        has_browser_handler: parsed.hasBrowserHandler,
        handled: "accepted",
        sequence,
      });
    } catch (err) {
      console.debug("[bsk cdp] Page.handleJavaScriptDialog failed", { tabId, err });
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
    this.dialogBuffers.delete(tabId);
    this.dialogSequences.delete(tabId);
  }

  private bindAutoDetach(): void {
    if (this.detachSubscription) return;
    const listener = (source: chrome.debugger.Debuggee, _reason: string) => {
      if (typeof source.tabId === "number") {
        this.attachedTabs.delete(source.tabId);
        this.attachInFlight.delete(source.tabId);
        this.tabOwners.delete(source.tabId);
        this.clearDialogState(source.tabId);
      }
    };
    this.api.onDetach.addListener(listener);
    this.detachSubscription = {
      dispose: () => this.api.onDetach.removeListener(listener),
    };
  }

  /** Remove internal Chrome event listeners; tests and SW teardown call this. */
  dispose(): void {
    this.detachSubscription?.dispose();
    this.detachSubscription = null;
    this.dialogSubscription?.dispose();
    this.dialogSubscription = null;
  }

  /** Detach tabs only when no other live session has claimed them. */
  async detachSession(sessionId: string): Promise<void> {
    const tabsToDetach: number[] = [];
    for (const [tabId, owners] of this.tabOwners) {
      owners.delete(sessionId);
      if (owners.size === 0) {
        this.tabOwners.delete(tabId);
        tabsToDetach.push(tabId);
      }
    }
    await Promise.all(tabsToDetach.map((tabId) => this.detach(tabId)));
  }
}

function parseDialogOpeningParams(params: unknown): ParsedDialogOpening {
  const raw = (params ?? {}) as Record<string, unknown>;
  const type = normalizeDialogType(raw.type);
  const message = truncateDialogField(typeof raw.message === "string" ? raw.message : "");
  const url = typeof raw.url === "string" ? truncateDialogField(raw.url) : undefined;
  const defaultPrompt =
    typeof raw.defaultPrompt === "string" ? truncateDialogField(raw.defaultPrompt) : undefined;
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

function normalizeError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === "string") return new Error(err);
  if (err && typeof err === "object" && "message" in err) {
    return new Error(String((err as { message: unknown }).message));
  }
  return new Error("unknown chrome.debugger error");
}
