import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetPendingBorrowDecisionsForTest,
  __resetPendingBorrowNotificationsForTest,
  attachBorrowNotificationButtonHandler,
  attachBorrowNotificationClickHandler,
  BACKGROUND_TIMEOUT_MS,
  BORROW_NOTIFICATION_PREFIX,
  type ChromeNotificationsForBorrow,
  type ChromeTabsForBorrow,
  type ChromeWindowsForBorrow,
  CONFIRMATION_TIMEOUT_MS,
  isInjectableContentScriptUrl,
  PROGRESS_TRANSITION_MS,
  requestBorrowConfirmation,
} from "../borrow-confirmation";

function makeTabsMock(): ChromeTabsForBorrow & {
  get: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(),
    sendMessage: vi.fn(),
  } as never;
}

function makeWindowsMock(): ChromeWindowsForBorrow & {
  getLastFocused: ReturnType<typeof vi.fn>;
  getAll: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
} {
  return {
    getLastFocused: vi.fn(),
    getAll: vi.fn(async () => []),
    update: vi.fn(async () => undefined as unknown as chrome.windows.Window),
  } as never;
}

function makeNotificationsMock(): ChromeNotificationsForBorrow & {
  create: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
} {
  return {
    create: vi.fn(async (id: string) => id),
    clear: vi.fn(async () => true),
  } as never;
}

/** Helper that builds a `chrome.windows.Window`-shaped object with one active tab. */
function userWindowWithActiveTab(opts: {
  windowId: number;
  tabId: number;
  url?: string;
  title?: string;
}): chrome.windows.Window {
  return {
    id: opts.windowId,
    focused: true,
    incognito: false,
    alwaysOnTop: false,
    type: "normal",
    state: "normal",
    tabs: [
      {
        id: opts.tabId,
        index: 0,
        windowId: opts.windowId,
        active: true,
        highlighted: true,
        pinned: false,
        url: opts.url ?? "https://example.com/",
        title: opts.title ?? "Example",
      } as unknown as chrome.tabs.Tab,
    ],
  } as unknown as chrome.windows.Window;
}

describe("requestBorrowConfirmation", () => {
  let tabs: ReturnType<typeof makeTabsMock>;
  let windows: ReturnType<typeof makeWindowsMock>;
  let notifications: ReturnType<typeof makeNotificationsMock>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    __resetPendingBorrowNotificationsForTest();
    __resetPendingBorrowDecisionsForTest();
    tabs = makeTabsMock();
    windows = makeWindowsMock();
    notifications = makeNotificationsMock();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends confirmation to the visible active tab when borrow target is inactive", async () => {
    tabs.get.mockResolvedValueOnce({
      id: 42,
      windowId: 300,
      title: "Hidden Window Tab",
      active: true,
    });
    windows.getLastFocused.mockResolvedValueOnce(
      userWindowWithActiveTab({ windowId: 999, tabId: 7, url: "https://news.example/" }),
    );
    tabs.sendMessage.mockResolvedValueOnce({ type: "borrow-response", allowed: true });

    const pending = requestBorrowConfirmation(42, {
      deps: { tabs, windows, notifications },
    });
    await vi.runAllTimersAsync();
    const allowed = await pending;

    expect(allowed).toBe(true);
    expect(tabs.sendMessage).toHaveBeenCalledTimes(1);
    const [messageTabId, message] = tabs.sendMessage.mock.calls[0] as [
      number,
      { tabId: number; isActiveTab: boolean; requestId: string; timeoutMs: number },
    ];
    expect(messageTabId).toBe(7);
    expect(message.tabId).toBe(42);
    expect(message.isActiveTab).toBe(false);
    expect(message.timeoutMs).toBe(CONFIRMATION_TIMEOUT_MS);
    expect(typeof message.requestId).toBe("string");
    expect(message.requestId.length).toBeGreaterThan(0);
  });

  it("sends confirmation to the borrow target when it is the active tab", async () => {
    tabs.get.mockResolvedValueOnce({ id: 42, title: "Active Tab" });
    windows.getLastFocused.mockResolvedValueOnce(
      userWindowWithActiveTab({ windowId: 11, tabId: 42, url: "https://app.example/" }),
    );
    tabs.sendMessage.mockResolvedValueOnce({ type: "borrow-response", allowed: true });

    const pending = requestBorrowConfirmation(42, {
      deps: { tabs, windows, notifications },
    });
    await vi.runAllTimersAsync();

    expect(await pending).toBe(true);
    const [messageTabId, message] = tabs.sendMessage.mock.calls[0] as [
      number,
      { isActiveTab: boolean },
    ];
    expect(messageTabId).toBe(42);
    expect(message.isActiveTab).toBe(true);
  });

  it("returns false when the user explicitly denies", async () => {
    tabs.get.mockResolvedValueOnce({ id: 42, title: "Tab" });
    windows.getLastFocused.mockResolvedValueOnce(
      userWindowWithActiveTab({ windowId: 11, tabId: 42, url: "https://app.example/" }),
    );
    tabs.sendMessage.mockResolvedValueOnce({ type: "borrow-response", allowed: false });

    const pending = requestBorrowConfirmation(42, {
      deps: { tabs, windows, notifications },
    });
    await vi.runAllTimersAsync();
    expect(await pending).toBe(false);
  });

  it("skips the Agent Window when it is lastFocusedWindow and falls back to a real user window", async () => {
    tabs.get.mockResolvedValueOnce({
      id: 42,
      windowId: 300,
      title: "User Tab Being Borrowed",
    });
    // Agent Window (id=500) was last focused — it must be ignored.
    windows.getLastFocused.mockResolvedValueOnce(
      userWindowWithActiveTab({ windowId: 500, tabId: 5001, url: "about:blank" }),
    );
    // getAll returns both the Agent Window and a real user window.
    windows.getAll.mockResolvedValueOnce([
      userWindowWithActiveTab({ windowId: 500, tabId: 5001, url: "about:blank" }),
      userWindowWithActiveTab({ windowId: 600, tabId: 6001, url: "https://news.example/" }),
    ]);
    tabs.sendMessage.mockResolvedValueOnce({ type: "borrow-response", allowed: true });

    const pending = requestBorrowConfirmation(42, {
      deps: {
        tabs,
        windows,
        notifications,
        isAgentWindowId: (id) => id === 500,
      },
    });
    await vi.runAllTimersAsync();

    expect(await pending).toBe(true);
    expect(tabs.sendMessage).toHaveBeenCalledTimes(1);
    const [messageTabId] = tabs.sendMessage.mock.calls[0] as [number];
    // Must NOT pick 5001 (Agent Window's about:blank tab).
    expect(messageTabId).toBe(6001);
  });

  it("skips windows whose active tab is on a non-injectable URL (chrome://, web store, file:)", async () => {
    tabs.get.mockResolvedValueOnce({ id: 42, title: "Some Tab" });
    windows.getLastFocused.mockResolvedValueOnce(
      userWindowWithActiveTab({ windowId: 11, tabId: 111, url: "chrome://settings/" }),
    );
    windows.getAll.mockResolvedValueOnce([
      userWindowWithActiveTab({ windowId: 11, tabId: 111, url: "chrome://settings/" }),
      userWindowWithActiveTab({
        windowId: 12,
        tabId: 222,
        url: "https://chromewebstore.google.com/category/extensions",
      }),
      userWindowWithActiveTab({ windowId: 14, tabId: 444, url: "file:///Users/me/page.html" }),
      userWindowWithActiveTab({ windowId: 13, tabId: 333, url: "https://docs.example/" }),
    ]);
    tabs.sendMessage.mockResolvedValueOnce({ type: "borrow-response", allowed: true });

    const pending = requestBorrowConfirmation(42, {
      deps: { tabs, windows, notifications },
    });
    await vi.runAllTimersAsync();

    expect(await pending).toBe(true);
    expect(tabs.sendMessage).toHaveBeenCalledTimes(1);
    const [messageTabId] = tabs.sendMessage.mock.calls[0] as [number];
    expect(messageTabId).toBe(333);
  });

  it("falls through to the next candidate when sendMessage rejects for the first one", async () => {
    tabs.get.mockResolvedValueOnce({ id: 42, title: "Tab" });
    windows.getLastFocused.mockResolvedValueOnce(
      userWindowWithActiveTab({ windowId: 30, tabId: 300, url: "https://flaky.example/" }),
    );
    windows.getAll.mockResolvedValueOnce([
      userWindowWithActiveTab({ windowId: 30, tabId: 300, url: "https://flaky.example/" }),
      userWindowWithActiveTab({ windowId: 31, tabId: 301, url: "https://ok.example/" }),
    ]);
    tabs.sendMessage
      .mockRejectedValueOnce(new Error("Could not establish connection"))
      .mockResolvedValueOnce({ type: "borrow-response", allowed: false });

    const pending = requestBorrowConfirmation(42, {
      deps: { tabs, windows, notifications },
    });
    await vi.runAllTimersAsync();

    // Allowed=false from the second candidate must propagate as a real deny:
    // sendMessage failure on candidate #1 is NOT a silent allow.
    expect(await pending).toBe(false);
    expect(tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(tabs.sendMessage.mock.calls[0]?.[0]).toBe(300);
    expect(tabs.sendMessage.mock.calls[1]?.[0]).toBe(301);
  });

  it("does NOT fail-open immediately when every candidate's sendMessage fails — waits for notification button or timeout", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    tabs.get.mockResolvedValueOnce({ id: 42, title: "Tab" });
    windows.getLastFocused.mockResolvedValueOnce(
      userWindowWithActiveTab({ windowId: 40, tabId: 400, url: "https://a.example/" }),
    );
    windows.getAll.mockResolvedValueOnce([
      userWindowWithActiveTab({ windowId: 40, tabId: 400, url: "https://a.example/" }),
      userWindowWithActiveTab({ windowId: 41, tabId: 401, url: "https://b.example/" }),
    ]);
    tabs.sendMessage
      .mockRejectedValueOnce(new Error("Could not establish connection #1"))
      .mockRejectedValueOnce(new Error("Could not establish connection #2"));

    let resolved = false;
    let resolvedValue: boolean | undefined;
    const pending = requestBorrowConfirmation(42, {
      deps: { tabs, windows, notifications },
    }).then((v) => {
      resolved = true;
      resolvedValue = v;
      return v;
    });

    // Drain microtasks for sendMessage rejections + notification create.
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(tabs.sendMessage).toHaveBeenCalledTimes(2);
    // CRITICAL: previously this would already be settled(true). Now we
    // require an explicit user choice (notification button) or timeout.
    expect(resolved).toBe(false);

    // Allow the BACKGROUND_TIMEOUT_MS fail-open to fire so the test resolves.
    await vi.advanceTimersByTimeAsync(BACKGROUND_TIMEOUT_MS);
    expect(await pending).toBe(true);
    expect(resolvedValue).toBe(true);

    const exhaustedWarn = warnSpy.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("every candidate user window failed sendMessage"),
    );
    expect(exhaustedWarn).toBeDefined();
    warnSpy.mockRestore();
  });

  it("resolves true when the user clicks the notification Allow button after all candidates fail", async () => {
    const buttonListeners: Array<(notificationId: string, buttonIndex: number) => void> = [];
    const onButtonClicked = {
      addListener: (cb: (notificationId: string, buttonIndex: number) => void) =>
        buttonListeners.push(cb),
      removeListener: (cb: (notificationId: string, buttonIndex: number) => void) => {
        const i = buttonListeners.indexOf(cb);
        if (i >= 0) buttonListeners.splice(i, 1);
      },
      hasListener: () => false,
      hasListeners: () => buttonListeners.length > 0,
    } as unknown as chrome.events.Event<(notificationId: string, buttonIndex: number) => void>;
    attachBorrowNotificationButtonHandler({ onButtonClicked });

    tabs.get.mockResolvedValueOnce({ id: 42, title: "Tab" });
    windows.getLastFocused.mockResolvedValueOnce(
      userWindowWithActiveTab({ windowId: 50, tabId: 500, url: "https://stale.example/" }),
    );
    tabs.sendMessage.mockRejectedValueOnce(new Error("Could not establish connection"));

    const pending = requestBorrowConfirmation(42, {
      deps: { tabs, windows, notifications },
    });

    await vi.waitFor(() => expect(notifications.create).toHaveBeenCalledTimes(1));
    const [notificationId] = notifications.create.mock.calls[0] as [string];

    // User clicks the Allow button (index 0).
    for (const l of buttonListeners) l(notificationId, 0);
    await vi.runAllTimersAsync();

    expect(await pending).toBe(true);
  });

  it("resolves false when the user clicks the notification Deny button — no fail-open", async () => {
    const buttonListeners: Array<(notificationId: string, buttonIndex: number) => void> = [];
    const onButtonClicked = {
      addListener: (cb: (notificationId: string, buttonIndex: number) => void) =>
        buttonListeners.push(cb),
      removeListener: (cb: (notificationId: string, buttonIndex: number) => void) => {
        const i = buttonListeners.indexOf(cb);
        if (i >= 0) buttonListeners.splice(i, 1);
      },
      hasListener: () => false,
      hasListeners: () => buttonListeners.length > 0,
    } as unknown as chrome.events.Event<(notificationId: string, buttonIndex: number) => void>;
    attachBorrowNotificationButtonHandler({ onButtonClicked });

    tabs.get.mockResolvedValueOnce({ id: 42, title: "Tab" });
    windows.getLastFocused.mockResolvedValueOnce(
      userWindowWithActiveTab({ windowId: 60, tabId: 600, url: "https://a.example/" }),
    );
    windows.getAll.mockResolvedValueOnce([
      userWindowWithActiveTab({ windowId: 60, tabId: 600, url: "https://a.example/" }),
      userWindowWithActiveTab({ windowId: 61, tabId: 601, url: "https://b.example/" }),
    ]);
    tabs.sendMessage
      .mockRejectedValueOnce(new Error("Could not establish connection #1"))
      .mockRejectedValueOnce(new Error("Could not establish connection #2"));

    const pending = requestBorrowConfirmation(42, {
      deps: { tabs, windows, notifications },
    });

    await vi.waitFor(() => expect(notifications.create).toHaveBeenCalledTimes(1));
    const [notificationId] = notifications.create.mock.calls[0] as [string];

    // User clicks the Deny button (index 1).
    for (const l of buttonListeners) l(notificationId, 1);
    await vi.runAllTimersAsync();

    // CRITICAL: the user said "Deny" via the notification button. This
    // must NOT be silently flipped to allow.
    expect(await pending).toBe(false);
  });

  it("fail-opens when no injectable user window exists at all", async () => {
    tabs.get.mockResolvedValueOnce({ id: 42, title: "Stranded Tab" });
    windows.getLastFocused.mockResolvedValueOnce(
      userWindowWithActiveTab({ windowId: 500, tabId: 5001, url: "about:blank" }),
    );
    windows.getAll.mockResolvedValueOnce([
      userWindowWithActiveTab({ windowId: 500, tabId: 5001, url: "about:blank" }),
    ]);

    const pending = requestBorrowConfirmation(42, {
      deps: {
        tabs,
        windows,
        notifications,
        isAgentWindowId: (id) => id === 500,
      },
    });
    await vi.runAllTimersAsync();

    expect(await pending).toBe(true);
    expect(tabs.sendMessage).not.toHaveBeenCalled();
    // No notification either — there's no actionable target window.
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it("pushes a chrome notification carrying the request id and clears it on settle", async () => {
    tabs.get.mockResolvedValueOnce({ id: 42, title: "Demo" });
    windows.getLastFocused.mockResolvedValueOnce(
      userWindowWithActiveTab({ windowId: 11, tabId: 42, url: "https://app.example/" }),
    );
    tabs.sendMessage.mockResolvedValueOnce({ type: "borrow-response", allowed: true });

    const pending = requestBorrowConfirmation(42, {
      deps: { tabs, windows, notifications },
    });
    await vi.runAllTimersAsync();
    await pending;

    expect(notifications.create).toHaveBeenCalledTimes(1);
    const [notificationId, options] = notifications.create.mock.calls[0] as [
      string,
      chrome.notifications.NotificationOptions<true>,
    ];
    expect(notificationId.startsWith(BORROW_NOTIFICATION_PREFIX)).toBe(true);
    expect(options.type).toBe("basic");
    expect(options.title).toMatch(/borrow/i);
    expect(notifications.clear).toHaveBeenCalledWith(notificationId);
  });

  it("notification click handler focuses the target user window", async () => {
    const listeners: Array<(id: string) => void> = [];
    const onClicked = {
      addListener: (cb: (id: string) => void) => listeners.push(cb),
      removeListener: (cb: (id: string) => void) => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      },
      hasListener: () => false,
      hasListeners: () => listeners.length > 0,
    } as unknown as chrome.events.Event<(notificationId: string) => void>;

    attachBorrowNotificationClickHandler({
      onClicked,
      windows,
      notifications,
    });

    tabs.get.mockResolvedValueOnce({ id: 42, title: "Borrow Target" });
    windows.getLastFocused.mockResolvedValueOnce(
      userWindowWithActiveTab({ windowId: 77, tabId: 4242, url: "https://docs.example/" }),
    );
    // Keep sendMessage pending so the request stays live while we click.
    let resolveSend: (v: { type: string; allowed: boolean }) => void = () => undefined;
    tabs.sendMessage.mockImplementationOnce(
      () => new Promise((res) => (resolveSend = res as never)),
    );

    const pending = requestBorrowConfirmation(42, {
      deps: { tabs, windows, notifications },
    });
    await vi.waitFor(() => expect(notifications.create).toHaveBeenCalledTimes(1));
    const [notificationId] = notifications.create.mock.calls[0] as [string];

    // Simulate user clicking the OS notification.
    for (const l of listeners) l(notificationId);
    await vi.runAllTimersAsync();
    expect(windows.update).toHaveBeenCalledWith(77, { focused: true });

    // Finish the borrow so the test resolves cleanly.
    resolveSend({ type: "borrow-response", allowed: true });
    await vi.runAllTimersAsync();
    await pending;
  });

  it("fail-opens after background timeout when content script never responds", async () => {
    tabs.get.mockResolvedValueOnce({ id: 42, title: "Tab" });
    windows.getLastFocused.mockResolvedValueOnce(
      userWindowWithActiveTab({ windowId: 11, tabId: 42, url: "https://app.example/" }),
    );
    tabs.sendMessage.mockImplementationOnce(() => new Promise(() => undefined));

    const pending = requestBorrowConfirmation(42, {
      deps: { tabs, windows, notifications },
    });
    await vi.advanceTimersByTimeAsync(BACKGROUND_TIMEOUT_MS);
    expect(await pending).toBe(true);
  });

  it("dismisses pending overlay and fail-opens when aborted", async () => {
    tabs.get.mockResolvedValueOnce({ id: 42, title: "Borrow Target" });
    windows.getLastFocused.mockResolvedValueOnce(
      userWindowWithActiveTab({ windowId: 11, tabId: 7, url: "https://app.example/" }),
    );
    tabs.sendMessage.mockImplementationOnce(() => new Promise(() => undefined));
    tabs.sendMessage.mockResolvedValueOnce(undefined);

    const controller = new AbortController();
    const pending = requestBorrowConfirmation(42, {
      signal: controller.signal,
      deps: { tabs, windows, notifications },
    });
    await vi.waitFor(() => expect(tabs.sendMessage).toHaveBeenCalledTimes(1));
    controller.abort();
    await vi.runAllTimersAsync();

    expect(await pending).toBe(true);
    expect(tabs.sendMessage).toHaveBeenCalledTimes(2);
    const requestMessage = tabs.sendMessage.mock.calls[0][1] as { requestId: string };
    const cancelMessage = tabs.sendMessage.mock.calls[1][1] as {
      type: string;
      requestId: string;
    };
    expect(cancelMessage.type).toBe("borrow-cancel");
    expect(cancelMessage.requestId).toBe(requestMessage.requestId);
  });

  it("does not fail-open when tabs.get rejects — still surfaces confirmation to a candidate", async () => {
    // Regression: a transient tabs.get failure (SW teardown / page hiccup)
    // used to return true immediately, approving the borrow with no
    // confirmation UI. The tab was already fetched by the borrow pipeline
    // moments earlier, so the failure is transient — we must fall back to a
    // generic title and still ask the user.
    tabs.get.mockRejectedValueOnce(new Error("tab info unavailable"));
    windows.getLastFocused.mockResolvedValueOnce(
      userWindowWithActiveTab({ windowId: 50, tabId: 7, url: "https://app.example/" }),
    );
    tabs.sendMessage.mockResolvedValueOnce({ type: "borrow-response", allowed: false });

    const pending = requestBorrowConfirmation(42, {
      deps: { tabs, windows, notifications },
    });
    await vi.runAllTimersAsync();
    const allowed = await pending;

    // The user's explicit deny must be honoured — NOT auto-allowed by the
    // earlier tabs.get rejection.
    expect(allowed).toBe(false);
    expect(tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(notifications.create).toHaveBeenCalledTimes(1);
  });

  it("still allows an explicit overlay allow after a tabs.get rejection", async () => {
    tabs.get.mockRejectedValueOnce(new Error("tab info unavailable"));
    windows.getLastFocused.mockResolvedValueOnce(
      userWindowWithActiveTab({ windowId: 50, tabId: 7, url: "https://app.example/" }),
    );
    tabs.sendMessage.mockResolvedValueOnce({ type: "borrow-response", allowed: true });

    const pending = requestBorrowConfirmation(42, {
      deps: { tabs, windows, notifications },
    });
    await vi.runAllTimersAsync();
    const allowed = await pending;

    expect(allowed).toBe(true);
    expect(tabs.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("isInjectableContentScriptUrl", () => {
  it("accepts http and https only", () => {
    expect(isInjectableContentScriptUrl("https://example.com/")).toBe(true);
    expect(isInjectableContentScriptUrl("http://localhost:5173/")).toBe(true);
  });

  it("rejects file: and ftp: (require user-toggle / no longer reliably inject CS)", () => {
    expect(isInjectableContentScriptUrl("file:///Users/me/page.html")).toBe(false);
    expect(isInjectableContentScriptUrl("ftp://archive.example/file")).toBe(false);
  });

  it("rejects restricted schemes", () => {
    expect(isInjectableContentScriptUrl(undefined)).toBe(false);
    expect(isInjectableContentScriptUrl("")).toBe(false);
    expect(isInjectableContentScriptUrl("about:blank")).toBe(false);
    expect(isInjectableContentScriptUrl("chrome://settings/")).toBe(false);
    expect(isInjectableContentScriptUrl("chrome-extension://abc/popup.html")).toBe(false);
    expect(isInjectableContentScriptUrl("chrome-untrusted://terminal/")).toBe(false);
    expect(isInjectableContentScriptUrl("edge://flags/")).toBe(false);
    expect(isInjectableContentScriptUrl("devtools://devtools/bundled/inspector.html")).toBe(false);
    expect(isInjectableContentScriptUrl("view-source:https://example.com/")).toBe(false);
    expect(isInjectableContentScriptUrl("data:text/html,foo")).toBe(false);
    expect(isInjectableContentScriptUrl("blob:https://example.com/abc")).toBe(false);
  });

  it("rejects the Chrome Web Store (both domains)", () => {
    expect(
      isInjectableContentScriptUrl("https://chrome.google.com/webstore/category/extensions"),
    ).toBe(false);
    expect(isInjectableContentScriptUrl("https://chromewebstore.google.com/")).toBe(false);
  });
});
