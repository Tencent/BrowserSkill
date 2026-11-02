import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { WaitUntil } from "@/transport/types";
import {
  handleNavigate,
  handleNavigateBack,
  handleNavigateForward,
  handleReload,
} from "../navigation";
import type { CdpRunner } from "../shared";

const destination = "https://example.test/page#two";
type Listener = Parameters<NonNullable<CdpRunner["onEvent"]>>[0];
type Operation = "navigate" | "back" | "forward" | "reload";

async function fixture() {
  const manager = new SessionManager({
    agentWindow: {
      create: async () => ({ windowId: 100, initialTabIds: [4] }),
      ensureActiveTab: async () => 4,
      remove: async () => {},
    },
  });
  await manager.start("task");
  const listeners = new Set<Listener>();
  const state = {
    loader: "original",
    navigateLoader: undefined as string | undefined,
    readyState: "complete",
    replay: ["commit", "DOMContentLoaded", "load", "networkIdle"],
    action: () => {},
  };
  const fire = (method: string, params: object, tabId = 4) => {
    for (const listener of [...listeners]) listener({ tabId }, method, params);
  };
  const sameDocument = (url = destination, frameId = "main") =>
    fire("Page.navigatedWithinDocument", { frameId, url, navigationType: "fragment" });
  const lifecycle = (name: string, loaderId = state.loader, frameId = "main") =>
    fire("Page.lifecycleEvent", { name, frameId, loaderId });
  const send = vi.fn(async (_tabId: number, method: string) => {
    if (method === "Runtime.evaluate") return { result: { value: state.readyState } };
    if (method === "Page.getFrameTree")
      return { frameTree: { frame: { id: "main", loaderId: state.loader } } };
    if (method === "Page.getNavigationHistory")
      return {
        currentIndex: 1,
        entries: [
          { id: 1, url: destination },
          { id: 2, url: "https://example.test/page#one" },
          { id: 3, url: destination },
        ],
      };
    if (["Page.navigate", "Page.navigateToHistoryEntry", "Page.reload"].includes(method)) {
      state.action();
      return { frameId: "main", loaderId: state.navigateLoader };
    }
    if (method === "Page.setLifecycleEventsEnabled")
      for (const name of state.replay) lifecycle(name);
    return {};
  });
  const cdp: CdpRunner = {
    send: send as CdpRunner["send"],
    onEvent: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  const tab = { id: 4, windowId: 100, active: true, url: destination } as chrome.tabs.Tab;
  const run = (operation: Operation, wait_until: WaitUntil, signal?: AbortSignal) => {
    const deps = {
      cdp,
      tabsApi: { get: async () => tab, query: async () => [tab] },
      defaultTimeoutMs: 100,
      signal,
    };
    const params = { session_id: "task", wait_until };
    switch (operation) {
      case "navigate":
        return handleNavigate(manager, { ...params, url: destination }, deps);
      case "back":
        return handleNavigateBack(manager, params, deps);
      case "forward":
        return handleNavigateForward(manager, params, deps);
      case "reload":
        return handleReload(manager, params, deps);
    }
  };
  return { state, run, fire, sameDocument, lifecycle, send, listeners };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("same-document navigation", () => {
  it.each(
    (["navigate", "back", "forward"] as const).flatMap((operation) =>
      (["commit", "domcontentloaded", "load", "networkidle"] as const).flatMap((phase) =>
        [false, true].map((late) => ({ operation, phase, late })),
      ),
    ),
  )("reuses the document for $operation/$phase (event after reply: $late)", async ({
    operation,
    phase,
    late,
  }) => {
    const f = await fixture();
    f.state.action = () => {
      if (late) setTimeout(() => f.sameDocument(), 1);
      else f.sameDocument();
    };
    const work = f.run(operation, phase);
    await vi.advanceTimersByTimeAsync(2);
    expect(await work).toMatchObject({ reached: phase });
    expect(f.listeners.size).toBe(0);
  });

  it.each([
    "wrong-url",
    "child-frame",
    "different-tab",
    "no-event",
  ])("does not accept %s as navigation completion", async (kind) => {
    const f = await fixture();
    f.state.action = () => {
      if (kind === "wrong-url") f.sameDocument("https://example.test/page#unrelated");
      if (kind === "child-frame") f.sameDocument(destination, "child");
      if (kind === "different-tab")
        f.fire("Page.navigatedWithinDocument", { frameId: "main", url: destination }, 9);
    };
    const work = f.run("navigate", "load");
    await vi.advanceTimersByTimeAsync(100);
    expect(await work).toMatchObject({ reached: "timeout" });
    expect(f.listeners.size).toBe(0);
  });

  it("keeps waiting for real network-idle evidence on the retained loader", async () => {
    const f = await fixture();
    f.state.replay = ["commit", "DOMContentLoaded", "load"];
    f.state.action = () => f.sameDocument();
    let settled = false;
    const work = f.run("navigate", "networkidle").then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    f.lifecycle("networkIdle", "other-loader");
    f.lifecycle("networkIdle", "original", "child");
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    f.lifecycle("networkIdle");
    expect(await work).toMatchObject({ reached: "networkidle" });
  });

  it("does not accept a same-document event when navigate reports a new loader", async () => {
    const f = await fixture();
    f.state.navigateLoader = "new-loader";
    f.state.action = () => f.sameDocument();
    const work = f.run("navigate", "load");
    await vi.advanceTimersByTimeAsync(100);
    expect(await work).toMatchObject({ reached: "timeout" });
  });

  it("does not let an unrelated URL change complete a reload", async () => {
    const f = await fixture();
    f.state.action = () => f.sameDocument();
    const work = f.run("reload", "load");
    await vi.advanceTimersByTimeAsync(100);
    expect(await work).toMatchObject({ reached: "timeout" });
  });

  it("follows a cross-document successor after a same-document navigation", async () => {
    const f = await fixture();
    f.state.replay = [];
    f.state.action = () => f.sameDocument();
    const work = f.run("navigate", "networkidle");
    let settled = false;
    void work.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1);
    f.fire("Page.frameRequestedNavigation", { frameId: "main", disposition: "currentTab" });
    f.state.loader = "successor";
    f.fire("Page.frameNavigated", { frame: { id: "main", loaderId: "successor" } });
    f.lifecycle("networkIdle", "original");
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    f.lifecycle("networkIdle");
    expect(await work).toMatchObject({ reached: "networkidle" });
  });

  it.each([
    "request-intent",
    "network-request",
  ])("does not revive a same-document event superseded by %s before navigate replies", async (cause) => {
    const f = await fixture();
    f.state.action = () => {
      f.sameDocument();
      if (cause === "request-intent") {
        f.fire("Page.frameRequestedNavigation", { frameId: "main", disposition: "currentTab" });
      } else {
        f.fire("Network.requestWillBeSent", {
          frameId: "main",
          loaderId: "successor",
          type: "Document",
          requestId: "next",
        });
      }
    };
    const work = f.run("navigate", "load");
    await vi.advanceTimersByTimeAsync(100);
    expect(await work).toMatchObject({ reached: "timeout" });
  });

  it("cancels a retained-document wait and removes its event listener", async () => {
    const f = await fixture();
    const abort = new AbortController();
    f.state.replay = [];
    f.state.action = () => f.sameDocument();
    const work = f.run("navigate", "networkidle", abort.signal);
    await vi.advanceTimersByTimeAsync(1);
    abort.abort();
    expect(await work).toMatchObject({ code: "cancelled" });
    expect(f.listeners.size).toBe(0);
  });
});
