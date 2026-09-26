import { describe, expect, it } from "vitest";
import { resolveTargetTab } from "@/tools/shared";
import { type SessionContext, SessionManager } from "../manager";
import { RefStore } from "../ref-store";
import {
  BROWSER_RUN_ID_KEY,
  SESSION_RESOURCE_JOURNAL_KEY,
  SessionResourceJournal,
} from "../resource-journal";

class MemoryStorage {
  readonly values = new Map<string, unknown>();

  async get(keys: string | string[]): Promise<Record<string, unknown>> {
    const requested = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      requested.filter((key) => this.values.has(key)).map((key) => [key, this.values.get(key)]),
    );
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.values.set(key, value);
  }
}

function context(sessionId: string): SessionContext {
  return {
    sessionId,
    remote: true,
    container: { mode: "in_window", hostWindowId: 10 },
    activeTabId: 21,
    refStore: new RefStore(),
    borrowedTabs: new Map([
      [
        7,
        {
          tabId: 7,
          originalWindowId: 10,
          originalIndex: 0,
          stationary: true,
        },
      ],
    ]),
    agentCreatedTabs: new Set([21]),
    createdAtMs: 123,
  };
}

describe("session resource journal", () => {
  it("round-trips all physical ownership for the current browser run", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const journal = new SessionResourceJournal({ local, session, randomId: () => "run-a" });

    await journal.save(context("s1"));

    expect(await journal.recoverable()).toEqual([
      expect.objectContaining({
        browserRunId: "run-a",
        sessionId: "s1",
        phase: "active",
        remote: true,
        activeTabId: 21,
        agentCreatedTabIds: [21],
        borrowedTabs: [expect.objectContaining({ tabId: 7, stationary: true })],
      }),
    ]);
    expect(local.values.has(BROWSER_RUN_ID_KEY)).toBe(false);
    expect(session.values.get(BROWSER_RUN_ID_KEY)).toBe("run-a");

    await journal.remove("s1");
    expect(await journal.recoverable()).toEqual([]);
  });

  it("keeps the last controlled tab after the user activates an unowned tab", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const journal = new SessionResourceJournal({ local, session, randomId: () => "run-a" });
    const ctx = context("last-controlled");
    ctx.remote = false;
    ctx.borrowedTabs.clear();
    ctx.agentCreatedTabs.add(20);
    await journal.save(ctx);

    const manager = new SessionManager();
    const restored = manager.restore((await journal.recoverable())[0]);
    const tabs = [
      { id: 1, windowId: 10, index: 0, active: true },
      { id: 20, windowId: 10, index: 1, active: false },
      { id: 21, windowId: 10, index: 2, active: false },
    ] as chrome.tabs.Tab[];
    expect(
      await resolveTargetTab(manager, restored, undefined, {
        get: async (id) => tabs.find((tab) => tab.id === id)!,
        query: async () => tabs,
      }),
    ).toMatchObject({ tabId: 21, active: false });
  });

  it("does not treat records from a previous browser run as live Chrome ids", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    local.values.set(SESSION_RESOURCE_JOURNAL_KEY, {
      old: {
        version: 1,
        browserRunId: "run-old",
        sessionId: "old",
        phase: "cleanup_failed",
        container: { mode: "window", agentWindowId: 99 },
        agentCreatedTabIds: [100],
        borrowedTabs: [],
        createdAtMs: 1,
      },
    });
    const journal = new SessionResourceJournal({ local, session, randomId: () => "run-new" });

    expect(await journal.recoverable()).toEqual([]);
    expect(await journal.stale()).toEqual([
      expect.objectContaining({ sessionId: "old", browserRunId: "run-old" }),
    ]);
    await journal.pruneStale();
    expect(await journal.stale()).toEqual([]);
  });

  it("recovers across worker restarts but treats a missing session epoch as stale", async () => {
    const local = new MemoryStorage();
    const firstSession = new MemoryStorage();
    const beforeRestart = new SessionResourceJournal({
      local,
      session: firstSession,
      randomId: () => "run-a",
    });
    await beforeRestart.save(context("s1"));

    // MV3 worker suspension keeps storage.session, so a new journal instance
    // can safely recover the still-live numeric Chrome ids.
    const afterWorkerRestart = new SessionResourceJournal({
      local,
      session: firstSession,
      randomId: () => "unused",
    });
    expect((await afterWorkerRestart.recoverable()).map((record) => record.sessionId)).toEqual([
      "s1",
    ]);

    // Browser restart and extension reload/update both clear storage.session.
    // Even if storage.local still has an old diagnostic mirror from an
    // earlier version, it must never make old Chrome ids recoverable.
    local.values.set(BROWSER_RUN_ID_KEY, "run-a");
    const nextSession = new MemoryStorage();
    const afterReload = new SessionResourceJournal({
      local,
      session: nextSession,
      randomId: () => "run-b",
    });
    expect(await afterReload.recoverable()).toEqual([]);
    expect((await afterReload.stale()).map((record) => record.sessionId)).toEqual(["s1"]);
    expect(local.values.get(BROWSER_RUN_ID_KEY)).toBe("run-a");
    expect(nextSession.values.get(BROWSER_RUN_ID_KEY)).toBe("run-b");
  });

  it("recovers an existing-tab session after its original tab was returned", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const journal = new SessionResourceJournal({ local, session, randomId: () => "run-a" });
    const ctx = context("returned-root");
    ctx.remote = false;
    ctx.container = { mode: "existing_tab", hostWindowId: 10 };
    ctx.borrowedTabs.clear();

    await journal.save(ctx);
    expect(await journal.recoverable()).toEqual([
      expect.objectContaining({
        sessionId: "returned-root",
        container: { mode: "existing_tab", hostWindowId: 10 },
        agentCreatedTabIds: [21],
        borrowedTabs: [],
      }),
    ]);

    // Existing v1 records may still contain the removed mirror field.
    const saved = local.values.get(SESSION_RESOURCE_JOURNAL_KEY) as Record<
      string,
      { container: Record<string, unknown> }
    >;
    saved["returned-root"].container.rootTabId = 7;
    expect((await journal.recoverable()).map((record) => record.sessionId)).toEqual([
      "returned-root",
    ]);
  });

  it("ignores malformed ownership records rather than closing unchecked Chrome ids", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    session.values.set(BROWSER_RUN_ID_KEY, "run-a");
    local.values.set(SESSION_RESOURCE_JOURNAL_KEY, {
      bad: {
        version: 1,
        browserRunId: "run-a",
        sessionId: "bad",
        phase: "active",
        container: { mode: "window", agentWindowId: -1 },
        agentCreatedTabIds: [],
        borrowedTabs: [],
        createdAtMs: 1,
      },
    });

    const journal = new SessionResourceJournal({ local, session, randomId: () => "unused" });
    expect(await journal.recoverable()).toEqual([]);
  });

  it("serializes concurrent updates so one session cannot overwrite another", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const journal = new SessionResourceJournal({ local, session, randomId: () => "run-a" });

    await Promise.all([journal.save(context("a")), journal.save(context("b"))]);

    expect((await journal.recoverable()).map((record) => record.sessionId).sort()).toEqual([
      "a",
      "b",
    ]);
  });

  it("checkpoints a dedicated window before post-create initialization can be interrupted", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const journal = new SessionResourceJournal({ local, session, randomId: () => "run-a" });
    let finishInitialization!: (tabId: number) => void;
    const initialization = new Promise<number>((resolve) => {
      finishInitialization = resolve;
    });
    const manager = new SessionManager({
      journal,
      agentWindow: {
        create: async () => ({ windowId: 99, initialTabIds: [100] }),
        ensureActiveTab: async () => initialization,
        remove: async () => {},
      },
    });

    const start = manager.start("pending");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await journal.recoverable()).toEqual([
      expect.objectContaining({
        sessionId: "pending",
        container: { mode: "window", agentWindowId: 99 },
        agentCreatedTabIds: [100],
      }),
    ]);

    finishInitialization(100);
    await start;
  });

  it("keeps a healthy journal phase when shared stop is refused before cleanup", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const journal = new SessionResourceJournal({ local, session, randomId: () => "run-a" });
    const manager = new SessionManager({
      journal,
      sharedWindow: {
        host: async () => ({ id: 10, type: "normal" }) as chrome.windows.Window,
        create: async () => 20,
        get: async () => ({ id: 20, windowId: 10 }) as chrome.tabs.Tab,
        remove: async () => {},
      },
    });
    const ctx = await manager.start("busy", { inWindow: true });
    ctx.pendingOperations = 1;

    await expect(manager.stop("busy")).rejects.toThrow("pending tab operations");
    expect(ctx.stopping).toBeUndefined();
    expect(await journal.recoverable()).toEqual([
      expect.objectContaining({ sessionId: "busy", phase: "active" }),
    ]);
  });

  it("removes a recovered journal record when its Agent Window is already gone", async () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const journal = new SessionResourceJournal({ local, session, randomId: () => "run-a" });
    const manager = new SessionManager({
      journal,
      agentWindow: {
        create: async () => ({ windowId: 99, initialTabIds: [100] }),
        ensureActiveTab: async () => 100,
        remove: async () => {
          throw new Error("No window with id: 99.");
        },
      },
    });
    await manager.start("gone");
    expect(await journal.recoverable()).toHaveLength(1);

    await expect(manager.stop("gone")).resolves.toMatchObject({ sessionId: "gone" });
    expect(manager.has("gone")).toBe(false);
    expect(await journal.recoverable()).toEqual([]);
  });
});
