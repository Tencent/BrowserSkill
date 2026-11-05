import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { CdpRunner } from "@/tools/shared";
import { handleExtract } from "../extract";
import type { RawCapture } from "./types";

async function setup() {
  const manager = new SessionManager({
    agentWindow: {
      create: vi.fn(async () => ({ windowId: 100, initialTabIds: [] })),
      remove: vi.fn(async () => {}),
      ensureActiveTab: vi.fn(async () => 7),
    },
  });
  await manager.start("s1");
  const tab = {
    id: 7,
    windowId: 100,
    active: true,
    url: "https://example.test/",
  } as chrome.tabs.Tab;
  const state = { document: 1, attachment: "a1", connected: true, afterCapture: async () => {} };
  const raw: RawCapture = {
    frame_url: tab.url!,
    title: "Fixture",
    captured_at: "2026-10-01T00:00:00Z",
    rows: [],
    items: [],
    item_sources: [],
    warnings: [],
    truncated: false,
    targets: [{ kind: "table", name: "Orders", columns: [], node: { backendNodeId: 2 } }],
  };
  const root = () => ({
    result: {
      deepSerializedValue: state.connected
        ? { type: "node", value: { backendNodeId: state.document } }
        : { type: "null" },
    },
  });
  const send = vi.fn(async (_tab: number, method: string, args?: object) => {
    if (method === "Page.createIsolatedWorld") return { executionContextId: 3 };
    if (method === "Runtime.releaseObjectGroup") return {};
    if (method === "Runtime.evaluate") return root();
    if (method === "DOM.resolveNode") return { object: { objectId: "target" } };
    if (method === "Runtime.callFunctionOn") {
      const params = args as { arguments?: unknown[] };
      if (!params.arguments) return root();
      await state.afterCapture();
      return { result: { value: raw } };
    }
    throw new Error("Unexpected CDP call: " + method);
  });
  const cdp: CdpRunner = {
    send: send as CdpRunner["send"],
    getAttachmentId: () => state.attachment,
    ensureAttachedToUrl: vi.fn(async () => {}),
    getFrameGraph: vi.fn(async () => ({
      rootFrameId: "root",
      frames: [{ frameId: "root", target: { tabId: 7 }, url: tab.url }],
    })),
  };
  const tabsApi = { get: vi.fn(async () => tab), query: vi.fn(async () => [tab]) };
  const run = (params: object = {}, signal?: AbortSignal) =>
    handleExtract(
      manager,
      { session_id: "s1", action: "discover", ...params },
      { cdp, tabsApi },
      signal,
    );
  const discover = async () => {
    const reply = await run();
    if ("code" in reply) throw new Error(JSON.stringify(reply));
    return reply.targets![0].target_id;
  };
  return { manager, state, cdp, send, run, discover, tabsApi };
}

describe("extraction lifecycle", () => {
  it("rejects invalid arguments before attaching or reading the page", async () => {
    const h = await setup();
    expect(await h.run({ selector: "#a", target_id: "xt_b" })).toMatchObject({
      code: "invalid_params",
    });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.cdp.ensureAttachedToUrl).not.toHaveBeenCalled();
  });
  it("binds handles to the exact session and tab", async () => {
    const h = await setup();
    const target = await h.discover();
    await h.manager.start("s2");
    expect(await h.run({ session_id: "s2", action: "table", target_id: target })).toMatchObject({
      code: "not_found",
      data: { reason: "extract_target_stale" },
    });
    expect(await h.run({ action: "table", tab_id: 8, target_id: target })).toMatchObject({
      code: "not_found",
    });
  });
  it("rejects handles after document replacement, attachment replacement or removal", async () => {
    const h = await setup();
    const target = await h.discover();
    h.state.document = 10;
    expect(await h.run({ action: "table", target_id: target })).toMatchObject({
      data: { reason: "extract_target_stale" },
    });
    h.state.document = 1;
    h.state.attachment = "a2";
    expect(await h.run({ action: "table", target_id: target })).toMatchObject({
      data: { reason: "extract_target_stale" },
    });
    h.state.attachment = "a1";
    h.state.connected = false;
    expect(await h.run({ action: "table", target_id: target })).toMatchObject({
      data: { reason: "extract_target_stale" },
    });
  });
  it("expires handles after five minutes", async () => {
    const h = await setup();
    const target = await h.discover();
    const time = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300001);
    try {
      expect(await h.run({ action: "table", target_id: target })).toMatchObject({
        data: { reason: "extract_target_stale" },
      });
    } finally {
      time.mockRestore();
    }
  });
  it("releases remote objects when capture is cancelled", async () => {
    const h = await setup();
    const controller = new AbortController();
    h.state.afterCapture = async () => {
      controller.abort();
    };
    expect(await h.run({}, controller.signal)).toMatchObject({ code: "cancelled" });
    expect(h.send.mock.calls.at(-1)?.[1]).toBe("Runtime.releaseObjectGroup");
    const groups = h.send.mock.calls.filter((call) => call[1] === "Runtime.releaseObjectGroup");
    expect(groups.length).toBeGreaterThanOrEqual(2);
  });
  it("rejects document changes during collection instead of publishing mixed results", async () => {
    const h = await setup();
    h.state.afterCapture = async () => {
      h.state.document++;
    };
    expect(await h.run()).toMatchObject({ data: { reason: "extract_target_stale" } });
  });
  it("does not publish results after the session is stopped", async () => {
    const h = await setup();
    h.state.afterCapture = async () => {
      await h.manager.stop("s1");
    };
    expect(await h.run()).toMatchObject({ data: { reason: "extract_target_stale" } });
    expect(h.send.mock.calls.at(-1)?.[1]).toBe("Runtime.releaseObjectGroup");
  });
});
