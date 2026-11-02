import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { handleSnapshot } from "@/tools/observation";
import type { CdpRunner } from "@/tools/shared";
import { CooperationController } from "./controller";
import type { CooperationParams, FrameState } from "./types";

vi.mock("@/tools/observation", async (original) => {
  const module = await original<typeof import("@/tools/observation")>();
  return { ...module, handleSnapshot: vi.fn(module.handleSnapshot) };
});

async function fixture() {
  const sessions = new SessionManager({
    agentWindow: {
      create: async () => ({ windowId: 100, initialTabIds: [7] }),
      remove: async () => {},
      ensureActiveTab: async () => 7,
    },
  });
  const session = await sessions.start("s");
  const original = session.refStore;
  original.set("e5", 999, { tabId: 7 });
  const tab = {
    id: 7,
    windowId: 100,
    active: true,
    url: "https://fixture.test",
  } as chrome.tabs.Tab;
  const tabsApi = { get: async (id: number) => ({ ...tab, id }), query: async () => [tab] };
  vi.stubGlobal("chrome", { tabs: tabsApi });
  let frame: FrameState = {
    document: "doc",
    revision: 0,
    structure: 0,
    human: 0,
    busy: false,
    editing: false,
    lastInput: 0,
    fields: [],
    events: [],
  };
  const readFrames = vi.fn(async () => new Map([[0, structuredClone(frame)]]));
  const controller = new CooperationController({
    sessions,
    readFrames,
    resumeFrames: async () => {},
    changed: () => {},
    now: () => 10_000,
  });
  const cdp = {
    send: vi.fn(async (_tabId, method) => {
      if (method === "Accessibility.enable" || method === "DOMSnapshot.enable") return {};
      if (method === "Accessibility.getFullAXTree")
        return {
          nodes: [
            {
              nodeId: "1",
              role: { value: "RootWebArea" },
              backendDOMNodeId: 100,
              childIds: ["2"],
            },
            {
              nodeId: "2",
              parentId: "1",
              role: { value: "button" },
              name: { value: "Save" },
              backendDOMNodeId: 200,
            },
          ],
        };
      if (method === "Page.getLayoutMetrics")
        return {
          cssVisualViewport: { clientWidth: 1000 },
          cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0 },
        };
      // Exercise the existing AX fallback with a minimal, stable document.
      throw new Error(`Unsupported fixture method: ${method}`);
    }),
  } as CdpRunner;
  const abort = new AbortController();
  return {
    session,
    original,
    controller,
    cdp,
    readFrames,
    abort,
    snapshot: () => handleSnapshot(sessions, { session_id: "s", tab_id: 7 }, { cdp, tabsApi }),
    sync: (
      control_policy: CooperationParams["control_policy"] = "auto",
      action: "sync" | "enable" = "sync",
      tab_id = 7,
    ) =>
      controller.command(
        { session_id: "s", tab_id, action, control_policy },
        cdp,
        abort.signal,
      ) as Promise<Record<string, unknown>>,
    change(patch: Partial<FrameState>) {
      frame = { ...frame, revision: frame.revision + 1, ...patch };
    },
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function pauseSnapshot() {
  const captured = gate();
  const release = gate();
  const realSnapshot =
    await vi.importActual<typeof import("@/tools/observation")>("@/tools/observation");
  vi.mocked(handleSnapshot).mockImplementationOnce(async (...args) => {
    const result = await realSnapshot.handleSnapshot(...args);
    captured.open();
    await release.promise;
    return result;
  });
  return { captured: captured.promise, release: release.open };
}

describe("first control-policy negotiation", () => {
  it.each([
    "sync",
    "enable",
  ] as const)("does not select a policy or clear refs when %s is busy", async (action) => {
    const f = await fixture();
    const observation = f.original.observationId;
    f.change({ editing: true });
    expect(await f.sync("auto", action)).toMatchObject({
      code: "permission_denied",
      message: expect.stringContaining("still operating"),
    });
    expect(handleSnapshot).not.toHaveBeenCalled();
    expect(f.session.controlPolicy).toBeUndefined();
    expect(f.session.refStore).toBe(f.original);
    expect(f.original.resolve("e5")).toBe(999);
    expect(f.original.observationId).toBe(observation);

    f.change({ editing: false });
    expect(await f.sync("strict")).toMatchObject({
      control_policy: "strict",
      observation: { text: expect.stringContaining('@e1 button "Save"') },
    });
    expect(f.session.refStore.stableRefsEnabled).toBe(false);
  });

  it.each([
    "strict",
    "target",
  ] as const)("allows a %s retry after the first snapshot fails without changing prior refs", async (retry) => {
    const f = await fixture();
    const observation = f.original.observationId;
    vi.mocked(handleSnapshot).mockResolvedValueOnce({
      code: "timeout",
      message: "capture timed out",
    });
    expect(await f.sync()).toMatchObject({ code: "timeout" });
    expect(f.session.controlPolicy).toBeUndefined();
    expect(f.session.refStore).toBe(f.original);
    expect(f.original.stableRefsEnabled).toBe(false);
    expect(f.original.resolve("e5")).toBe(999);
    expect(f.original.observationId).toBe(observation);
    expect(await f.sync(retry)).toMatchObject({
      control_policy: retry,
      observation: {
        text: expect.stringContaining(`@e${retry === "target" ? 6 : 1} button "Save"`),
      },
    });
  });

  it.each([
    "strict",
    "target",
  ] as const)("does not publish a %s candidate when a person intervenes after capture", async (policy) => {
    const f = await fixture();
    const observation = f.original.observationId;
    f.readFrames.mockResolvedValueOnce(await f.readFrames());
    f.change({ human: 1 });
    expect(await f.sync(policy)).toMatchObject({
      code: "permission_denied",
      message: expect.stringContaining("Page changed while synchronizing"),
    });
    expect(handleSnapshot).toHaveBeenCalledOnce();
    expect(f.session.controlPolicy).toBeUndefined();
    expect(f.session.refStore).toBe(f.original);
    expect(f.original.resolve("e5")).toBe(999);
    expect(f.original.observationId).toBe(observation);
    expect(await f.sync(policy === "strict" ? "target" : "strict")).toHaveProperty("context_id");
  });

  it("commits stable refs only with a successful context and never recycles older names", async () => {
    const f = await fixture();
    const result = await f.sync();
    expect(result).toMatchObject({ control_policy: "target", context_id: expect.any(String) });
    expect(result.observation).toMatchObject({
      text: expect.stringContaining('@e6 button "Save"'),
    });
    expect(f.session.refStore).not.toBe(f.original);
    expect(f.session.refStore.stableRefsEnabled).toBe(true);
    expect(f.session.refStore.resolve("e6")).toBe(200);
    expect(f.session.refStore.resolve("e5")).toBeNull();
    expect(await f.snapshot()).toMatchObject({
      text: expect.stringContaining('@e6 button "Save"'),
    });
    expect(await f.sync("strict")).toMatchObject({ code: "invalid_params" });
  });

  it.each([
    "strict",
    "target",
  ] as const)("keeps the %s policy and refs already committed by another tab's first sync", async (policy) => {
    const f = await fixture();
    f.session.agentCreatedTabs.add(8);
    const paused = await pauseSnapshot();
    const pending = f.sync("target");
    await paused.captured;
    const winner = await f.sync(policy, "sync", 8);
    const committed = f.session.refStore;
    paused.release();
    const loser = await pending;

    expect(winner).toMatchObject({ control_policy: policy, context_id: expect.any(String) });
    expect(loser).toMatchObject({
      code: "permission_denied",
      message: expect.stringContaining(`initialized this session with ${policy} control`),
    });
    expect(f.session.controlPolicy).toBe(policy);
    expect(f.session.refStore).toBe(committed);
    const winnerRef = policy === "target" ? "e6" : "e1";
    expect(committed.resolve(winnerRef, { tabId: 8 })).toBe(200);
    expect(committed.resolve(winnerRef, { tabId: 7 })).toBeNull();
    expect(await f.sync()).toMatchObject({
      control_policy: policy,
      context_id: expect.any(String),
    });
    if (policy === "target") {
      expect(committed.resolve(winnerRef, { tabId: 8 })).toBe(200);
      expect(committed.resolve("e7", { tabId: 7 })).toBe(200);
    }
  });

  it("does not recycle refs published by a supplementary snapshot during negotiation", async () => {
    const f = await fixture();
    const paused = await pauseSnapshot();
    const pending = f.sync();
    await paused.captured;
    const send = vi.mocked(f.cdp.send);
    const originalSend = send.getMockImplementation()!;
    const buttons = Array.from({ length: 6 }, (_, index) => ({
      nodeId: String(index + 2),
      parentId: "1",
      role: { value: "button" },
      name: { value: `Button ${index}` },
      backendDOMNodeId: 200 + index,
    }));
    send.mockImplementation(async (...args) =>
      args[1] === "Accessibility.getFullAXTree"
        ? {
            nodes: [
              {
                nodeId: "1",
                role: { value: "RootWebArea" },
                backendDOMNodeId: 100,
                childIds: buttons.map((button) => button.nodeId),
              },
              ...buttons,
            ],
          }
        : originalSend(...args),
    );
    const supplementary = await f.snapshot();
    send.mockImplementation(originalSend);
    paused.release();
    const result = await pending;

    expect(supplementary).toMatchObject({ text: expect.stringContaining('@e6 button "Button 5"') });
    expect(result).toMatchObject({
      code: "permission_denied",
      message: expect.stringContaining("observation changed during policy negotiation"),
    });
    expect(f.session.controlPolicy).toBeUndefined();
    expect(f.session.refStore).toBe(f.original);
    expect(f.original.resolve("e6")).toBe(205);
    expect(await f.sync()).toMatchObject({
      control_policy: "target",
      observation: { text: expect.stringContaining('@e7 button "Save"') },
    });
    expect(f.session.refStore.resolve("e6")).toBeNull();
  });

  it("refuses an older snapshot that finishes after the first policy is committed", async () => {
    const f = await fixture();
    const captured = gate();
    const release = gate();
    const send = vi.mocked(f.cdp.send);
    const originalSend = send.getMockImplementation()!;
    let firstCapture = true;
    send.mockImplementation(async (...args) => {
      const result = await originalSend(...args);
      if (args[1] === "Accessibility.getFullAXTree" && firstCapture) {
        firstCapture = false;
        captured.open();
        await release.promise;
      }
      return result;
    });
    const pending = f.snapshot();
    await captured.promise;
    const synced = await f.sync();
    release.open();
    const snapshot = await pending;

    expect(synced).toMatchObject({ control_policy: "target", context_id: expect.any(String) });
    expect(snapshot).toMatchObject({
      code: "not_found",
      message: "Control policy changed during observation; observe again",
    });
    expect(f.session.refStore.resolve("e6")).toBe(200);
    expect(f.session.refStore.resolve("e1")).toBeNull();
  });

  it("does not restore invalidated document refs when a candidate is discarded", async () => {
    const f = await fixture();
    const realSnapshot =
      await vi.importActual<typeof import("@/tools/observation")>("@/tools/observation");
    vi.mocked(handleSnapshot).mockImplementationOnce(async (...args) => {
      const result = await realSnapshot.handleSnapshot(...args);
      f.original.invalidateTab(7);
      f.controller.invalidate(7);
      f.change({ document: "next" });
      return result;
    });
    expect(await f.sync()).toHaveProperty("code");
    expect(f.session.controlPolicy).toBeUndefined();
    expect(f.session.refStore).toBe(f.original);
    expect(f.original.resolve("e5")).toBeNull();
    expect(f.original.resolve("e6")).toBeNull();
    expect(f.original.documentRevision(7)).toBe(1);
  });

  it("checks the live session document while capturing into a candidate store", async () => {
    const f = await fixture();
    const send = vi.mocked(f.cdp.send);
    const originalSend = send.getMockImplementation()!;
    send.mockImplementation(async (...args) => {
      if (args[1] === "Accessibility.getFullAXTree") f.original.invalidateTab(7);
      return originalSend(...args);
    });
    expect(await f.sync()).toMatchObject({
      code: "not_found",
      message: expect.stringContaining("Document changed during observation"),
    });
    expect(f.session.controlPolicy).toBeUndefined();
    expect(f.session.refStore).toBe(f.original);
    expect(f.original.resolve("e5")).toBeNull();
    send.mockImplementation(originalSend);
    expect(await f.sync()).toHaveProperty("context_id");
    expect(f.session.refStore.documentRevision(7)).toBe(1);
    expect(f.session.refStore.resolve("e5")).toBeNull();
    expect(f.session.refStore.resolve("e6")).toBe(200);
  });

  it("discards a captured candidate if sync is cancelled before commit", async () => {
    const f = await fixture();
    const realSnapshot =
      await vi.importActual<typeof import("@/tools/observation")>("@/tools/observation");
    vi.mocked(handleSnapshot).mockImplementationOnce(async (...args) => {
      const result = await realSnapshot.handleSnapshot(...args);
      f.abort.abort();
      return result;
    });
    expect(await f.sync()).toHaveProperty("code");
    expect(f.session.controlPolicy).toBeUndefined();
    expect(f.session.refStore).toBe(f.original);
    expect(f.original.resolve("e5")).toBe(999);
  });
});
