// ---------------------------------------------------------------------------
// requestBorrowConfirmation — picks the user-visible tab that should host the
// in-page borrow confirmation overlay, asks the user for approval, and also
// surfaces an OS-level Chrome notification so the user can spot the request
// even when the Agent Window has stolen focus.
// ---------------------------------------------------------------------------

export interface BorrowRequestMessage {
  type: "borrow-request";
  requestId: string;
  tabId: number;
  tabTitle: string;
  isActiveTab: boolean;
  timeoutMs: number;
}

export interface BorrowCancelMessage {
  type: "borrow-cancel";
  requestId: string;
}

export interface BorrowResponseMessage {
  type: "borrow-response";
  allowed: boolean;
}

export const CONFIRMATION_TIMEOUT_MS = 5000;
const EXIT_ANIMATION_MS = 150;
/** Matches BorrowConfirmationOverlay progress ring/bar transition (duration-1000). */
export const PROGRESS_TRANSITION_MS = 1000;
// UI auto-allows after countdown + progress transition + exit fade. Background
// timeout must not fire before that chain completes or deny is ignored.
export const BACKGROUND_TIMEOUT_MS =
  CONFIRMATION_TIMEOUT_MS + PROGRESS_TRANSITION_MS + EXIT_ANIMATION_MS + 500;

/** Prefix for chrome.notifications ids the click handler dispatches on. */
export const BORROW_NOTIFICATION_PREFIX = "bh-borrow:";

// ---------------------------------------------------------------------------
// Injection seams (so tests don't need to monkey-patch global chrome.*)
// ---------------------------------------------------------------------------

export interface ChromeTabsForBorrow {
  get(tabId: number): Promise<chrome.tabs.Tab>;
  sendMessage(tabId: number, msg: unknown): Promise<unknown>;
}

export interface ChromeWindowsForBorrow {
  getLastFocused(filters: chrome.windows.QueryOptions): Promise<chrome.windows.Window>;
  getAll(filters: chrome.windows.QueryOptions): Promise<chrome.windows.Window[]>;
  update(windowId: number, props: chrome.windows.UpdateInfo): Promise<chrome.windows.Window>;
}

export interface ChromeNotificationsForBorrow {
  create(
    notificationId: string,
    options: chrome.notifications.NotificationOptions<true>,
  ): Promise<string>;
  clear(notificationId: string): Promise<boolean>;
}

export interface BorrowNotificationCopy {
  /** Notification title (e.g. "Agent wants to borrow a tab"). */
  title: string;
  /** Notification body — receives the target tab title. */
  body(tabTitle: string): string;
  /** Icon URL relative to the extension root. */
  iconUrl?: string;
  /**
   * Title for the OS notification's Allow button (button index 0). Clicking
   * it grants the borrow when the in-page overlay never reached the user
   * (e.g. every candidate window's content script was missing/uninjected).
   */
  allowButton: string;
  /**
   * Title for the OS notification's Deny button (button index 1). Clicking
   * it rejects the borrow as a real user-deny — never silently flipped to
   * allow.
   */
  denyButton: string;
}

export interface RequestBorrowConfirmationDeps {
  tabs?: ChromeTabsForBorrow;
  windows?: ChromeWindowsForBorrow;
  /** Pass `null` to opt out of OS-level notifications (tests). */
  notifications?: ChromeNotificationsForBorrow | null;
  /** Returns `true` when `windowId` belongs to *any* live session's Agent Window. */
  isAgentWindowId?: (windowId: number) => boolean;
  notificationCopy?: BorrowNotificationCopy;
}

export interface RequestBorrowConfirmationOptions {
  signal?: AbortSignal;
  deps?: RequestBorrowConfirmationDeps;
}

// ---------------------------------------------------------------------------
// Pending notification registry (used by the on-click handler)
// ---------------------------------------------------------------------------

interface PendingBorrowNotification {
  windowId: number;
  tabId: number;
}

const pendingBorrowNotifications = new Map<string, PendingBorrowNotification>();

/**
 * Registry of pending borrow promises keyed by `notificationId`. The
 * `chrome.notifications.onButtonClicked` listener uses it to resolve the
 * matching `requestBorrowConfirmation` call when the user clicks Allow
 * (index 0) or Deny (index 1) on the OS notification.
 *
 * This is the *fallback* authorization path that fires when no candidate
 * user window could host the in-page overlay (every `chrome.tabs.sendMessage`
 * was rejected because the content script was not present). Without it the
 * background-task fail-open at the end of `tryCandidate` would silently
 * allow the borrow without any user-visible authorization step.
 */
const pendingBorrowDecisions = new Map<string, (allowed: boolean) => void>();

/** Test helper — clears the in-memory pending notification registry. */
export function __resetPendingBorrowNotificationsForTest(): void {
  pendingBorrowNotifications.clear();
}

/** Test helper — clears the in-memory pending decision registry. */
export function __resetPendingBorrowDecisionsForTest(): void {
  pendingBorrowDecisions.clear();
}

/**
 * Subset of `ChromeNotificationsForBorrow` the click handler actually needs.
 * Keeping the dependency narrow makes it obvious that the listener never
 * creates notifications on its own.
 */
export interface BorrowNotificationCleaner {
  clear(notificationId: string): Promise<boolean>;
}

/**
 * Registers a global `chrome.notifications.onClicked` listener that focuses
 * the user window hosting the pending borrow overlay when the user clicks the
 * notification. Safe to call once at SW startup.
 */
export function attachBorrowNotificationClickHandler(deps: {
  onClicked: chrome.events.Event<(notificationId: string) => void>;
  windows: Pick<ChromeWindowsForBorrow, "update">;
  notifications: BorrowNotificationCleaner;
}): { dispose(): void } {
  const handler = (notificationId: string) => {
    const pending = pendingBorrowNotifications.get(notificationId);
    if (!pending) return;
    void deps.windows.update(pending.windowId, { focused: true }).catch((err) => {
      console.debug("[bsk borrow] focus on notification click failed", err);
    });
    void deps.notifications.clear(notificationId).catch((err) => {
      console.debug("[bsk borrow] clear notification failed", err);
    });
  };
  deps.onClicked.addListener(handler);
  return {
    dispose: () => deps.onClicked.removeListener(handler),
  };
}

/**
 * Registers a global `chrome.notifications.onButtonClicked` listener so the
 * Allow / Deny buttons on the OS notification can resolve the matching
 * pending `requestBorrowConfirmation`. This is the explicit-authorization
 * fallback path used when every candidate user window's content script was
 * missing — without it we'd be back to silently fail-opening the borrow.
 *
 * Button index convention (matches `BorrowNotificationCopy`):
 *   - 0 → Allow → `resolve(true)`
 *   - 1 → Deny  → `resolve(false)`
 *
 * Safe to call once at SW startup. Repeated invocations attach independent
 * listeners (each `dispose()` removes only its own).
 */
export function attachBorrowNotificationButtonHandler(deps: {
  onButtonClicked: chrome.events.Event<(notificationId: string, buttonIndex: number) => void>;
}): { dispose(): void } {
  const handler = (notificationId: string, buttonIndex: number) => {
    const settle = pendingBorrowDecisions.get(notificationId);
    if (!settle) return;
    const allowed = buttonIndex === 0;
    settle(allowed);
  };
  deps.onButtonClicked.addListener(handler);
  return {
    dispose: () => deps.onButtonClicked.removeListener(handler),
  };
}

// ---------------------------------------------------------------------------
// Default chrome.* bindings (exported so background.ts can reuse them)
// ---------------------------------------------------------------------------

export const defaultBorrowChromeTabs: ChromeTabsForBorrow = {
  get: (id) => chrome.tabs.get(id),
  sendMessage: (id, msg) => chrome.tabs.sendMessage(id, msg),
};

export const defaultBorrowChromeWindows: ChromeWindowsForBorrow = {
  getLastFocused: (f) => chrome.windows.getLastFocused(f),
  getAll: (f) => chrome.windows.getAll(f),
  update: (id, p) => chrome.windows.update(id, p),
};

export const defaultBorrowChromeNotifications: ChromeNotificationsForBorrow = {
  create: (id, opts) =>
    new Promise<string>((resolve, reject) => {
      try {
        chrome.notifications.create(id, opts, (resultId) => {
          const err = chrome.runtime?.lastError;
          if (err) {
            reject(new Error(err.message ?? String(err)));
            return;
          }
          resolve(resultId ?? id);
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }),
  clear: (id) =>
    new Promise<boolean>((resolve) => {
      try {
        chrome.notifications.clear(id, (cleared) => {
          resolve(cleared ?? false);
        });
      } catch (err) {
        console.debug("[bsk borrow] notifications.clear threw", err);
        resolve(false);
      }
    }),
};

const DEFAULT_NOTIFICATION_COPY: BorrowNotificationCopy = {
  title: "BrowserSkill: Agent wants to borrow a tab",
  body: (tabTitle) => `Approve or deny the borrow of "${tabTitle}".`,
  iconUrl: "icon/logo.png",
  allowButton: "Allow",
  denyButton: "Deny",
};

// ---------------------------------------------------------------------------
// URL injection-eligibility test
// ---------------------------------------------------------------------------

const CHROME_WEB_STORE_RES = [
  /^https:\/\/chrome\.google\.com\/webstore/i,
  /^https:\/\/chromewebstore\.google\.com/i,
];

/**
 * Returns true when the URL is one Chrome will reliably inject `<all_urls>`
 * content scripts into. Conservatively we accept *only* `http(s)://`:
 *
 *   - `file://` requires the per-extension "Allow access to file URLs"
 *     toggle the user almost never has on, and querying that toggle is async.
 *   - `ftp://` no longer hosts content scripts reliably in modern Chrome.
 *   - `about:` / `chrome:` / `chrome-extension:` / `edge:` / `devtools:` /
 *     `view-source:` / `data:` / `blob:` are blocked by the platform.
 *   - The Chrome Web Store (both legacy and new domains) is also blocked.
 *
 * Mirrors the implicit scheme list documented in
 * https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns.
 */
export function isInjectableContentScriptUrl(url: string | undefined): boolean {
  if (!url) return false;
  for (const re of CHROME_WEB_STORE_RES) {
    if (re.test(url)) return false;
  }
  return /^https?:\/\//i.test(url);
}

// ---------------------------------------------------------------------------
// Pick the user-visible tab(s) that may host the confirmation overlay
// ---------------------------------------------------------------------------

interface ConfirmationCandidate {
  tabId: number;
  windowId: number;
  tabUrl?: string;
}

async function listConfirmationCandidates(
  windows: ChromeWindowsForBorrow,
  isAgentWindowId: (windowId: number) => boolean,
): Promise<ConfirmationCandidate[]> {
  const seen = new Set<number>();
  const ordered: chrome.windows.Window[] = [];

  try {
    const last = await windows.getLastFocused({
      populate: true,
      windowTypes: ["normal"],
    });
    if (typeof last?.id === "number") {
      seen.add(last.id);
      ordered.push(last);
    }
  } catch (err) {
    console.debug("[bsk borrow] windows.getLastFocused failed", err);
  }

  try {
    const all = await windows.getAll({
      populate: true,
      windowTypes: ["normal"],
    });
    for (const w of all) {
      if (typeof w.id !== "number" || seen.has(w.id)) continue;
      seen.add(w.id);
      ordered.push(w);
    }
  } catch (err) {
    console.debug("[bsk borrow] windows.getAll failed", err);
  }

  const candidates: ConfirmationCandidate[] = [];
  for (const w of ordered) {
    if (typeof w.id !== "number") continue;
    // Never bounce the overlay back into a session's Agent Window — those
    // pages can't host a content script when they're on the about:blank
    // bootstrap URL, so sendMessage would fail-open and silently allow the
    // borrow with no UI shown.
    if (isAgentWindowId(w.id)) continue;
    const activeTab = w.tabs?.find((t) => t.active === true) ?? null;
    if (!activeTab || typeof activeTab.id !== "number") continue;
    const tabUrl = activeTab.url ?? activeTab.pendingUrl ?? undefined;
    if (!isInjectableContentScriptUrl(tabUrl)) continue;
    candidates.push({ tabId: activeTab.id, windowId: w.id, tabUrl });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Asks the user to confirm a tab borrow via an injected in-page UI plus an
 * OS-level Chrome notification.
 *
 * Selection of the overlay target tab:
 *   1. lastFocusedWindow (preferring the user's most recent normal window);
 *   2. any other normal window;
 * skipping any window that belongs to a session's Agent Window or whose
 * active tab cannot host a content script (chrome://, the Web Store, etc.).
 * Each candidate is tried in order — if `sendMessage` rejects (page raced
 * to a restricted URL between the query and the message; content script
 * still booting; extension just reloaded so the existing tab has no
 * listener; etc.) we move on to the next candidate.
 *
 * The OS notification carries Allow / Deny buttons that act as the
 * *explicit-authorization fallback* when every candidate fails sendMessage:
 * we no longer silently allow the borrow in that case, the promise stays
 * pending until the user clicks a notification button (resolves true/false)
 * or `BACKGROUND_TIMEOUT_MS` fires (last-resort fail-open so the agent
 * doesn't hang forever when even the notification path is broken).
 *
 * Clicking the notification body (vs. its buttons) focuses the chosen user
 * window so the overlay becomes visible — the previous behaviour.
 *
 * Returns `true` on user-allow (overlay or notification) OR last-resort
 * fail-open (no candidate window at all; abort signal; timeout). Returns
 * `false` only on explicit user-deny (overlay button or notification Deny
 * button).
 */
export async function requestBorrowConfirmation(
  tabId: number,
  options: RequestBorrowConfirmationOptions = {},
): Promise<boolean> {
  const { signal, deps = {} } = options;
  const tabsApi = deps.tabs ?? defaultBorrowChromeTabs;
  const windowsApi = deps.windows ?? defaultBorrowChromeWindows;
  const notificationsApi =
    deps.notifications === undefined ? defaultBorrowChromeNotifications : deps.notifications;
  const isAgentWindowId = deps.isAgentWindowId ?? (() => false);
  const copy = deps.notificationCopy ?? DEFAULT_NOTIFICATION_COPY;

  // The borrow pipeline already fetched this tab moments earlier
  // (validateBorrowTarget in tabs.ts), so a failure here is a transient
  // SW/page hiccup, not a missing tab. Do NOT fail-open: silently allowing
  // a borrow with no confirmation UI contradicts the gate's purpose and is
  // not one of the documented fail-open cases (no candidate window; abort;
  // timeout — see this function's doc comment). Fall back to a generic
  // title and still surface the overlay + notification so the user gets a
  // real chance to approve or deny.
  let tabTitle: string;
  try {
    const tab = await tabsApi.get(tabId);
    tabTitle = tab.title ?? tab.url ?? String(tabId);
  } catch (err) {
    console.warn("[bsk borrow] could not get tab info — using fallback title", {
      tabId,
      error: err instanceof Error ? err.message : String(err),
    });
    tabTitle = String(tabId);
  }

  const candidates = await listConfirmationCandidates(windowsApi, isAgentWindowId);
  if (candidates.length === 0) {
    console.warn("[bsk borrow] no injectable user window available — proceeding without overlay", {
      tabId,
    });
    return true;
  }

  const requestId = createBorrowRequestId(tabId);
  const notificationId = `${BORROW_NOTIFICATION_PREFIX}${requestId}`;
  // Prefer the first candidate as the notification anchor: it is the window
  // the user is most likely already looking at (lastFocusedWindow), so the
  // notification's "click → focus that window" affordance lands them on the
  // overlay immediately.
  const notificationAnchor = candidates[0];
  if (!notificationAnchor) {
    return true;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let activeMessageTabId: number | null = null;

    const cleanupNotification = () => {
      if (!notificationsApi) return;
      pendingBorrowNotifications.delete(notificationId);
      pendingBorrowDecisions.delete(notificationId);
      void notificationsApi.clear(notificationId).catch((err) => {
        console.debug("[bsk borrow] notification clear failed", {
          notificationId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };

    const settle = (allowed: boolean) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      cleanupNotification();
      resolve(allowed);
    };

    const onAbort = () => {
      if (activeMessageTabId !== null) {
        const cancelMessage: BorrowCancelMessage = {
          type: "borrow-cancel",
          requestId,
        };
        void tabsApi.sendMessage(activeMessageTabId, cancelMessage).catch((err) => {
          console.debug("[bsk borrow] cancel message failed", {
            tabId,
            messageTabId: activeMessageTabId,
            requestId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      settle(true);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    timeout = setTimeout(() => {
      console.info("[bsk borrow] confirmation timed out — proceeding", {
        tabId,
        messageTabId: activeMessageTabId,
      });
      settle(true);
    }, BACKGROUND_TIMEOUT_MS);

    // Surface the OS notification *before* messaging any candidate so the
    // user has a parallel signal even if every content script is missing.
    // The Allow / Deny buttons let the user authorize explicitly when the
    // in-page overlay never reached them — without those buttons we'd have
    // to fail-open after `tryCandidate` exhausts its candidates, which is
    // exactly the silent-allow bug we're fixing here.
    if (notificationsApi) {
      pendingBorrowNotifications.set(notificationId, {
        windowId: notificationAnchor.windowId,
        tabId: notificationAnchor.tabId,
      });
      pendingBorrowDecisions.set(notificationId, settle);
      notificationsApi
        .create(notificationId, {
          type: "basic",
          iconUrl: copy.iconUrl ?? "icon/logo.png",
          title: copy.title,
          message: copy.body(tabTitle),
          priority: 2,
          requireInteraction: false,
          silent: false,
          buttons: [{ title: copy.allowButton }, { title: copy.denyButton }],
        })
        .catch((err) => {
          console.debug("[bsk borrow] notifications.create failed — continuing overlay-only", {
            tabId,
            error: err instanceof Error ? err.message : String(err),
          });
          // Drop the registry entries on create failure: the click /
          // button handlers must not target a notification that never
          // appeared (Chrome would route a stale id to nowhere, but the
          // map would leak).
          pendingBorrowNotifications.delete(notificationId);
          pendingBorrowDecisions.delete(notificationId);
        });
    }

    const tryCandidate = (
      index: number,
      errorTrail: Array<{ candidate: ConfirmationCandidate; error: string }>,
    ): void => {
      if (settled) return;
      if (index >= candidates.length) {
        // Every candidate rejected sendMessage. We deliberately do NOT
        // fail-open here anymore: silently allowing a borrow with zero
        // user-visible authorization UI is the bug. Instead we keep the
        // promise pending and rely on:
        //   • the OS notification's Allow / Deny buttons for an explicit
        //     user choice (preferred), or
        //   • the BACKGROUND_TIMEOUT_MS fail-open as the last-resort
        //     soft-fail so the agent doesn't hang forever when even the
        //     notification API is unavailable.
        // Keep the diagnostics so real-world frequency is still observable.
        console.warn(
          "[bsk borrow] every candidate user window failed sendMessage — awaiting notification button or timeout",
          {
            tabId,
            attempts: errorTrail,
          },
        );
        return;
      }
      const candidate = candidates[index];
      if (!candidate) {
        return;
      }
      const isActiveTab = candidate.tabId === tabId;
      const message: BorrowRequestMessage = {
        type: "borrow-request",
        requestId,
        tabId,
        tabTitle,
        isActiveTab,
        timeoutMs: CONFIRMATION_TIMEOUT_MS,
      };
      activeMessageTabId = candidate.tabId;
      tabsApi
        .sendMessage(candidate.tabId, message)
        .then((response) => {
          if (settled) return;
          const allowed = (response as BorrowResponseMessage | undefined)?.allowed !== false;
          console.info("[bsk borrow] confirmation response", { tabId, allowed });
          settle(allowed);
        })
        .catch((err) => {
          if (settled) return;
          const reason = err instanceof Error ? err.message : String(err);
          console.warn("[bsk borrow] sendMessage to candidate user window failed — trying next", {
            tabId,
            messageTabId: candidate.tabId,
            messageWindowId: candidate.windowId,
            messageTabUrl: candidate.tabUrl,
            error: reason,
          });
          errorTrail.push({ candidate, error: reason });
          activeMessageTabId = null;
          tryCandidate(index + 1, errorTrail);
        });
    };

    tryCandidate(0, []);
  });
}

function createBorrowRequestId(tabId: number): string {
  const now = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${tabId}-${now}-${random}`;
}
