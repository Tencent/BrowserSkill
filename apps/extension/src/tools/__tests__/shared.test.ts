import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { lookupSession, parseBufferedReadBounds } from "../shared";

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

describe("parseBufferedReadBounds", () => {
  it("applies shared defaults and caps", () => {
    expect(parseBufferedReadBounds({})).toEqual({
      since: undefined,
      limit: 50,
      maxTextChars: 1000,
    });
    expect(parseBufferedReadBounds({ since: 12, limit: 500, max_text_chars: 9999 })).toEqual({
      since: 12,
      limit: 200,
      maxTextChars: 4096,
    });
  });

  it.each([
    [{ since: -1 }, "since"],
    [{ since: 1.5 }, "since"],
    [{ limit: 0 }, "limit"],
    [{ max_text_chars: 0 }, "max_text_chars"],
  ])("rejects invalid bounds in %o", (params, field) => {
    expect(parseBufferedReadBounds(params)).toMatchObject({
      code: "invalid_params",
      message: expect.stringContaining(field),
    });
  });
});
