import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpDebuggee } from "@/browser-driver/chromium-cdp";
import { SessionManager } from "@/session-manager/manager";
import { handleDebug, validateDebugParams } from "@/tools/debug";
import { DebugManager } from "../manager";
import type { DebugParams } from "../types";

async function fixture() {
  let window = 100;
  const sessions = new SessionManager({
    agentWindow: {
      create: async () => window++,
      remove: async () => {},
      ensureActiveTab: async () => 7,
    },
  });
  const context = await sessions.start("s1");
  context.agentCreatedTabs.add(7);
  let now = 10_000;
  let listener: ((source: CdpDebuggee, method: string, params: unknown) => void) | undefined;
  const dispose = vi.fn(() => {
    listener = undefined;
  });
  const sendAttached = vi.fn(async (_target: CdpDebuggee, method: string) =>
    method === "Accessibility.getFullAXTree"
      ? {
          nodes: [
            { role: { value: "StaticText" }, name: { value: "Save failed" } },
            { role: { value: "textbox" }, name: { value: "not retained" } },
          ],
        }
      : method === "Network.getResponseBody"
        ? { body: '{"ok":false}' }
        : {},
  );
  const cdp = {
    send: vi.fn(),
    sendAttached: sendAttached as never,
    ensureNetworkCapture: vi.fn(async () => {}),
    onEvent: vi.fn((fn: typeof listener) => {
      listener = fn;
      return { dispose };
    }),
  };
  const tabs = {
    get: vi.fn(
      async (id: number) =>
        ({
          id,
          windowId: 100,
          active: true,
          title: "App",
          url: "https://site.test",
        }) as chrome.tabs.Tab,
    ),
    query: vi.fn(async () => [{ id: 7, windowId: 100, active: true }] as chrome.tabs.Tab[]),
  };
  const manager = new DebugManager(sessions, cdp, tabs, () => now);
  const event = (method: string, data: object, tabId = 7) => listener?.({ tabId }, method, data);
  const request = (id: string) =>
    event("Network.requestWillBeSent", {
      requestId: id,
      request: { url: `https://site.test/${id}`, method: "GET" },
    });
  return {
    manager,
    sessions,
    context,
    cdp,
    sendAttached,
    tabs,
    dispose,
    event,
    request,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const active: DebugManager[] = [];
afterEach(() => {
  for (const manager of active.splice(0)) manager.dispose();
  vi.useRealTimers();
});

describe("task-scoped debug lifecycle", () => {
  it("refuses capture outside the Agent Window and clears evidence on a manual tab move", async () => {
    const f = await fixture();
    active.push(f.manager);
    f.tabs.get.mockResolvedValueOnce({ id: 7, windowId: 999 } as chrome.tabs.Tab);
    expect(
      await handleDebug(
        f.sessions,
        { action: "start", session_id: "s1", tab_id: 7 },
        f.manager,
        f.tabs,
      ),
    ).toMatchObject({ code: "permission_denied" });
    expect(f.cdp.ensureNetworkCapture).not.toHaveBeenCalled();
    await f.manager.start("s1", 7);
    f.request("one");
    f.manager.releaseTab(7);
    expect((await f.manager.read({ action: "status", session_id: "s1" })).runs).toEqual([]);
    expect(f.dispose).toHaveBeenCalledTimes(1);
  });

  it("adds no CDP listeners, reads or page observations before explicit start", async () => {
    const f = await fixture();
    active.push(f.manager);
    expect(
      await f.manager.before({
        id: "r1",
        method: "tool.click",
        params: { session_id: "s1", selector: "#save" },
      }),
    ).toBeUndefined();
    expect(f.cdp.onEvent).not.toHaveBeenCalled();
    expect(f.cdp.sendAttached).not.toHaveBeenCalled();
    expect(f.tabs.query).not.toHaveBeenCalled();
  });
  it("requires task ownership even in local mode and isolates evidence between sessions", async () => {
    const f = await fixture();
    active.push(f.manager);
    expect(
      await handleDebug(
        f.sessions,
        { action: "start", session_id: "s1", tab_id: 8 },
        f.manager,
        f.tabs,
      ),
    ).toMatchObject({ code: "permission_denied" });
    await f.manager.start("s1", 7);
    f.request("one");
    await f.sessions.start("s2");
    expect((await f.manager.read({ action: "status", session_id: "s2" })).runs).toEqual([]);
    const id = (await f.manager.read({ action: "requests", session_id: "s1" })).requests![0].id;
    await expect(f.manager.read({ action: "request", session_id: "s2", id })).rejects.toThrow(
      "not found",
    );
  });
  it("records before/after page state and correlates async evidence within a bounded action window", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    active.push(f.manager);
    const run = await f.manager.start("s1", 7);
    f.request("background-before");
    f.advance(10);
    const ticket = await f.manager.before({
      id: "r1",
      method: "tool.click",
      params: { session_id: "s1", selector: "#save" },
    });
    f.advance(10);
    f.manager.after(ticket);
    f.advance(500);
    f.request("save");
    f.event("Runtime.consoleAPICalled", {
      type: "error",
      args: [{ type: "string", value: "Save failed" }],
      timestamp: 10_520,
    });
    await vi.advanceTimersByTimeAsync(1500);
    f.advance(1600);
    f.request("background-after");
    const list = await f.manager.read({ action: "operations", session_id: "s1", run_id: run.id });
    expect(list.operations).toHaveLength(1);
    expect(list.operations![0].before).toBeUndefined();
    const result = await f.manager.read({
      action: "operation",
      session_id: "s1",
      id: list.operations![0].id,
    });
    expect(result.requests?.map((request) => request.url)).toEqual(["https://site.test/save"]);
    expect(result.console).toHaveLength(1);
    expect(result.operation?.before?.text).toBe("Save failed");
    expect(result.operation?.after?.state).toBe("available");
    const calls = f.sendAttached.mock.calls.length;
    await f.manager.read({ action: "operation", session_id: "s1", id: list.operations![0].id });
    expect(f.cdp.sendAttached).toHaveBeenCalledTimes(calls);
  });
  it("closes the previous observation window when the next action begins", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    active.push(f.manager);
    await f.manager.start("s1", 7);
    const first = await f.manager.before({
      id: "r1",
      method: "tool.click",
      params: { session_id: "s1", selector: "#save" },
    });
    f.manager.after(first);
    f.advance(100);
    const second = await f.manager.before({
      id: "r2",
      method: "tool.click",
      params: { session_id: "s1", selector: "#save" },
    });
    f.manager.after(second);
    f.advance(1);
    f.request("second");
    const result = await f.manager.read({
      action: "compare",
      session_id: "s1",
      before: first!.operation.id,
      after: second!.operation.id,
    });
    expect(result.comparison?.before_requests).toHaveLength(0);
    expect(result.comparison?.after_requests).toHaveLength(1);
    expect(result.comparison?.before.after?.state).toBe("available");
    expect(result.comparison?.same_target).toBe(true);
    expect(result.comparison).not.toHaveProperty("fixed");
  });
  it("retains stopped evidence, releases listeners, and removes data when tabs are returned", async () => {
    const f = await fixture();
    active.push(f.manager);
    await f.manager.start("s1", 7);
    f.request("pending");
    await f.manager.read({ action: "stop", session_id: "s1" });
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(
      (await f.manager.read({ action: "requests", session_id: "s1" })).requests![0].state,
    ).toBe("interrupted");
    f.context.agentCreatedTabs.delete(7);
    f.manager.sync();
    expect((await f.manager.read({ action: "status", session_id: "s1" })).runs).toEqual([]);
  });
  it("limits retained runs, evicting stopped captures before admitting new ones", async () => {
    const f = await fixture();
    active.push(f.manager);
    for (let i = 0; i < 8; i++) {
      await f.manager.start("s1", 7);
      await f.manager.read({ action: "stop", session_id: "s1" });
    }
    expect((await f.manager.read({ action: "status", session_id: "s1" })).runs).toHaveLength(4);
    f.manager.releaseSession("s1");
    expect((await f.manager.read({ action: "status", session_id: "s1" })).runs).toEqual([]);
  });
  it("does not resume capture if it is stopped while starting", async () => {
    const f = await fixture();
    active.push(f.manager);
    let resolve!: () => void;
    f.cdp.ensureNetworkCapture.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const starting = f.manager.start("s1", 7);
    await expect(f.manager.start("s1", 7)).rejects.toThrow("already starting");
    await Promise.resolve();
    f.manager.stopTab(7, "requested");
    resolve();
    expect((await starting).state).toBe("stopped");
    expect(f.cdp.sendAttached).not.toHaveBeenCalled();
  });
  it("cleans up failed starts and ignores evidence from unrelated tabs and replayed console messages", async () => {
    const f = await fixture();
    active.push(f.manager);
    f.cdp.ensureNetworkCapture.mockRejectedValueOnce(new Error("detached"));
    await expect(f.manager.start("s1", 7)).rejects.toThrow("detached");
    expect(f.dispose).toHaveBeenCalledTimes(1);
    await f.manager.start("s1", 7);
    f.event(
      "Network.requestWillBeSent",
      { requestId: "foreign", request: { url: "https://other.test" } },
      8,
    );
    f.event("Runtime.consoleAPICalled", {
      type: "error",
      args: [{ type: "string", value: "old" }],
      timestamp: 1,
    });
    const result = await f.manager.read({ action: "status", session_id: "s1" });
    expect(result.runs![0]).toMatchObject({ requests: 0, errors: 0 });
  });
  it("rejects invalid limits and selectors before touching browser state", () => {
    for (const params of [
      { action: "request" },
      { action: "compare", before: "a" },
      { action: "requests", limit: 101 },
      { action: "requests", since: -1 },
      { action: "request", id: "n1", part: "headers", pointer: "/x" },
    ])
      expect(validateDebugParams({ session_id: "s1", ...params } as DebugParams)).toBeTruthy();
  });
});
