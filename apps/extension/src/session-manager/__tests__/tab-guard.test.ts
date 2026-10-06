import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../manager";
import { attachAgentWindowTabGuard, chromeTabGuardEvents, type TabGuardEvents } from "../tab-guard";
import { withTaskPopups } from "../task-popups";

const AGENT_WINDOW = 100;
const USER_WINDOW = 7;
const HOME_TAB = 1;

function makeEvents() {
  const created: Array<(tab: { id?: number; windowId?: number; openerTabId?: number }) => void> =
    [];
  const attached: Array<(tabId: number, info: { newWindowId: number }) => void> = [];
  const events: TabGuardEvents = {
    onCreated: {
      addListener: (cb) => {
        created.push(cb);
      },
      removeListener: (cb) => {
        const i = created.indexOf(cb);
        if (i >= 0) created.splice(i, 1);
      },
    },
    onAttached: {
      addListener: (cb) => {
        attached.push(cb);
      },
      removeListener: (cb) => {
        const i = attached.indexOf(cb);
        if (i >= 0) attached.splice(i, 1);
      },
    },
  };
  return {
    events,
    emitCreated: (tab: { id?: number; windowId?: number; openerTabId?: number }) => {
      for (const cb of created) cb(tab);
    },
    emitAttached: (tabId: number, newWindowId: number) => {
      for (const cb of attached) cb(tabId, { newWindowId });
    },
    listenerCount: () => created.length + attached.length,
  };
}

async function setup(overrides: { userWindows?: number[]; lastFocused?: number | null } = {}) {
  const tabOpeners = new Map<number, number>();
  let nextWindowId = AGENT_WINDOW;
  const manager = new SessionManager({
    agentWindow: {
      create: vi.fn(async () => ({ windowId: nextWindowId++, initialTabIds: [HOME_TAB] })),
      ensureActiveTab: vi.fn(async () => HOME_TAB),
      remove: vi.fn(async () => {}),
    },
  });
  const ctx = await manager.start("aa11");

  // Model where each tab lives. The guard re-reads the tab before moving it,
  // so a `get` that answers without a windowId is not a faithful stand-in for
  // chrome.tabs.get and would let the guard move a tab it cannot locate.
  const tabWindows = new Map<number, number>();
  const tabs = {
    get: vi.fn(async (tabId: number) => ({
      id: tabId,
      windowId: tabWindows.get(tabId) ?? AGENT_WINDOW,
      openerTabId: tabOpeners.get(tabId),
    })),
    move: vi.fn(async (tabId: number, props: { windowId: number }) => {
      tabWindows.set(tabId, props.windowId);
    }),
    update: vi.fn(async () => {}),
  };
  const userWindows = overrides.userWindows ?? [USER_WINDOW];
  const windows = {
    listNormalIds: vi.fn(async () => [AGENT_WINDOW, ...userWindows]),
    getLastFocusedNormalId: vi.fn(async () =>
      overrides.lastFocused === undefined ? AGENT_WINDOW : overrides.lastFocused,
    ),
    createWithTab: vi.fn(async () => ({ id: 999 })),
    focus: vi.fn(async () => {}),
  };
  const focusListeners: Array<(windowId: number) => void> = [];
  const harness = makeEvents();
  const guard = attachAgentWindowTabGuard({
    manager,
    tabs,
    windows,
    events: {
      ...harness.events,
      onFocusChanged: {
        addListener: (cb: (windowId: number) => void) => focusListeners.push(cb),
        removeListener: () => {},
      },
    },
    onError: (error) => {
      throw error;
    },
  });
  return {
    manager,
    ctx,
    tabs,
    tabWindows,
    tabOpeners,
    windows,
    guard,
    focusWindow: (windowId: number) => {
      for (const cb of focusListeners) cb(windowId);
    },
    ...harness,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("chrome event wiring", () => {
  const listener = () => ({ addListener: () => {}, removeListener: () => {} });

  it("subscribes to focus as well as creation and attachment", () => {
    vi.stubGlobal("chrome", {
      tabs: { onCreated: listener(), onAttached: listener() },
      windows: { onFocusChanged: listener() },
    });
    // The guard treats onFocusChanged as optional and the fixtures below supply
    // their own, so a call site that omits it keeps every other case green while
    // the extension never learns which user window was last focused.
    const events = chromeTabGuardEvents();
    expect(events.onCreated).toBe(chrome.tabs.onCreated);
    expect(events.onAttached).toBe(chrome.tabs.onAttached);
    expect(events.onFocusChanged).toBe(chrome.windows.onFocusChanged);
    vi.unstubAllGlobals();
  });
});

describe("agent window tab guard", () => {
  it("evicts a tab the OS routed into the Agent Window", async () => {
    const h = await setup();

    h.emitCreated({ id: 42, windowId: AGENT_WINDOW });
    await flush();

    expect(h.tabs.move).toHaveBeenCalledWith(42, { windowId: USER_WINDOW, index: -1 });
    expect(h.windows.focus).toHaveBeenCalledWith(USER_WINDOW);
    expect(h.tabs.update).toHaveBeenCalledWith(42, { active: true });
  });

  it("abandons the move when the user pulls the tab out during a retry backoff", async () => {
    // Each backoff is long enough for the user to drag the tab elsewhere. Moving
    // it then drags it back from wherever they put it.
    const h = await setup();
    h.tabWindows.set(42, AGENT_WINDOW);
    h.tabs.move.mockImplementationOnce(async () => {
      // The drag that refused the move is the same drag that lands it elsewhere.
      h.tabWindows.set(42, 4242);
      throw new Error("Tabs cannot be edited right now");
    });

    h.emitCreated({ id: 42, windowId: AGENT_WINDOW });
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(h.tabs.move).toHaveBeenCalledTimes(1);
    expect(h.windows.focus).not.toHaveBeenCalled();
    expect(h.tabs.update).not.toHaveBeenCalled();
  });

  it("does not focus or activate a tab whose move was abandoned", async () => {
    // The tab became the agent's between attempts. Focusing the user window and
    // activating the tab there is follow-up work for a move that never happened.
    const h = await setup();
    h.tabWindows.set(42, AGENT_WINDOW);
    h.tabs.move.mockRejectedValueOnce(new Error("Tabs cannot be edited right now"));
    h.tabs.move.mockImplementationOnce(async () => {
      throw new Error("must not run: the tab is the agent's by now");
    });
    setTimeout(() => h.ctx.agentCreatedTabs.add(42), 10);

    h.emitCreated({ id: 42, windowId: AGENT_WINDOW });
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(h.windows.focus).not.toHaveBeenCalled();
    expect(h.tabs.update).not.toHaveBeenCalled();
  });

  it("gives up on a claim that never settles instead of blocking the session", async () => {
    // The round bound caps how many times the guard re-reads, not how long one
    // Promise.all waits. A claim that never settles would hold every other tab
    // in the session behind it.
    const h = await setup();
    h.manager.trackPendingTabClaim(h.ctx.sessionId, new Promise(() => {}));

    h.emitCreated({ id: 42, windowId: AGENT_WINDOW });
    // Two settles per eviction, so the stuck claim can cost at most two bounds.
    await new Promise((resolve) => setTimeout(resolve, 2_400));

    expect(h.tabs.move).toHaveBeenCalledWith(42, { windowId: USER_WINDOW, index: -1 });
  }, 10_000);

  it("keeps a popup whose claim is registered while the destination is being chosen", async () => {
    // onCreated reaches the guard before the navigation-target event, so the
    // first wait finds nothing in flight and returns at once. withTaskPopups
    // then registers the claim while resolveUserWindow is still running, which
    // is the window in which the popup used to be evicted.
    const h = await setup();
    const POPUP = 77;
    const SOURCE = HOME_TAB;
    h.ctx.agentCreatedTabs.add(SOURCE);

    const targetListeners = new Set<
      (e: { sourceTabId: number; sourceFrameId: number; tabId: number }) => void
    >();
    vi.stubGlobal("chrome", {
      webNavigation: {
        onCreatedNavigationTarget: {
          addListener: (fn: never) => targetListeners.add(fn),
          removeListener: (fn: never) => targetListeners.delete(fn),
        },
      },
      tabs: {
        get: async (id: number) => ({ id, windowId: AGENT_WINDOW }),
        onRemoved: { addListener: () => {}, removeListener: () => {} },
        onDetached: { addListener: () => {}, removeListener: () => {} },
      },
    });

    // Hold the destination lookup open so the claim lands during it.
    let releaseLookup = () => {};
    const lookupReached = new Promise<void>((resolve) => {
      h.windows.listNormalIds.mockImplementationOnce(async () => {
        resolve();
        await new Promise<void>((r) => {
          releaseLookup = r;
        });
        return [AGENT_WINDOW, USER_WINDOW];
      });
    });

    await withTaskPopups(h.manager, { session_id: h.ctx.sessionId }, async (inputSent) => {
      inputSent(SOURCE);
      h.emitCreated({ id: POPUP, windowId: AGENT_WINDOW });
      await lookupReached;
      for (const fn of targetListeners) {
        fn({ sourceTabId: SOURCE, sourceFrameId: 0, tabId: POPUP });
      }
      releaseLookup();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(h.ctx.observedTabs?.has(POPUP)).toBe(true);
    expect(h.tabs.move).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  }, 10_000);

  it("keeps the session home tab and tabs the agent created", async () => {
    const h = await setup();
    h.ctx.agentCreatedTabs.add(55);

    h.emitCreated({ id: HOME_TAB, windowId: AGENT_WINDOW });
    h.emitCreated({ id: 55, windowId: AGENT_WINDOW });
    await flush();

    expect(h.tabs.move).not.toHaveBeenCalled();
  });

  it("keeps a borrowed user tab", async () => {
    const h = await setup();
    h.ctx.borrowedTabs.set(77, { tabId: 77, originalWindowId: USER_WINDOW, originalIndex: 0 });

    h.emitAttached(77, AGENT_WINDOW);
    await flush();

    expect(h.tabs.move).not.toHaveBeenCalled();
  });

  it("keeps a popup whose opener is an agent tab", async () => {
    const h = await setup();

    h.emitCreated({ id: 88, windowId: AGENT_WINDOW, openerTabId: HOME_TAB });
    await flush();

    expect(h.tabs.move).not.toHaveBeenCalled();
  });

  it("evicts a popup whose opener is a foreign tab", async () => {
    const h = await setup();

    h.emitCreated({ id: 89, windowId: AGENT_WINDOW, openerTabId: 4242 });
    await flush();

    expect(h.tabs.move).toHaveBeenCalledWith(89, { windowId: USER_WINDOW, index: -1 });
  });

  it("ignores tabs in windows that are not Agent Windows", async () => {
    const h = await setup();

    h.emitCreated({ id: 90, windowId: USER_WINDOW });
    await flush();

    expect(h.tabs.move).not.toHaveBeenCalled();
  });

  it("prefers the last focused user window over an arbitrary one", async () => {
    const h = await setup({ userWindows: [5, 6, 7], lastFocused: 6 });

    h.emitCreated({ id: 42, windowId: AGENT_WINDOW });
    await flush();

    expect(h.tabs.move).toHaveBeenCalledWith(42, { windowId: 6, index: -1 });
  });

  it("never evicts into another session's Agent Window", async () => {
    const h = await setup({ userWindows: [], lastFocused: null });
    const second = await h.manager.start("bb22");
    h.windows.listNormalIds.mockResolvedValue([AGENT_WINDOW, second.agentWindowId]);

    h.emitCreated({ id: 42, windowId: AGENT_WINDOW });
    await flush();

    expect(h.windows.createWithTab).toHaveBeenCalledWith(42);
    expect(h.tabs.move).not.toHaveBeenCalled();
  });

  it("opens a window around the tab when the user has none", async () => {
    const h = await setup({ userWindows: [], lastFocused: null });

    h.emitCreated({ id: 42, windowId: AGENT_WINDOW });
    await flush();

    expect(h.windows.createWithTab).toHaveBeenCalledWith(42);
    expect(h.tabs.move).not.toHaveBeenCalled();
  });

  it("keeps a tab that tab_borrow has reserved but not yet committed", async () => {
    const h = await setup();
    const reservation = h.manager.tryReserveBorrow(66, "aa11");
    expect("release" in reservation).toBe(true);

    h.emitAttached(66, AGENT_WINDOW);
    await flush();

    expect(h.tabs.move).not.toHaveBeenCalled();
  });

  it("evicts a tab another session has borrowed", async () => {
    const h = await setup();
    await h.manager.start("bb22");
    h.manager.tryReserveBorrow(67, "bb22");

    h.emitAttached(67, AGENT_WINDOW);
    await flush();

    expect(h.tabs.move).toHaveBeenCalledWith(67, { windowId: USER_WINDOW, index: -1 });
  });

  it("detaches both listeners on dispose", async () => {
    const h = await setup();
    expect(h.listenerCount()).toBe(2);

    h.guard.dispose();

    expect(h.listenerCount()).toBe(0);
  });
});

describe("agent window tab guard: claims still in flight", () => {
  it("keeps a tab whose tab_create has not resolved yet", async () => {
    // chrome.tabs.onCreated fires before chrome.tabs.create() resolves, so at
    // this point agentCreatedTabs cannot hold the id yet. Reported in review:
    // the guard classified the tab as foreign and evicted the agent's own tab.
    const h = await setup();
    let finishCreate = () => {};
    const creating = new Promise<void>((resolve) => {
      finishCreate = () => {
        h.ctx.agentCreatedTabs.add(77);
        resolve();
      };
    });
    h.manager.trackPendingTabClaim(h.ctx.sessionId, creating);

    h.emitCreated({ id: 77, windowId: AGENT_WINDOW });
    finishCreate();
    await flush();

    expect(h.tabs.move).not.toHaveBeenCalled();
    expect(h.windows.createWithTab).not.toHaveBeenCalled();
  });

  it("keeps a popup whose observation completes after onCreated", async () => {
    // withTaskPopups decides asynchronously whether a navigation target belongs
    // to the task, and records it in observedTabs only once it does.
    const h = await setup();
    let finishObservation = () => {};
    const observing = new Promise<void>((resolve) => {
      finishObservation = () => {
        (h.ctx.observedTabs ??= new Set()).add(88);
        resolve();
      };
    });
    h.manager.trackPendingTabClaim(h.ctx.sessionId, observing);

    h.emitCreated({ id: 88, windowId: AGENT_WINDOW });
    finishObservation();
    await flush();

    expect(h.tabs.move).not.toHaveBeenCalled();
  });

  it("still evicts when the in-flight claim turns out not to be this tab", async () => {
    // Waiting must not become a blanket amnesty: a claim that resolves without
    // taking this tab leaves it foreign.
    const h = await setup();
    let finishCreate = () => {};
    const creating = new Promise<void>((resolve) => {
      finishCreate = () => {
        h.ctx.agentCreatedTabs.add(99);
        resolve();
      };
    });
    h.manager.trackPendingTabClaim(h.ctx.sessionId, creating);

    h.emitCreated({ id: 42, windowId: AGENT_WINDOW });
    finishCreate();
    await flush();

    expect(h.tabs.move).toHaveBeenCalledWith(42, { windowId: USER_WINDOW, index: -1 });
  });

  it("does not wait forever on a claim that never settles", async () => {
    // A tool that leaks a pending claim must not hold the guard open, so a
    // rejected claim settles it like any other.
    const h = await setup();
    h.manager.trackPendingTabClaim(h.ctx.sessionId, Promise.reject(new Error("tool failed")));

    h.emitCreated({ id: 42, windowId: AGENT_WINDOW });
    await flush();

    expect(h.tabs.move).toHaveBeenCalledWith(42, { windowId: USER_WINDOW, index: -1 });
  });
});

describe("agent window tab guard: state revalidation", () => {
  it("leaves a tab alone when the user moved it out while we looked", async () => {
    const h = await setup();
    h.windows.getLastFocusedNormalId.mockImplementation(async () => {
      h.tabWindows.set(42, USER_WINDOW);
      return USER_WINDOW;
    });

    h.emitCreated({ id: 42, windowId: AGENT_WINDOW });
    await flush();

    expect(h.tabs.move).not.toHaveBeenCalled();
  });

  it("leaves a tab alone when the session ended while we looked", async () => {
    const h = await setup();
    h.windows.getLastFocusedNormalId.mockImplementation(async () => {
      await h.manager.stop(h.ctx.sessionId).catch(() => {});
      return USER_WINDOW;
    });

    h.emitCreated({ id: 42, windowId: AGENT_WINDOW });
    await flush();

    expect(h.tabs.move).not.toHaveBeenCalled();
  });

  it("retries a move Chrome refused while the tab was being dragged", async () => {
    const h = await setup();
    h.tabs.move
      .mockRejectedValueOnce(new Error("Tabs cannot be edited right now (user may be dragging)"))
      .mockImplementationOnce(async (tabId: number, props: { windowId: number }) => {
        h.tabWindows.set(tabId, props.windowId);
      });

    h.emitCreated({ id: 42, windowId: AGENT_WINDOW });
    // The retry backs off before its second attempt, so a zero-delay tick is
    // not enough to observe it.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(h.tabs.move).toHaveBeenCalledTimes(2);
    expect(h.windows.focus).toHaveBeenCalledWith(USER_WINDOW);
  });
});

describe("agent window tab guard: which user window", () => {
  it("returns the tab to the user window that was actually focused last", async () => {
    // Reported in review: chrome.windows.getLastFocused answers with the Agent
    // Window in the main scenario, and the fallback then took the first
    // non-agent window, which need not be the one the user was working in.
    const h = await setup({ userWindows: [6, USER_WINDOW] });
    h.focusWindow(6);
    h.focusWindow(USER_WINDOW);

    h.emitCreated({ id: 42, windowId: AGENT_WINDOW });
    await flush();

    expect(h.tabs.move).toHaveBeenCalledWith(42, { windowId: USER_WINDOW, index: -1 });
  });

  it("ignores focus on an Agent Window and on focus leaving the browser", async () => {
    const h = await setup({ userWindows: [6, USER_WINDOW] });
    h.focusWindow(USER_WINDOW);
    h.focusWindow(AGENT_WINDOW);
    h.focusWindow(-1);

    h.emitCreated({ id: 42, windowId: AGENT_WINDOW });
    await flush();

    expect(h.tabs.move).toHaveBeenCalledWith(42, { windowId: USER_WINDOW, index: -1 });
  });

  it("skips a remembered window the user has since closed", async () => {
    const h = await setup({ userWindows: [USER_WINDOW] });
    h.focusWindow(4242);
    h.focusWindow(USER_WINDOW);
    h.focusWindow(4242);

    h.emitCreated({ id: 42, windowId: AGENT_WINDOW });
    await flush();

    expect(h.tabs.move).toHaveBeenCalledWith(42, { windowId: USER_WINDOW, index: -1 });
  });
});
