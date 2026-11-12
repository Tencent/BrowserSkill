import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { CdpRunner } from "@/tools/shared";
import { CooperationController } from "./controller";
import { FrameCollectionError } from "./frame-error";
import type { CooperationFrames, FrameState } from "./types";

vi.mock("@/tools/observation", () => ({ captureVomObservation: vi.fn(), handleSnapshot: vi.fn() }));
vi.mock("@/tools/interaction", () => ({ resolveActionTarget: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
});

const frame: FrameState = {
  document: "doc-a",
  focusIsDocument: true,
  revision: 0,
  structure: 0,
  human: 0,
  busy: false,
  editing: false,
  lastInput: 0,
  fields: [],
  events: [],
};

/** Owned page 7 plus a borrowed user tab 9 whose collector cannot be installed. */
async function fixture(
  borrowedUrl: string,
  options: { pendingUrl?: string; failedFrameId?: number } = {},
) {
  const sessions = new SessionManager({
    agentWindow: {
      create: async () => ({ windowId: 100, initialTabIds: [7] }),
      remove: async () => {},
      ensureActiveTab: async () => 7,
    },
  });
  const ctx = await sessions.start("shared");
  const tabs: Record<number, chrome.tabs.Tab> = {
    7: { id: 7, windowId: 100, active: false, url: "https://fixture.test" } as chrome.tabs.Tab,
    9: {
      id: 9,
      windowId: 100,
      active: true,
      url: borrowedUrl,
      ...(options.pendingUrl ? { pendingUrl: options.pendingUrl } : {}),
    } as chrome.tabs.Tab,
  };
  vi.stubGlobal("chrome", {
    tabs: {
      get: async (id: number) => tabs[id],
      query: async () => Object.values(tabs),
    },
  });
  const readFrames = vi.fn(async (tabId: number): Promise<CooperationFrames> => {
    if (tabId === 9)
      throw new FrameCollectionError("frame_unobservable", [
        { frame_id: options.failedFrameId ?? 0, url: "about:" },
      ]);
    return { frames: new Map([[0, structuredClone(frame)]]), gaps: [] };
  });
  const cdp = { send: vi.fn(async () => ({})) } as unknown as CdpRunner;
  const controller = new CooperationController({
    sessions,
    readFrames: readFrames as never,
    resumeFrames: vi.fn(async () => {}),
    changed: vi.fn(),
    now: () => 10_000,
  });
  const signal = new AbortController().signal;
  await controller.run(
    { id: "start", method: "tool.session_start", params: { session_id: "shared" } },
    cdp,
    signal,
    async () => ({ agent_window_id: 100 }),
  );
  expect(
    await controller.run(
      { id: "borrow", method: "tool.tab_borrow", params: { session_id: "shared", tab_id: 9 } },
      cdp,
      signal,
      async () => {
        ctx.borrowedTabs.set(9, { tabId: 9, originalWindowId: 1, originalIndex: 0 });
        return { tab_id: 9 };
      },
    ),
  ).toEqual({ tab_id: 9 });
  const manage = async (method: string, tabId: number) => {
    const invoke = vi.fn(async () => ({ tab_id: tabId }));
    const result = await controller.run(
      { id: method, method, params: { session_id: "shared", tab_id: tabId } },
      cdp,
      signal,
      invoke,
    );
    return { result, invoked: invoke.mock.calls.length };
  };
  return { manage, readFrames };
}

it.each([
  "about:blank",
  "about:newtab",
  "chrome://newtab/",
  "edge://newtab/",
])("keeps tab management available after borrowing an unobservable %s tab", async (url) => {
  const f = await fixture(url);
  expect(await f.manage("tool.tab_select", 7)).toEqual({ result: { tab_id: 7 }, invoked: 1 });
  expect(await f.manage("tool.tab_create", 11)).toEqual({ result: { tab_id: 11 }, invoked: 1 });
  expect(await f.manage("tool.tab_return", 9)).toEqual({ result: { tab_id: 9 }, invoked: 1 });
  // Pages with a collector are still prepared before every tab operation.
  expect(f.readFrames).toHaveBeenCalledWith(
    7,
    undefined,
    expect.any(String),
    expect.anything(),
    expect.anything(),
  );
});

it("still refuses tab management when an about:blank tab is navigating to a real page", async () => {
  const f = await fixture("about:blank", { pendingUrl: "https://user.test/form" });
  const { result, invoked } = await f.manage("tool.tab_return", 9);
  expect(invoked).toBe(0);
  expect(result).toMatchObject({ code: "permission_denied" });
});

it("still refuses tab management when a child frame on an about:blank document is unobservable", async () => {
  const f = await fixture("about:blank", { failedFrameId: 2 });
  const { result, invoked } = await f.manage("tool.tab_return", 9);
  expect(invoked).toBe(0);
  expect(result).toMatchObject({ code: "permission_denied" });
});

it("still refuses tab management when a non-blank tab cannot be observed", async () => {
  const f = await fixture("https://user.test/form");
  const { result, invoked } = await f.manage("tool.tab_return", 9);
  expect(invoked).toBe(0);
  expect(result).toMatchObject({ code: "permission_denied" });
});
