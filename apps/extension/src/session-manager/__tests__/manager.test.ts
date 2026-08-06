import { describe, expect, it, vi } from "vitest";
import type { AgentWindowApi } from "../agent-window";
import { SessionManager } from "../manager";

function fakeAgentWindow(): AgentWindowApi & {
  createMock: ReturnType<typeof vi.fn>;
  removeMock: ReturnType<typeof vi.fn>;
  ensureActiveTabMock: ReturnType<typeof vi.fn>;
} {
  let nextId = 100;
  const createMock = vi.fn(async (_url: string) => {
    const id = nextId++;
    return id;
  });
  const removeMock = vi.fn(async (_id: number) => {});
  const ensureActiveTabMock = vi.fn(async (_windowId: number, _url: string) => 0);
  return {
    create: createMock,
    remove: removeMock,
    ensureActiveTab: ensureActiveTabMock,
    createMock,
    removeMock,
    ensureActiveTabMock,
  };
}

describe("SessionManager", () => {
  it("creates an Agent Window when starting a session", async () => {
    const aw = fakeAgentWindow();
    const sm = new SessionManager({ agentWindow: aw, now: () => 1700000000000 });
    const ctx = await sm.start("aa11");
    expect(aw.createMock).toHaveBeenCalledOnce();
    expect(aw.createMock).toHaveBeenCalledWith("about:blank");
    expect(aw.ensureActiveTabMock).toHaveBeenCalledOnce();
    expect(aw.ensureActiveTabMock).toHaveBeenCalledWith(100, "about:blank");
    expect(ctx.sessionId).toBe("aa11");
    expect(ctx.agentWindowId).toBe(100);
    expect(ctx.createdAtMs).toBe(1700000000000);
    expect(ctx.refStore.isEmpty()).toBe(true);
    expect(ctx.borrowedTabs.size).toBe(0);
  });

  it("indexes the session by sessionId and agent window id", async () => {
    const aw = fakeAgentWindow();
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");
    expect(sm.has("aa11")).toBe(true);
    expect(sm.get("aa11")).toBe(ctx);
    expect(sm.findByWindowId(ctx.agentWindowId)).toBe(ctx);
    expect(sm.findByWindowId(99999)).toBeNull();
    expect(sm.list().length).toBe(1);
  });

  it("rejects starting the same session twice", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
    await sm.start("aa11");
    await expect(sm.start("aa11")).rejects.toThrow(/already exists/);
  });

  it("stop() closes the Agent Window and forgets the session", async () => {
    const aw = fakeAgentWindow();
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");
    const removed = await sm.stop("aa11");
    expect(removed).toBe(ctx);
    expect(aw.removeMock).toHaveBeenCalledWith(ctx.agentWindowId);
    expect(sm.has("aa11")).toBe(false);
    expect(sm.findByWindowId(ctx.agentWindowId)).toBeNull();
  });

  it("stop({ dropOnly: true }) skips the chrome.windows.remove call", async () => {
    const aw = fakeAgentWindow();
    const sm = new SessionManager({ agentWindow: aw });
    await sm.start("aa11");
    await sm.stop("aa11", { dropOnly: true });
    expect(aw.removeMock).not.toHaveBeenCalled();
    expect(sm.has("aa11")).toBe(false);
  });

  it("stopAll() drops every session and returns their ids", async () => {
    const aw = fakeAgentWindow();
    const sm = new SessionManager({ agentWindow: aw });
    await sm.start("aa11");
    await sm.start("bb22");
    const dropped = await sm.stopAll();
    expect(dropped.sort()).toEqual(["aa11", "bb22"]);
    expect(sm.list()).toEqual([]);
  });

  describe("classifyNewTab (user vs agent tab freedom)", () => {
    it("classifies a tab born during window init as agent (home tab)", async () => {
      const aw = fakeAgentWindow();
      const sm = new SessionManager({ agentWindow: aw });
      const ctx = await sm.start("aa11");
      // Simulate the onCreated event for the home tab while still initializing.
      // (start() already clears the flag, so re-add to emulate the race.)
      (sm as unknown as { windowInitializing: Set<number> }).windowInitializing.add(
        ctx.agentWindowId,
      );
      const kind = sm.classifyNewTab(0, ctx.agentWindowId);
      expect(kind).toBe("initializing");
      expect(ctx.agentCreatedTabs.has(0)).toBe(true);
      expect(ctx.userTabs.has(0)).toBe(false);
    });

    it("classifies a pending tab_create tab as agent", async () => {
      const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
      const ctx = await sm.start("aa11");
      sm.markAgentTabPending(ctx.agentWindowId);
      const kind = sm.classifyNewTab(11, ctx.agentWindowId);
      expect(kind).toBe("agent");
      expect(ctx.agentCreatedTabs.has(11)).toBe(true);
      expect(ctx.userTabs.has(11)).toBe(false);
      expect(ctx.pendingAgentTabCount).toBe(0);
    });

    it("classifies a user-opened tab (no pending) as user and keeps it free", async () => {
      const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
      const ctx = await sm.start("aa11");
      const kind = sm.classifyNewTab(99, ctx.agentWindowId);
      expect(kind).toBe("user");
      expect(ctx.userTabs.has(99)).toBe(true);
      expect(ctx.agentCreatedTabs.has(99)).toBe(false);
    });

    it("matches multiple pending agent tabs to multiple onCreated events", async () => {
      const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
      const ctx = await sm.start("aa11");
      sm.markAgentTabPending(ctx.agentWindowId);
      sm.markAgentTabPending(ctx.agentWindowId);
      expect(sm.classifyNewTab(11, ctx.agentWindowId)).toBe("agent");
      // Second agent tab still pending → agent; not mistaken for user.
      expect(sm.classifyNewTab(12, ctx.agentWindowId)).toBe("agent");
      // No more pending → a later user tab is user.
      expect(sm.classifyNewTab(99, ctx.agentWindowId)).toBe("user");
    });
  });

  describe("findBorrowingSession", () => {
    it("returns null when no session has borrowed the tab", async () => {
      const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
      await sm.start("aa11");
      expect(sm.findBorrowingSession(42, "aa11")).toBeNull();
      expect(sm.findBorrowingSession(42, null)).toBeNull();
    });

    it("ignores borrows held by the calling session itself", async () => {
      const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
      const ctx = await sm.start("aa11");
      ctx.borrowedTabs.set(42, { tabId: 42, originalWindowId: 7, originalIndex: 3 });
      expect(sm.findBorrowingSession(42, "aa11")).toBeNull();
    });

    it("reports the borrowing session id when a different session holds the tab", async () => {
      const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
      const a = await sm.start("aa11");
      await sm.start("bb22");
      a.borrowedTabs.set(42, { tabId: 42, originalWindowId: 7, originalIndex: 3 });
      expect(sm.findBorrowingSession(42, "bb22")).toBe("aa11");
      // currentSessionId=null asks "is anyone borrowing this tab?"
      expect(sm.findBorrowingSession(42, null)).toBe("aa11");
    });
  });
});
