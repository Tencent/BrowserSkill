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
  const ensureActiveTabMock = vi.fn(async (_windowId: number, _url: string) => {});
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
