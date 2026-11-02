import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleTabBorrow,
  handleTabCreate,
  handleTabReturn,
  type TabMutationApi,
} from "@/tools/tabs";
import { SessionManager } from "../manager";
import { ExpectedTabMoves, expectedTabMoves } from "../tab-moves";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const movement = { tabId: 7, fromWindowId: 10, toWindowId: 20 };
afterEach(() => expectedTabMoves.clear());

describe("expected tab moves", () => {
  it("returns an immediate false for an unregistered tab or source window", async () => {
    const moves = new ExpectedTabMoves();
    await moves.run(movement, async () => {});
    expect(moves.onDetached(8, 10)).toBe(false);
    expect(moves.onDetached(7, 30)).toBe(false);
    moves.clear();
  });

  it("requires the actual destination and consumes only one detach", async () => {
    const moves = new ExpectedTabMoves();
    const action = deferred<void>();
    const running = moves.run(movement, () => action.promise);
    const detached = moves.onDetached(7, 10);
    expect(detached).toBeInstanceOf(Promise);
    moves.onAttached(7, 20);
    await expect(detached).resolves.toBe(true);
    expect(moves.onDetached(7, 10)).toBe(false);
    action.resolve();
    await running;
  });

  it("retains an operation when the API completes before browser events", async () => {
    const moves = new ExpectedTabMoves();
    await moves.run(movement, async () => {});
    const detached = moves.onDetached(7, 10);
    moves.onAttached(7, 20);
    await expect(detached).resolves.toBe(true);
  });

  it("does not mistake a concurrent user move for the program's destination", async () => {
    const moves = new ExpectedTabMoves();
    const action = deferred<void>();
    const running = moves.run(movement, () => action.promise);
    const userDetach = moves.onDetached(7, 10);
    // The API can already report success for its later C -> B move. That
    // cannot authorize the user's earlier A -> C detach still awaiting attach.
    action.resolve();
    await running;
    moves.onAttached(7, 30);
    await expect(userDetach).resolves.toBe(false);
    expect(moves.onDetached(7, 30)).toBe(false);
    moves.onAttached(7, 20);
  });

  it("pairs consecutive detach/attach events instead of skipping unmatched moves", async () => {
    const moves = new ExpectedTabMoves();
    expect(moves.onDetached(7, 30)).toBe(false);
    await moves.run(movement, async () => {});
    const ownDetach = moves.onDetached(7, 10);
    moves.onAttached(7, 10);
    moves.onAttached(7, 20);
    await expect(ownDetach).resolves.toBe(true);
  });

  it("invalidates unused operations when the tab moves from an unrelated origin", async () => {
    const moves = new ExpectedTabMoves();
    await moves.run(movement, async () => {});
    expect(moves.onDetached(7, 20)).toBe(false);
    moves.onAttached(7, 10);
    expect(moves.onDetached(7, 10)).toBe(false);
  });

  it("clears failed calls without waiting for browser events", async () => {
    const moves = new ExpectedTabMoves();
    await expect(
      moves.run(movement, async () => {
        throw new Error("move failed");
      }),
    ).rejects.toThrow("move failed");
    expect(moves.onDetached(7, 10)).toBe(false);
  });

  it("releases a waiting detach when its API call fails", async () => {
    const moves = new ExpectedTabMoves();
    const action = deferred<void>();
    const running = moves.run(movement, () => action.promise);
    const detached = moves.onDetached(7, 10);
    action.reject(new Error("move failed"));
    await expect(running).rejects.toThrow("move failed");
    await expect(detached).resolves.toBe(false);
  });

  it("does not register same-window reordering or ambiguous overlapping operations", async () => {
    const moves = new ExpectedTabMoves();
    await moves.run({ ...movement, toWindowId: 10 }, async () => {});
    expect(moves.onDetached(7, 10)).toBe(false);
    moves.onAttached(7, 20);
    await moves.run(movement, async () => {});
    await moves.run(movement, async () => {});
    expect(moves.onDetached(7, 10)).toBe(false);
  });

  it("releases pending classification when the tab closes", async () => {
    const moves = new ExpectedTabMoves();
    await moves.run(movement, async () => {});
    const detached = moves.onDetached(7, 10);
    moves.forget(7);
    await expect(detached).resolves.toBe(false);
    expect(moves.onDetached(7, 10)).toBe(false);
  });
});

async function toolFixture() {
  const manager = new SessionManager({
    agentWindow: {
      create: async () => ({ windowId: 10, initialTabIds: [1] }),
      ensureActiveTab: async () => 1,
      remove: async () => {},
    },
  });
  const task = await manager.start("one");
  const tab = { id: 7, windowId: 20, index: 3, url: "https://example.com" } as chrome.tabs.Tab;
  const classifications: (boolean | Promise<boolean>)[] = [];
  let afterMove = () => {};
  const api: TabMutationApi = {
    create: vi.fn(),
    remove: vi.fn(),
    update: async () => ({ ...tab }),
    get: async () => ({ ...tab }),
    move: vi.fn(async (_id, properties) => {
      const oldWindow = tab.windowId;
      classifications.push(expectedTabMoves.onDetached(tab.id!, oldWindow));
      tab.windowId = properties.windowId!;
      tab.index = properties.index;
      expectedTabMoves.onAttached(tab.id!, tab.windowId);
      afterMove();
      return { ...tab };
    }),
  };
  const deps = {
    tabs: api,
    approveBorrow: async () => true,
    windows: {
      get: async (id: number) => ({ id }) as chrome.windows.Window,
      getLastFocused: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
    },
    agentOverlayReset: { resetAgentOverlays: async () => {} },
  };
  return {
    manager,
    task,
    tab,
    deps,
    classifications,
    afterMove: (fn: () => void) => (afterMove = fn),
  };
}

describe("tab tool move registration", () => {
  it.each([
    "borrow",
    "return",
  ] as const)("does not move a tab when %s is cancelled before native dispatch", async (kind) => {
    const f = await toolFixture();
    const abort = new AbortController();
    if (kind === "return") {
      f.tab.windowId = 10;
      f.task.borrowedTabs.set(7, { tabId: 7, originalWindowId: 20, originalIndex: 3 });
    }
    const handler = kind === "borrow" ? handleTabBorrow : handleTabReturn;
    expect(
      await handler(
        f.manager,
        { session_id: "one", tab_id: 7 },
        {
          ...f.deps,
          signal: abort.signal,
          cdp: {
            runBrowserMutation: async (operation) => {
              abort.abort();
              return operation();
            },
          },
        },
      ),
    ).toMatchObject({ code: "cancelled" });
    expect(f.deps.tabs.move).not.toHaveBeenCalled();
    expect(expectedTabMoves.onDetached(7, f.tab.windowId)).toBe(false);
  });

  it("recognizes ordinary borrowing and returning as separate program moves", async () => {
    const f = await toolFixture();
    expect(
      await handleTabBorrow(f.manager, { session_id: "one", tab_id: 7 }, f.deps),
    ).toMatchObject({ agent_window_id: 10 });
    expect(
      await handleTabReturn(f.manager, { session_id: "one", tab_id: 7 }, f.deps),
    ).toMatchObject({ returned_to_window_id: 20 });
    expect(await Promise.all(f.classifications)).toEqual([true, true]);
    expect(f.manager.get("one")).toBe(f.task);
  });

  it("registers cancellation rollback independently of the original borrow", async () => {
    const f = await toolFixture();
    const abort = new AbortController();
    f.afterMove(() => abort.abort());
    expect(
      await handleTabBorrow(
        f.manager,
        { session_id: "one", tab_id: 7 },
        { ...f.deps, signal: abort.signal },
      ),
    ).toMatchObject({ code: "cancelled" });
    expect(f.tab.windowId).toBe(20);
    expect(await Promise.all(f.classifications)).toEqual([true, true]);
  });

  it("registers the fallback return destination after the original window is gone", async () => {
    const f = await toolFixture();
    f.tab.windowId = 10;
    f.task.borrowedTabs.set(7, { tabId: 7, originalWindowId: 20, originalIndex: 3 });
    f.deps.windows.get = async () => {
      throw new Error("window closed");
    };
    f.deps.windows.getLastFocused.mockResolvedValue({ id: 30, type: "normal", incognito: false });
    expect(
      await handleTabReturn(f.manager, { session_id: "one", tab_id: 7 }, f.deps),
    ).toMatchObject({ returned_to_window_id: 30, fallback: true });
    expect(await Promise.all(f.classifications)).toEqual([true]);
  });
});

describe("released session transactions", () => {
  it("preserves a fallback window released to the user while its creation completes", async () => {
    const f = await toolFixture();
    f.tab.windowId = 10;
    f.task.borrowedTabs.set(7, { tabId: 7, originalWindowId: 20, originalIndex: 3 });
    f.deps.windows.get = async () => {
      throw new Error("window gone");
    };
    f.deps.windows.getLastFocused.mockResolvedValue({ id: 10 });
    f.deps.windows.create.mockImplementation(async () => {
      f.manager.release("one");
      return { id: 30 };
    });
    expect(
      await handleTabReturn(f.manager, { session_id: "one", tab_id: 7 }, f.deps),
    ).toMatchObject({ code: "cancelled" });
    expect(f.deps.windows.remove).not.toHaveBeenCalled();
    expect(f.deps.tabs.move).not.toHaveBeenCalled();
  });

  it.each([
    false,
    true,
  ])("preserves a borrowed page moved by the user during setup (abort: %s)", async (shouldAbort) => {
    const f = await toolFixture();
    const abort = new AbortController();
    const result = await handleTabBorrow(
      f.manager,
      { session_id: "one", tab_id: 7 },
      {
        ...f.deps,
        signal: abort.signal,
        cdp: {
          acquireBackgroundExecution: async () => {
            f.tab.windowId = 30;
            f.manager.release("one");
            if (shouldAbort) abort.abort();
          },
        },
      },
    );
    expect(result).toMatchObject({ code: "cancelled" });
    expect(f.deps.tabs.move).toHaveBeenCalledTimes(1);
    expect(f.tab.windowId).toBe(30);
  });

  it("does not roll back an uncommitted borrow after its session is released", async () => {
    const f = await toolFixture();
    const abort = new AbortController();
    f.afterMove(() => {
      f.tab.windowId = 30;
      f.manager.release("one");
      abort.abort();
    });
    expect(
      await handleTabBorrow(
        f.manager,
        { session_id: "one", tab_id: 7 },
        {
          ...f.deps,
          signal: abort.signal,
        },
      ),
    ).toMatchObject({ code: "cancelled" });
    expect(f.deps.tabs.move).toHaveBeenCalledTimes(1);
    expect(f.tab.windowId).toBe(30);
  });

  it("stops cancellation rollback if the session is released during its source lookup", async () => {
    const f = await toolFixture();
    const abort = new AbortController();
    f.afterMove(() => abort.abort());
    f.deps.tabs.get = async () => {
      if (abort.signal.aborted) {
        f.tab.windowId = 30;
        f.manager.release("one");
      }
      return { ...f.tab };
    };
    expect(
      await handleTabBorrow(
        f.manager,
        { session_id: "one", tab_id: 7 },
        {
          ...f.deps,
          signal: abort.signal,
        },
      ),
    ).toMatchObject({ code: "cancelled" });
    expect(f.deps.tabs.move).toHaveBeenCalledTimes(1);
    expect(f.tab.windowId).toBe(30);
  });

  it("stops setup rollback if the session is released while resolving the return window", async () => {
    const f = await toolFixture();
    f.deps.windows.get = async (id) => {
      f.tab.windowId = 30;
      f.manager.release("one");
      return { id } as chrome.windows.Window;
    };
    expect(
      await handleTabBorrow(
        f.manager,
        { session_id: "one", tab_id: 7 },
        {
          ...f.deps,
          cdp: {
            acquireBackgroundExecution: async () => {
              throw new Error("setup failed");
            },
          },
        },
      ),
    ).toMatchObject({ code: "cancelled" });
    expect(f.deps.tabs.move).toHaveBeenCalledTimes(1);
    expect(f.tab.windowId).toBe(30);
  });

  it("preserves a newly created page when its response arrives after session release", async () => {
    const f = await toolFixture();
    const abort = new AbortController();
    f.deps.tabs.create = async () => {
      f.tab.windowId = 30;
      f.manager.release("one");
      abort.abort();
      return { ...f.tab };
    };
    expect(
      await handleTabCreate(
        f.manager,
        { session_id: "one" },
        {
          ...f.deps,
          signal: abort.signal,
        },
      ),
    ).toMatchObject({ code: "cancelled" });
    expect(f.deps.tabs.remove).not.toHaveBeenCalled();
    expect(f.task.agentCreatedTabs.has(7)).toBe(false);
  });

  it.each([
    "setup",
    "release",
  ] as const)("preserves a created page released during background %s cleanup", async (stage) => {
    const f = await toolFixture();
    const abort = new AbortController();
    f.deps.tabs.create = async () => ({ ...f.tab, windowId: 10 });
    const relinquish = () => {
      f.tab.windowId = 30;
      f.manager.release("one");
      abort.abort();
    };
    const releaseSessionTab = vi.fn(async () => {
      if (stage === "release") relinquish();
    });
    expect(
      await handleTabCreate(
        f.manager,
        { session_id: "one", url: "https://example.com" },
        {
          ...f.deps,
          signal: abort.signal,
          cdp: {
            acquireBackgroundExecution: async () => {
              if (stage === "setup") relinquish();
              throw new Error("setup failed");
            },
            releaseSessionTab,
          },
        },
      ),
    ).toMatchObject({ code: "cancelled" });
    expect(releaseSessionTab).toHaveBeenCalledWith("one", 7);
    expect(f.deps.tabs.remove).not.toHaveBeenCalled();
    expect(f.tab.windowId).toBe(30);
  });
});
