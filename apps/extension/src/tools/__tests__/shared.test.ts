import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { lookupSession, resolveTargetTab } from "../shared";

function fakeAgentWindow() {
  return {
    create: vi.fn(async () => 100),
    remove: vi.fn(async () => {}),
    ensureActiveTab: vi.fn(async () => {}),
  };
}

describe("lookupSession", () => {
  it("returns invalid_params when session_id is missing or not a string", () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
    expect(lookupSession(sm, {}, "tool.test")).toMatchObject({
      code: "invalid_params",
      message: "tool.test requires session_id",
    });
    expect(lookupSession(sm, { session_id: "" }, "tool.test")).toMatchObject({
      code: "invalid_params",
    });
    expect(lookupSession(sm, { session_id: 42 as unknown as string }, "tool.test")).toMatchObject({
      code: "invalid_params",
    });
  });

  it("returns not_found for unknown session_id", () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
    expect(lookupSession(sm, { session_id: "zzzz" }, "tool.test")).toMatchObject({
      code: "not_found",
      message: "session zzzz unknown",
    });
  });

  it("returns SessionContext when the session exists", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
    const ctx = await sm.start("aa11");
    const result = lookupSession(sm, { session_id: "aa11" }, "tool.test");
    expect(result).toBe(ctx);
  });
});

describe("resolveTargetTab", () => {
  it("requires a user tab to be borrowed into the Agent Window before access", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
    const ctx = await sm.start("aa11");

    const result = await resolveTargetTab(sm, ctx, 9, {
      get: vi.fn(async () => ({ id: 9, windowId: 200, active: true }) as chrome.tabs.Tab),
      query: vi.fn(),
    });

    expect(result).toMatchObject({
      code: "permission_denied",
      data: { reason: "agent_window_scope" },
    });
  });

  it("allows an explicit tab in the current session's Agent Window", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
    const ctx = await sm.start("aa11");

    await expect(
      resolveTargetTab(sm, ctx, 9, {
        get: vi.fn(async () => ({ id: 9, windowId: 100, active: true }) as chrome.tabs.Tab),
        query: vi.fn(),
      }),
    ).resolves.toEqual({ tabId: 9, windowId: 100, active: true });
  });
});
