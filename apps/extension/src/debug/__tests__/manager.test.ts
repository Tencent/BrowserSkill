import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpDebuggee } from "@/browser-driver/chromium-cdp";
import { SessionManager } from "@/session-manager/manager";
import { handleDebug, validateDebugParams } from "@/tools/debug";
import type { DebugArchive } from "../archive";
import { DebugManager } from "../manager";
import type { DebugParams, DebugRecording } from "../types";

async function fixture(archive?: DebugArchive) {
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
  const manager = new DebugManager(sessions, cdp, tabs, () => now, archive);
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
    expect(result.requests?.map((request) => request.url)).toEqual([
      "https://site.test/save",
      "https://site.test/background-after",
    ]);
    expect(result.evidence?.links.map((link) => link.relation)).toEqual(["window", "delayed"]);
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
    const before = await f.manager.read({
      action: "operation",
      session_id: "s1",
      id: first!.operation.id,
    });
    const after = await f.manager.read({
      action: "operation",
      session_id: "s1",
      id: second!.operation.id,
    });
    expect(before.requests).toHaveLength(0);
    expect(after.requests).toHaveLength(1);
    expect(before.operation?.after?.state).toBe("available");
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
      { action: "compare" },
      { action: "requests", limit: 101 },
      { action: "requests", since: -1 },
      { action: "request", id: "n1", part: "headers", pointer: "/x" },
    ])
      expect(validateDebugParams({ session_id: "s1", ...params } as DebugParams)).toBeTruthy();
  });
});

class MemoryArchive implements DebugArchive {
  records = new Map<string, DebugRecording>();
  put = vi.fn(async (record: DebugRecording) => {
    this.records.set(record.run.id, structuredClone(record));
  });
  async list() {
    return [...this.records.values()].map((record) => structuredClone(record.run));
  }
  async get(id: string) {
    const record = this.records.get(id);
    return record && structuredClone(record);
  }
  async delete(id: string) {
    this.records.delete(id);
  }
}

describe("persistent debugging records", () => {
  it("retains redacted evidence after task release and reads it without attaching to the tab", async () => {
    const archive = new MemoryArchive();
    const f = await fixture(archive);
    active.push(f.manager);
    const run = await f.manager.start("s1", 7);
    f.event("Network.requestWillBeSent", {
      requestId: "post",
      request: {
        url: "https://site.test/save?token=private",
        method: "POST",
        hasPostData: true,
        headers: { "Content-Type": "application/json", Authorization: "Bearer private" },
        postData: '{"name":"Alice","password":"private"}',
      },
    });
    f.event("Runtime.consoleAPICalled", {
      type: "error",
      args: [{ type: "string", value: "Save failed" }],
      timestamp: 10000,
    });
    f.manager.releaseSession("s1");
    await vi.waitFor(() => expect(archive.records.get(run.id)?.run.state).toBe("stopped"));
    expect((await f.manager.read({ action: "status", session_id: "s1" })).runs).toEqual([]);
    const restored = new DebugManager(f.sessions, f.cdp, f.tabs, () => 11000, archive);
    active.push(restored);
    const calls = f.sendAttached.mock.calls.length;
    const result = await restored.readHistory({ action: "export", run_id: run.id, session_id: "" });
    expect(result.recording?.run.stop_reason).toBe("session_ended");
    expect(result.recording?.requests[0].state).toBe("interrupted");
    expect(result.recording?.console[0].text).toBe("Save failed");
    expect(result.recording?.pages[0].title).toBe("App");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(f.sendAttached).toHaveBeenCalledTimes(calls);
    const request = await restored.readHistory({
      action: "request",
      run_id: run.id,
      session_id: "",
      id: result.recording!.requests[0].id,
      part: "request",
      pointer: "/name",
    });
    expect(request.request?.request_body.text).toBe('"Alice"');
    await restored.deleteHistory(run.id);
    expect((await restored.history()).runs).toEqual([]);
  });

  it("coalesces active checkpoints and flushes the final record before stop returns", async () => {
    vi.useFakeTimers();
    const archive = new MemoryArchive();
    const f = await fixture(archive);
    active.push(f.manager);
    const run = await f.manager.start("s1", 7);
    expect(archive.put).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 100; i++) f.request(`request-${i}`);
    expect(archive.put).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(archive.put).toHaveBeenCalledTimes(2);
    await expect(f.manager.deleteHistory(run.id)).rejects.toThrow("stop capture");
    await f.manager.read({ action: "stop", session_id: "s1" });
    expect(archive.records.get(run.id)?.run.state).toBe("stopped");
    expect(archive.records.get(run.id)?.requests).toHaveLength(100);
    await f.manager.deleteHistory(run.id);
    await vi.advanceTimersByTimeAsync(3000);
    expect(archive.records.has(run.id)).toBe(false);
  });

  it("shows storage failures without losing access to live export, and retries on stop", async () => {
    const archive = new MemoryArchive();
    archive.put.mockRejectedValueOnce(new Error("quota exceeded"));
    const f = await fixture(archive);
    active.push(f.manager);
    const run = await f.manager.start("s1", 7);
    expect(run.storage_error).toBe("quota exceeded");
    f.request("save");
    expect(
      (await f.manager.read({ action: "export", session_id: "s1" })).recording?.requests,
    ).toHaveLength(1);
    const result = await f.manager.read({ action: "stop", session_id: "s1" });
    expect(result.run?.storage_error).toBeUndefined();
    expect(archive.records.get(run.id)?.requests).toHaveLength(1);
  });

  it("flushes release after an in-flight checkpoint and never resurrects a deleted record", async () => {
    vi.useFakeTimers();
    const archive = new MemoryArchive();
    const f = await fixture(archive);
    active.push(f.manager);
    const run = await f.manager.start("s1", 7);
    let finish!: () => void;
    archive.put.mockImplementationOnce(
      (record) =>
        new Promise<void>((resolve) => {
          finish = () => {
            archive.records.set(record.run.id, structuredClone(record));
            resolve();
          };
        }),
    );
    f.request("first");
    await vi.advanceTimersByTimeAsync(2000);
    f.request("last");
    f.manager.releaseSession("s1");
    finish();
    await vi.waitFor(() => {
      const saved = archive.records.get(run.id);
      expect(saved?.run.state).toBe("stopped");
      expect(saved?.requests).toHaveLength(2);
    });
    await f.manager.deleteHistory(run.id);
    await vi.advanceTimersByTimeAsync(4000);
    expect((await f.manager.history()).runs).toEqual([]);
    expect(archive.records.has(run.id)).toBe(false);
  });

  it("does not expose a released capture when a short session ID is reused", async () => {
    const f = await fixture(new MemoryArchive());
    active.push(f.manager);
    const run = await f.manager.start("s1", 7);
    f.manager.releaseSession("s1");
    await expect(
      f.manager.read({ action: "export", session_id: "s1", run_id: run.id }),
    ).rejects.toThrow("not found");
    expect((await f.manager.history()).runs.some((item) => item.id === run.id)).toBe(true);
  });
});
