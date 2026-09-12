import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import {
  cdpBlockedUrlReason,
  enforceCdpAccessibleTarget,
  lookupSession,
  parseBufferedReadBounds,
  resolveCdpAccessibleTargetTab,
} from "../shared";

function fakeAgentWindow() {
  return {
    create: vi.fn(async () => 100),
    remove: vi.fn(async () => {}),
    ensureActiveTab: vi.fn(async () => 1),
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

describe("CDP target URL guard", () => {
  it("allows ordinary pages and about:blank", () => {
    expect(cdpBlockedUrlReason("https://example.test/path")).toBeNull();
    expect(cdpBlockedUrlReason("http://example.test/path")).toBeNull();
    expect(cdpBlockedUrlReason("about:blank")).toBeNull();
  });

  it("blocks browser and extension internal pages", () => {
    expect(cdpBlockedUrlReason("chrome-extension://abc/options.html")).toBe("chrome-extension:");
    expect(cdpBlockedUrlReason("chrome://extensions")).toBe("chrome:");
    expect(cdpBlockedUrlReason("about:newtab")).toBe("about:");
  });

  it("returns a structured permission error before page CDP access", () => {
    expect(
      enforceCdpAccessibleTarget(
        {
          tabId: 7,
          windowId: 100,
          active: true,
          url: "chrome-extension://other-extension/page.html",
        },
        "snapshot",
      ),
    ).toMatchObject({
      code: "permission_denied",
      data: { reason: "restricted_tab_url" },
      message: expect.stringContaining("snapshot cannot access tab 7"),
    });
  });

  it("falls back from a restricted default active tab to an accessible agent tab", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
    const ctx = await sm.start("aa11");
    const tabsApi = {
      get: vi.fn(),
      query: vi.fn(async (query: chrome.tabs.QueryInfo) => {
        if (query.active) {
          return [
            {
              id: 7,
              windowId: ctx.agentWindowId,
              active: true,
              url: "chrome-extension://other-extension/page.html",
            } as chrome.tabs.Tab,
          ];
        }
        return [
          {
            id: 7,
            windowId: ctx.agentWindowId,
            active: true,
            url: "chrome-extension://other-extension/page.html",
          } as chrome.tabs.Tab,
          {
            id: 8,
            windowId: ctx.agentWindowId,
            active: false,
            url: "https://example.test/",
          } as chrome.tabs.Tab,
        ];
      }),
    };

    await expect(
      resolveCdpAccessibleTargetTab(sm, ctx, undefined, tabsApi, "snapshot"),
    ).resolves.toMatchObject({
      tabId: 8,
      url: "https://example.test/",
    });
  });

  it("does not replace an explicitly requested restricted tab", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow() });
    const ctx = await sm.start("aa11");
    const tabsApi = {
      get: vi.fn(
        async () =>
          ({
            id: 7,
            windowId: ctx.agentWindowId,
            active: true,
            url: "chrome-extension://other-extension/page.html",
          }) as chrome.tabs.Tab,
      ),
      query: vi.fn(),
    };

    await expect(
      resolveCdpAccessibleTargetTab(sm, ctx, 7, tabsApi, "snapshot"),
    ).resolves.toMatchObject({
      code: "permission_denied",
      data: { reason: "restricted_tab_url" },
    });
    expect(tabsApi.query).not.toHaveBeenCalled();
  });
});
