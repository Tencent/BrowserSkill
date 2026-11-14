import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_WINDOW_HOME, chromeAgentWindowApi } from "../agent-window";

describe("chromeAgentWindowApi.ensureActiveTab", () => {
  const query = vi.fn();
  const update = vi.fn();
  const create = vi.fn();
  const remove = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("chrome", {
      tabs: { query, update, create, remove },
    });
    query.mockReset();
    update.mockReset();
    create.mockReset();
    remove.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("activates an existing tab when the window already has one", async () => {
    query.mockResolvedValue([{ id: 7, active: false }]);
    update.mockResolvedValue({});

    await chromeAgentWindowApi.ensureActiveTab(100, AGENT_WINDOW_HOME, new Set([7]));

    expect(query).toHaveBeenCalledWith({ windowId: 100 });
    expect(update).toHaveBeenCalledWith(7, { active: true });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates about:blank when the Agent Window has no tabs", async () => {
    query.mockResolvedValue([]);
    create.mockResolvedValue({ id: 8 });
    update.mockResolvedValue({});

    await chromeAgentWindowApi.ensureActiveTab(100, AGENT_WINDOW_HOME, new Set());

    expect(create).toHaveBeenCalledWith({
      windowId: 100,
      url: AGENT_WINDOW_HOME,
      active: false,
    });
    expect(update).toHaveBeenCalledWith(8, { active: true });
  });

  it("creates its own home tab instead of adopting a tab opened by the user", async () => {
    query.mockResolvedValue([{ id: 99, active: true }]);
    create.mockResolvedValue({ id: 8 });
    update.mockResolvedValue({});
    const home = await chromeAgentWindowApi.ensureActiveTab(100, AGENT_WINDOW_HOME, new Set([7]));
    expect(home).toBe(8);
    expect(create).toHaveBeenCalledWith({ windowId: 100, url: AGENT_WINDOW_HOME, active: false });
    expect(update).toHaveBeenCalledWith(8, { active: true });
  });

  it("removes a newly created home tab if activating it fails", async () => {
    query.mockResolvedValue([]);
    create.mockResolvedValue({ id: 8 });
    update.mockRejectedValue(new Error("window closed"));
    remove.mockResolvedValue(undefined);
    await expect(
      chromeAgentWindowApi.ensureActiveTab(100, AGENT_WINDOW_HOME, new Set()),
    ).rejects.toThrow("window closed");
    expect(remove).toHaveBeenCalledWith(8);
  });
});

describe("chromeAgentWindowApi.create", () => {
  const create = vi.fn();
  const isAllowedIncognitoAccess = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("chrome", {
      windows: { create },
      extension: { isAllowedIncognitoAccess },
    });
    create.mockReset();
    create.mockResolvedValue({ id: 100 });
    isAllowedIncognitoAccess.mockReset().mockResolvedValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns initial tab identities from the creation result", async () => {
    create.mockResolvedValue({ id: 100, tabs: [{ id: 7 }, { id: 8 }] });
    expect(await chromeAgentWindowApi.create(AGENT_WINDOW_HOME)).toEqual({
      windowId: 100,
      initialTabIds: [7, 8],
    });
  });

  it("opens Agent Windows in the background by default", async () => {
    await chromeAgentWindowApi.create(AGENT_WINDOW_HOME);

    expect(create).toHaveBeenCalledWith({
      type: "normal",
      focused: false,
      incognito: false,
      url: AGENT_WINDOW_HOME,
    });
    expect(isAllowedIncognitoAccess).not.toHaveBeenCalled();
  });

  it("can explicitly bring an Agent Window to the foreground", async () => {
    await chromeAgentWindowApi.create(AGENT_WINDOW_HOME, { focused: true });

    expect(create).toHaveBeenCalledWith({
      type: "normal",
      focused: true,
      incognito: false,
      url: AGENT_WINDOW_HOME,
    });
  });

  it("passes an optional window size through the options object", async () => {
    await chromeAgentWindowApi.create(AGENT_WINDOW_HOME, {
      size: { width: 1280, height: 800 },
    });

    expect(create).toHaveBeenCalledWith({
      type: "normal",
      focused: false,
      incognito: false,
      url: AGENT_WINDOW_HOME,
      width: 1280,
      height: 800,
    });
  });

  it("checks permission before opening an incognito window", async () => {
    isAllowedIncognitoAccess.mockResolvedValue(true);
    create.mockResolvedValue({ id: 100, incognito: true, tabs: [{ id: 7 }] });
    expect(await chromeAgentWindowApi.create(AGENT_WINDOW_HOME, { incognito: true })).toEqual({
      windowId: 100,
      initialTabIds: [7],
      incognito: true,
    });
    expect(create).toHaveBeenCalledWith({
      type: "normal",
      focused: false,
      incognito: true,
      url: AGENT_WINDOW_HOME,
    });
  });

  it("explains missing incognito permission without creating a window", async () => {
    await expect(
      chromeAgentWindowApi.create(AGENT_WINDOW_HOME, { incognito: true }),
    ).rejects.toThrow(/chrome:\/\/extensions.*Allow in incognito/);
    expect(create).not.toHaveBeenCalled();
  });

  it("propagates a browser refusal without retrying in normal mode", async () => {
    isAllowedIncognitoAccess.mockResolvedValue(true);
    create.mockRejectedValue(new Error("Incognito mode is disabled by policy"));
    await expect(
      chromeAgentWindowApi.create(AGENT_WINDOW_HOME, { incognito: true }),
    ).rejects.toThrow("Incognito mode is disabled by policy");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("seeds an inactive tab on Linux so unfocused Agent Windows bypass X11 Navigate() focus theft and cleans up on failure", async () => {
    const getAll = vi.fn().mockResolvedValue([{ id: 10, focused: true, incognito: false }]);
    const tabCreate = vi.fn().mockResolvedValue({ id: 42 });
    const tabRemove = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      windows: { create, getAll },
      tabs: { create: tabCreate, remove: tabRemove },
      runtime: { getPlatformInfo: vi.fn().mockResolvedValue({ os: "linux" }) },
      extension: { isAllowedIncognitoAccess },
    });
    create.mockResolvedValueOnce({ id: 100, tabs: [{ id: 42 }] });

    expect(
      await chromeAgentWindowApi.create(AGENT_WINDOW_HOME, { size: { width: 800, height: 600 } }),
    ).toEqual({
      windowId: 100,
      initialTabIds: [42],
      incognito: undefined,
    });
    expect(tabCreate).toHaveBeenCalledWith({
      windowId: 10,
      url: AGENT_WINDOW_HOME,
      active: false,
    });
    expect(create).toHaveBeenCalledWith({
      type: "normal",
      focused: false,
      incognito: false,
      tabId: 42,
      width: 800,
      height: 600,
    });
    expect(tabRemove).not.toHaveBeenCalled();

    tabCreate.mockResolvedValueOnce({ id: 43 });
    create.mockRejectedValueOnce(new Error("X11 window creation failed"));
    await expect(chromeAgentWindowApi.create(AGENT_WINDOW_HOME)).rejects.toThrow(
      "X11 window creation failed",
    );
    expect(tabRemove).toHaveBeenCalledWith(43);
  });

  it("excludes other active Agent Windows when picking a Linux seed-tab donor through SessionManager", async () => {
    const { SessionManager } = await import("../manager");
    const { AgentWindowRouting } = await import("../window-routing");

    const onCreatedListeners: Array<(tab: chrome.tabs.Tab) => void> = [];
    const noopEvent = { addListener: vi.fn(), removeListener: vi.fn() };
    let windowsList: chrome.windows.Window[] = [
      { id: 10, focused: false, incognito: false, alwaysOnTop: false },
    ];

    const getAll = vi.fn(async () => windowsList);
    const tabCreate = vi.fn(async (props: chrome.tabs.CreateProperties) => {
      const tab = {
        id: props.windowId === 10 ? 50 + windowsList.length : 99,
        windowId: props.windowId ?? 10,
        url: props.url ?? AGENT_WINDOW_HOME,
        active: props.active ?? false,
      } as chrome.tabs.Tab;
      for (const fn of onCreatedListeners) fn(tab);
      return tab;
    });
    const tabQuery = vi.fn(async ({ windowId }: chrome.tabs.QueryInfo) =>
      windowId === 100
        ? ([{ id: 51, windowId: 100, active: true, url: AGENT_WINDOW_HOME }] as chrome.tabs.Tab[])
        : ([{ id: 52, windowId: 200, active: true, url: AGENT_WINDOW_HOME }] as chrome.tabs.Tab[]),
    );
    const tabMove = vi.fn();

    vi.stubGlobal("chrome", {
      windows: {
        create,
        getAll,
        remove: vi.fn(),
        onFocusChanged: noopEvent,
        onRemoved: noopEvent,
      },
      tabs: {
        create: tabCreate,
        query: tabQuery,
        update: vi.fn(async (id: number) => ({ id, active: true })),
        remove: vi.fn(),
        get: vi.fn(async (id: number) => ({
          id,
          windowId: id === 51 ? 100 : 200,
          active: true,
          url: AGENT_WINDOW_HOME,
        })),
        move: tabMove,
        onCreated: {
          addListener: (fn: (tab: chrome.tabs.Tab) => void) => onCreatedListeners.push(fn),
          removeListener: vi.fn(),
        },
        onAttached: noopEvent,
        onUpdated: noopEvent,
        onRemoved: noopEvent,
        onDetached: noopEvent,
      },
      webNavigation: { onCreatedNavigationTarget: noopEvent },
      runtime: { getPlatformInfo: vi.fn().mockResolvedValue({ os: "linux" }) },
      extension: { isAllowedIncognitoAccess },
    });

    create
      .mockResolvedValueOnce({ id: 100, tabs: [{ id: 51 }] })
      .mockResolvedValueOnce({ id: 200, tabs: [{ id: 52 }] });

    const manager = new SessionManager({ agentWindow: chromeAgentWindowApi });
    const routing = new AgentWindowRouting(manager);
    try {
      await manager.start("session-a");
      // Session A's Agent Window 100 is now focused while user window 10 is unfocused.
      windowsList = [
        { id: 100, focused: true, incognito: false, alwaysOnTop: false },
        { id: 10, focused: false, incognito: false, alwaysOnTop: false },
      ];

      await manager.start("session-b");
      // Session B must seed in user window 10 (never Session A's Agent Window 100).
      expect(tabCreate).toHaveBeenNthCalledWith(2, {
        windowId: 10,
        url: AGENT_WINDOW_HOME,
        active: false,
      });

      // Even if no user window exists (only Session A's Agent Window 100), fallback to { url }.
      windowsList = [
        { id: 100, focused: true, incognito: false, alwaysOnTop: false },
        { id: 200, focused: false, incognito: false, alwaysOnTop: false },
      ];
      create.mockResolvedValueOnce({ id: 300, tabs: [{ id: 53 }] });
      tabQuery.mockResolvedValueOnce([
        { id: 53, windowId: 300, active: true, url: AGENT_WINDOW_HOME } as chrome.tabs.Tab,
      ]);
      await manager.start("session-c");
      expect(tabCreate).toHaveBeenCalledTimes(2);
      expect(create).toHaveBeenLastCalledWith({
        type: "normal",
        focused: false,
        incognito: false,
        url: AGENT_WINDOW_HOME,
      });
      expect(tabMove).not.toHaveBeenCalled();

      // Concurrent startup from zero existing sessions must also observe a live excludeWindowIds set:
      // when concurrent-a creates Agent Window 400 while concurrent-b is awaiting windows.getAll(),
      // concurrent-b must exclude 400 instead of seeing a stale empty snapshot.
      await manager.stopAll();
      tabCreate.mockClear();
      let releaseSecondGetAll!: () => void;
      const secondGetAllGate = new Promise<void>((resolve) => {
        releaseSecondGetAll = resolve;
      });
      let getAllCalls = 0;
      getAll.mockImplementation(async () => {
        getAllCalls += 1;
        if (getAllCalls === 2) await secondGetAllGate;
        return windowsList;
      });
      windowsList = [{ id: 10, focused: false, incognito: false, alwaysOnTop: false }];
      create
        .mockImplementationOnce(async () => {
          windowsList = [
            { id: 400, focused: true, incognito: false, alwaysOnTop: false },
            { id: 10, focused: false, incognito: false, alwaysOnTop: false },
          ];
          queueMicrotask(releaseSecondGetAll);
          return { id: 400, tabs: [{ id: 51 }] };
        })
        .mockResolvedValueOnce({ id: 500, tabs: [{ id: 52 }] });
      tabQuery
        .mockResolvedValueOnce([
          { id: 51, windowId: 400, active: true, url: AGENT_WINDOW_HOME } as chrome.tabs.Tab,
        ])
        .mockResolvedValueOnce([
          { id: 52, windowId: 500, active: true, url: AGENT_WINDOW_HOME } as chrome.tabs.Tab,
        ]);

      await Promise.all([manager.start("concurrent-a"), manager.start("concurrent-b")]);
      expect(tabCreate).toHaveBeenNthCalledWith(2, {
        windowId: 10,
        url: AGENT_WINDOW_HOME,
        active: false,
      });
      expect(tabMove).not.toHaveBeenCalled();
    } finally {
      routing.dispose();
    }
  });
});
