import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../manager";
import { attachAgentWindowTabGuard, type TabGuardEvents } from "../tab-guard";

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
  let nextWindowId = AGENT_WINDOW;
  const manager = new SessionManager({
    agentWindow: {
      create: vi.fn(async () => ({ windowId: nextWindowId++, initialTabIds: [HOME_TAB] })),
      ensureActiveTab: vi.fn(async () => HOME_TAB),
      remove: vi.fn(async () => {}),
    },
  });
  const ctx = await manager.start("aa11");

  const tabs = {
    get: vi.fn(async (_tabId: number) => ({}) as { openerTabId?: number }),
    move: vi.fn(async () => {}),
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
  const harness = makeEvents();
  const guard = attachAgentWindowTabGuard({
    manager,
    tabs,
    windows,
    events: harness.events,
    onError: (error) => {
      throw error;
    },
  });
  return { manager, ctx, tabs, windows, guard, ...harness };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("agent window tab guard", () => {
  it("evicts a tab the OS routed into the Agent Window", async () => {
    const h = await setup();

    h.emitCreated({ id: 42, windowId: AGENT_WINDOW });
    await flush();

    expect(h.tabs.move).toHaveBeenCalledWith(42, { windowId: USER_WINDOW, index: -1 });
    expect(h.windows.focus).toHaveBeenCalledWith(USER_WINDOW);
    expect(h.tabs.update).toHaveBeenCalledWith(42, { active: true });
  });

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
