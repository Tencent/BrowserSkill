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
  options: {
    pendingUrl?: string;
    failedFrameId?: number;
    failureReason?: "frame_unobservable" | "page_load_failed";
    observableBorrowed?: boolean;
  } = {},
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
  let borrowedObservable = options.observableBorrowed ?? false;
  const readFrames = vi.fn(async (tabId: number): Promise<CooperationFrames> => {
    if (tabId === 9 && !borrowedObservable)
      throw new FrameCollectionError(options.failureReason ?? "frame_unobservable", [
        { frame_id: options.failedFrameId ?? 0, url: borrowedUrl || "about:" },
      ]);
    return { frames: new Map([[0, structuredClone(frame)]]), gaps: [] };
  });
  const send = vi.fn(async () => ({}));
  const cdp = {
    send,
    runBrowserMutation: async <T>(op: () => Promise<T>) => op(),
  } as unknown as CdpRunner;
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
  return {
    manage,
    readFrames,
    send,
    tabs,
    controller,
    cdp,
    signal,
    setBorrowedObservable: (next: boolean) => {
      borrowedObservable = next;
    },
  };
}

it.each([
  "about:blank",
  "about:blank#section",
  "about:blank?from=popup#section",
  "about:newtab",
  "chrome://newtab/",
  "chrome://newtab?espv=2",
  "chrome://new-tab-page/",
  "edge://newtab",
  "brave://newtab/",
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

it.each([
  "about:blank",
  "about:blank#section",
  "chrome://newtab/",
])("allows bootstrap navigation out of an unobservable borrowed %s tab once", async (url) => {
  const f = await fixture(url);
  expect(
    await f.controller.run(
      {
        id: "navigate-expect",
        method: "tool.navigate",
        params: {
          session_id: "shared",
          tab_id: 9,
          expect: [{ target: "#ready", field: "exists", equals: true }],
        },
      },
      f.cdp,
      f.signal,
      async () => ({ tab_id: 9 }),
    ),
  ).toMatchObject({
    code: "invalid_params",
    data: { phase: "precondition", effect_state: "none" },
  });

  const navResult = await f.controller.run(
    { id: "navigate", method: "tool.navigate", params: { session_id: "shared", tab_id: 9 } },
    f.cdp,
    f.signal,
    async (runner) => {
      if (url.startsWith("chrome://")) {
        await runner.runBrowserMutation!(async () => {
          f.tabs[9]!.url = "https://fixture.test/landed";
          f.setBorrowedObservable(true);
        });
      } else {
        await runner.send(9, "Page.navigate", { url: "https://fixture.test/landed" });
        f.tabs[9]!.url = "https://fixture.test/landed";
        f.setBorrowedObservable(true);
      }
      return { tab_id: 9, final_url: "https://fixture.test/landed" };
    },
  );
  expect(navResult).toEqual({ tab_id: 9, final_url: "https://fixture.test/landed" });

  // Once the borrowed tab reaches an observable web page, a context is required.
  expect(
    await f.controller.run(
      {
        id: "navigate-again",
        method: "tool.navigate",
        params: { session_id: "shared", tab_id: 9 },
      },
      f.cdp,
      f.signal,
      async (runner) => runner.send(9, "Page.navigate", { url: "https://fixture.test/next" }),
    ),
  ).toMatchObject({
    code: "permission_denied",
    data: { reason: "cooperation_sync_required", effect_state: "none" },
  });
});

it("still requires synchronization when a borrowed about:blank popup has an active collector", async () => {
  const f = await fixture("about:blank", { observableBorrowed: true });
  expect(
    await f.controller.run(
      { id: "navigate", method: "tool.navigate", params: { session_id: "shared", tab_id: 9 } },
      f.cdp,
      f.signal,
      async (runner) => runner.send(9, "Page.navigate", { url: "https://fixture.test/overwrite" }),
    ),
  ).toMatchObject({
    code: "permission_denied",
    data: { reason: "cooperation_sync_required", effect_state: "none" },
  });
  expect(f.send).not.toHaveBeenCalled();
});

it.each([
  { url: "chrome://settings/", reason: "frame_unobservable" as const },
  { url: "https://unreachable.invalid/", reason: "page_load_failed" as const },
])("allows returning a borrowed tab stuck on $url ($reason) while refusing other tab switches", async ({
  url,
  reason,
}) => {
  const f = await fixture(url, { failureReason: reason });
  expect(await f.manage("tool.tab_select", 7)).toMatchObject({
    invoked: 0,
    result: { code: "permission_denied" },
  });
  expect(await f.manage("tool.tab_return", 9)).toEqual({ result: { tab_id: 9 }, invoked: 1 });
});

it("still refuses tab_return when a page_load_failed borrowed tab has an in-flight pendingUrl", async () => {
  const f = await fixture("https://unreachable.invalid/", {
    failureReason: "page_load_failed",
    pendingUrl: "https://user.test/retry",
  });
  const { result, invoked } = await f.manage("tool.tab_return", 9);
  expect(invoked).toBe(0);
  expect(result).toMatchObject({ code: "permission_denied" });
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
