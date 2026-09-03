import type { RpcError, WaitUntil } from "@/transport/types";
import { cdpError } from "./errors";

interface NavigationEvent {
  tabId: number;
  frameId: number;
  documentId?: string;
  error?: string;
}

interface NavigationEvents {
  addListener(listener: (details: NavigationEvent) => void): void;
  removeListener(listener: (details: NavigationEvent) => void): void;
}

/** Normal browser navigation remains available when chrome.debugger is denied. */
export interface BrowserNavigationApi {
  update(tabId: number, props: { url: string }): Promise<unknown>;
  reload(tabId: number, props: { bypassCache: boolean }): Promise<void>;
  onCommitted: NavigationEvents;
  onDOMContentLoaded: NavigationEvents;
  onCompleted: NavigationEvents;
  onErrorOccurred: NavigationEvents;
}

export const chromeBrowserNavigationApi: BrowserNavigationApi = {
  update: (tabId, props) => chrome.tabs.update(tabId, props),
  reload: (tabId, props) => chrome.tabs.reload(tabId, props),
  get onCommitted() {
    return chrome.webNavigation.onCommitted;
  },
  get onDOMContentLoaded() {
    return chrome.webNavigation.onDOMContentLoaded;
  },
  get onCompleted() {
    return chrome.webNavigation.onCompleted;
  },
  get onErrorOccurred() {
    return chrome.webNavigation.onErrorOccurred;
  },
};

export type NavigationOutcome =
  | { reached: "match" | "timeout" | "cancelled"; lastLifecycle?: string }
  | { reached: "failed"; error: RpcError };

/** Subscribe before dispatch and ignore the departing document's load events. */
export async function navigateWithBrowserApi(
  api: BrowserNavigationApi,
  tabId: number,
  action: () => Promise<unknown>,
  waitUntil: Exclude<WaitUntil, "networkidle">,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<NavigationOutcome> {
  if (signal?.aborted) return { reached: "cancelled" };
  if (timeoutMs <= 0) return { reached: "timeout" };
  let committed = false;
  let documentId: string | undefined;
  let lastLifecycle: string | undefined;
  let finish!: (outcome: NavigationOutcome) => void;
  const outcome = new Promise<NavigationOutcome>((resolve) => {
    finish = resolve;
  });
  const isMainFrame = (details: NavigationEvent) =>
    details.tabId === tabId && details.frameId === 0;
  const onCommitted = (details: NavigationEvent) => {
    if (!isMainFrame(details)) return;
    committed = true;
    documentId = details.documentId;
    lastLifecycle = "commit";
    if (waitUntil === "commit") finish({ reached: "match", lastLifecycle });
  };
  const onDOMContentLoaded = (details: NavigationEvent) => {
    if (!isMainFrame(details) || !committed || (documentId && details.documentId !== documentId))
      return;
    lastLifecycle = "DOMContentLoaded";
    if (waitUntil === "domcontentloaded") finish({ reached: "match", lastLifecycle });
  };
  const onCompleted = (details: NavigationEvent) => {
    if (!isMainFrame(details) || !committed || (documentId && details.documentId !== documentId))
      return;
    finish({ reached: "match", lastLifecycle: "load" });
  };
  const onError = (details: NavigationEvent) => {
    if (!isMainFrame(details)) return;
    finish({ reached: "failed", error: cdpError(details.error ?? "browser navigation failed") });
  };
  const onAbort = () => finish({ reached: "cancelled", lastLifecycle });
  const subscriptions = [
    [api.onCommitted, onCommitted],
    [api.onDOMContentLoaded, onDOMContentLoaded],
    [api.onCompleted, onCompleted],
    [api.onErrorOccurred, onError],
  ] as const;
  for (const [event, listener] of subscriptions) event.addListener(listener);
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => finish({ reached: "timeout", lastLifecycle }), timeoutMs);
  try {
    if (signal?.aborted) return { reached: "cancelled" };
    await action();
    return await outcome;
  } catch (error) {
    return { reached: "failed", error: cdpError(error) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    for (const [event, listener] of subscriptions) event.removeListener(listener);
  }
}
