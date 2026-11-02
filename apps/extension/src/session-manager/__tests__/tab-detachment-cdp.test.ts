import { afterEach, describe, expect, it, vi } from "vitest";
import { type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { CooperationController } from "@/cooperation/controller";
import { handleConsole } from "@/tools/console";
import { handleSnapshot } from "@/tools/observation";
import { attachSessionEventHandler } from "../event-handler";
import { SessionManager } from "../manager";
import { expectedTabMoves } from "../tab-moves";

function event<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>();
  return {
    addListener(listener: (...args: T) => void) {
      listeners.add(listener);
    },
    removeListener(listener: (...args: T) => void) {
      listeners.delete(listener);
    },
    emit(...args: T) {
      for (const listener of listeners) listener(...args);
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  expectedTabMoves.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function fixture() {
  const attaching = deferred(),
    finishAttach = deferred();
  const api = {
    attach: vi.fn(async () => {
      attaching.resolve();
      await finishAttach.promise;
    }),
    detach: vi.fn(async () => {}),
    sendCommand: vi.fn<CdpDebuggerApi["sendCommand"]>(async () => ({})),
    onEvent: event<[chrome.debugger.Debuggee, string, unknown]>(),
    onDetach: event<[chrome.debugger.Debuggee, string]>(),
  };
  const cdp = new ChromiumCdp(api as unknown as CdpDebuggerApi);
  let nextWindow = 10;
  const manager = new SessionManager({
    agentWindow: {
      create: async () => ({ windowId: nextWindow++, initialTabIds: [] }),
      ensureActiveTab: async (windowId) => (windowId === 10 ? 7 : 8),
      remove: async () => {},
    },
  });
  await manager.start("one");
  const signal = new AbortController();
  const tabsApi = {
    get: async () => ({ id: 7, windowId: 10, url: "https://example.test" }) as chrome.tabs.Tab,
    query: async () => [],
  };
  vi.stubGlobal("chrome", { tabs: tabsApi });
  const cooperation = new CooperationController({
    sessions: manager,
    changed: () => {},
    resumeFrames: async () => {},
    readFrames: async () =>
      new Map([
        [
          0,
          {
            document: "doc",
            revision: 0,
            structure: 0,
            human: 0,
            busy: false,
            editing: false,
            lastInput: 0,
            fields: [],
            events: [],
          },
        ],
      ]),
  });
  cooperation.startSession("one");
  await cooperation.observeTab(7);
  expect(api.attach).not.toHaveBeenCalled();
  const tabEvents = {
    onDetached: event<[number, chrome.tabs.TabDetachInfo]>(),
    onAttached: event<[number, chrome.tabs.TabAttachInfo]>(),
    onRemoved: event<[number, chrome.tabs.TabRemoveInfo]>(),
  };
  const cleanups: Promise<void>[] = [];
  const lifecycle = attachSessionEventHandler({
    manager,
    transport: { send: () => {} },
    windowEvents: event<[number]>(),
    tabEvents,
    cdp: {
      releaseSessionTab: (sessionId, tabId) => {
        const cleanup = cdp.releaseSessionTab(sessionId, tabId);
        cleanups.push(cleanup);
        return cleanup;
      },
      detachSession: (sessionId) => {
        const cleanup = cdp.detachSession(sessionId);
        cleanups.push(cleanup);
        return cleanup;
      },
    },
    agentOverlayReset: { resetAgentOverlays: async () => {} },
    onSessionReleased: () => {
      signal.abort();
      cooperation.release("one");
    },
  });
  const readConsole = () =>
    cooperation.run(
      { id: "read", method: "tool.console", params: { session_id: "one", tab_id: 7 } },
      cdp,
      signal.signal,
      (wrapped) =>
        handleConsole(
          manager,
          { session_id: "one", tab_id: 7 },
          { cdp: wrapped, tabsApi },
          signal.signal,
        ),
    );
  const readSnapshot = () =>
    cooperation.run(
      { id: "read", method: "tool.snapshot", params: { session_id: "one", tab_id: 7 } },
      cdp,
      signal.signal,
      (wrapped) =>
        handleSnapshot(
          manager,
          { session_id: "one", tab_id: 7 },
          { cdp: wrapped, tabsApi },
          signal.signal,
        ),
    );
  const moveOut = () => {
    tabEvents.onDetached.emit(7, { oldWindowId: 10, oldPosition: 0 });
    tabEvents.onAttached.emit(7, { newWindowId: 30, newPosition: 0 });
    expect(manager.has("one")).toBe(false);
    expect(cooperation.enabled(7)).toBe(false);
  };
  const dispose = async () => {
    lifecycle.dispose();
    await cdp.detachAll();
    cdp.dispose();
  };
  return {
    api,
    cdp,
    manager,
    attaching,
    finishAttach,
    cleanups,
    readConsole,
    readSnapshot,
    moveOut,
    dispose,
  };
}

describe("released task CDP attachments", () => {
  it("cleans up the first console reader even before it has registered its CDP owner", async () => {
    const f = await fixture();
    try {
      const result = f.readConsole();
      await f.attaching.promise;
      f.moveOut();
      f.finishAttach.resolve();
      expect(await result).toMatchObject({ code: "cancelled" });
      await Promise.all(f.cleanups);
      expect(f.cdp.isAttached(7)).toBe(false);
      expect(f.api.detach).toHaveBeenCalledExactlyOnceWith({ tabId: 7 });
    } finally {
      await f.dispose();
    }
  });

  it("fences an attachment that completes after the existing cleanup budget", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    try {
      const result = f.readConsole();
      await f.attaching.promise;
      f.moveOut();
      await vi.advanceTimersByTimeAsync(1001);
      await Promise.all(f.cleanups);
      expect(f.cdp.isAttached(7)).toBe(false);
      f.finishAttach.resolve();
      expect(await result).toHaveProperty("code");
      expect(f.cdp.isAttached(7)).toBe(false);
      expect(f.api.detach).toHaveBeenCalledExactlyOnceWith({ tabId: 7 });
      expect(f.api.sendCommand).not.toHaveBeenCalled();
    } finally {
      await f.dispose();
    }
  });

  it("preserves an attachment still owned by another session", async () => {
    const f = await fixture();
    try {
      const other = await f.manager.start("other");
      f.finishAttach.resolve();
      await f.cdp.ensureConsoleCapture(7);
      f.cdp.trackSessionTab("one", 7);
      f.cdp.trackSessionTab("other", 7);
      f.moveOut();
      await Promise.all(f.cleanups);
      expect(f.manager.get("other")).toBe(other);
      expect(f.cdp.isAttached(7)).toBe(true);
      expect(f.api.detach).not.toHaveBeenCalled();
      // The surviving owner can continue reading until it releases its claim.
      await f.cdp.ensureConsoleCapture(7);
      await f.cdp.releaseSessionTab("other", 7);
      expect(f.cdp.isAttached(7)).toBe(false);
      expect(f.api.detach).toHaveBeenCalledExactlyOnceWith({ tabId: 7 });
    } finally {
      await f.dispose();
    }
  });
});

async function pendingSnapshot() {
  const f = await fixture();
  const readingTree = deferred(),
    finishTree = deferred();
  f.finishAttach.resolve();
  f.api.sendCommand.mockImplementation(async (_target, method) => {
    if (method === "Page.getFrameTree") {
      readingTree.resolve();
      await finishTree.promise;
      return {
        frameTree: {
          frame: { id: "root", url: "https://example.test" },
          childFrames: [
            { frame: { id: "child", parentId: "root", url: "https://example.test/frame" } },
          ],
        },
      };
    }
    if (method === "DOM.getFrameOwner") return { backendNodeId: 3 };
    return {};
  });
  const result = f.readSnapshot();
  await readingTree.promise;
  return { ...f, result, finishTree };
}

describe("released snapshot frame discovery", () => {
  it("does not reconnect after a late frame-tree reply from a released task", async () => {
    const f = await pendingSnapshot();
    try {
      f.moveOut();
      await Promise.all(f.cleanups);
      expect(f.cdp.isAttached(7)).toBe(false);
      const commandsBeforeReply = f.api.sendCommand.mock.calls.length;
      f.finishTree.resolve();
      expect(await f.result).toMatchObject({ code: "cancelled" });
      expect(f.api.attach).toHaveBeenCalledTimes(1);
      expect(f.api.detach).toHaveBeenCalledTimes(1);
      expect(f.cdp.isAttached(7)).toBe(false);
      expect(f.api.sendCommand).toHaveBeenCalledTimes(commandsBeforeReply);
    } finally {
      await f.dispose();
    }
  });

  it("stops the cancelled snapshot while another session retains the same connection", async () => {
    const f = await pendingSnapshot();
    try {
      await f.manager.start("other");
      f.cdp.trackSessionTab("other", 7);
      const attachment = f.cdp.getAttachmentId(7);
      f.moveOut();
      await Promise.all(f.cleanups);
      expect(f.cdp.getAttachmentId(7)).toBe(attachment);
      const commandsBeforeReply = f.api.sendCommand.mock.calls.length;
      f.finishTree.resolve();
      expect(await f.result).toMatchObject({ code: "cancelled" });
      expect(f.api.sendCommand).toHaveBeenCalledTimes(commandsBeforeReply);
      expect(f.cdp.getAttachmentId(7)).toBe(attachment);
      expect(f.api.detach).not.toHaveBeenCalled();
    } finally {
      await f.dispose();
    }
  });

  it("does not use a replacement connection or fallback when attachment identity changes", async () => {
    const f = await pendingSnapshot();
    try {
      const oldAttachment = f.cdp.getAttachmentId(7);
      await f.cdp.releaseSessionTab("one", 7);
      await f.manager.start("other");
      f.cdp.trackSessionTab("other", 7);
      await f.cdp.ensureConsoleCapture(7);
      const replacement = f.cdp.getAttachmentId(7);
      expect(replacement).not.toBe(oldAttachment);
      const commandsBeforeReply = f.api.sendCommand.mock.calls.length;
      f.finishTree.resolve();
      expect(await f.result).toMatchObject({
        code: "cdp_failed",
        message: expect.stringContaining("attachment changed"),
      });
      expect(f.api.sendCommand).toHaveBeenCalledTimes(commandsBeforeReply);
      expect(f.api.attach).toHaveBeenCalledTimes(2);
      expect(f.api.detach).toHaveBeenCalledTimes(1);
      expect(f.cdp.getAttachmentId(7)).toBe(replacement);
    } finally {
      await f.dispose();
    }
  });
});
