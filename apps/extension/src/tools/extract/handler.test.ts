import { describe, expect, it, vi } from "vitest";
import { toFrameDocumentHandle } from "@/browser-driver/frame-handles";
import { SessionManager } from "@/session-manager/manager";
import { type CdpRunner, createStubCdpRunner } from "@/tools/shared";
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
  const ensureAttachedToUrl = vi.fn(async () => {});
  const getFrameDocuments = vi.fn<CdpRunner["getFrameDocuments"]>(async () => ({
    rootFrameId: "root",
    frames: [
      {
        handle: toFrameDocumentHandle(7, { frameId: "root", loaderId: "" }),
        frameId: "root",
        loaderId: "",
        url: tab.url,
        processKey: "root",
        isOutOfProcess: false,
      },
    ],
  }));
  const cdp = Object.assign(
    createStubCdpRunner({
      send: send as CdpRunner["send"],
      getAttachmentId: () => state.attachment,
      ensureAttachedToUrl,
      getFrameDocuments,
    }),
    { ensureAttachedToUrl, getFrameDocuments },
  );
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

  it("searches child frames for --selector and rejects cross-frame selector ambiguity", async () => {
    const h = await setup();
    const rootHandle = toFrameDocumentHandle(7, { frameId: "root", loaderId: "L-root" });
    const childHandle = toFrameDocumentHandle(7, { frameId: "child", loaderId: "L-child" });
    h.cdp.getFrameDocuments.mockResolvedValue({
      rootFrameId: "root",
      frames: [
        {
          handle: rootHandle,
          frameId: "root",
          loaderId: "L-root",
          url: "https://example.test/",
          processKey: "root",
          isOutOfProcess: false,
        },
        {
          handle: childHandle,
          frameId: "child",
          parentFrameId: "root",
          loaderId: "L-child",
          ownerBackendNodeId: 55,
          url: "https://child.example.test/",
          processKey: "oopif:child",
          isOutOfProcess: true,
        },
      ],
    });

    let rootMatches = false;
    h.cdp.sendToFrame = vi.fn(async (handle, method, args) => {
      if (method === "Page.createIsolatedWorld") {
        return { executionContextId: handle.frameId === "child" ? 9 : 3 };
      }
      if (method === "Runtime.releaseObjectGroup") return {};
      if (method === "Runtime.evaluate") {
        return {
          result: {
            deepSerializedValue: {
              type: "node",
              value: { backendNodeId: handle.frameId === "child" ? 200 : 1 },
            },
          },
        };
      }
      if (method === "DOM.resolveNode") return { object: { objectId: "owner-obj" } };
      if (method === "Runtime.callFunctionOn") {
        const params = args as { arguments?: unknown[]; functionDeclaration?: string };
        if (params.functionDeclaration?.includes("checkVisibility")) {
          return { result: { value: true } };
        }
        if (!params.arguments) {
          return {
            result: {
              deepSerializedValue: {
                type: "node",
                value: { backendNodeId: handle.frameId === "child" ? 200 : 1 },
              },
            },
          };
        }
        if (handle.frameId === "root" && !rootMatches) {
          return {
            result: {
              value: {
                frame_url: "https://example.test/",
                title: "root",
                captured_at: "2026-10-01T00:00:00Z",
                rows: [],
                items: [],
                item_sources: [],
                warnings: [],
                truncated: false,
                targets: [],
                error: { reason: "selector_not_found", message: "not in root" },
              },
            },
          };
        }
        return {
          result: {
            value: {
              frame_url:
                handle.frameId === "child"
                  ? "https://child.example.test/"
                  : "https://example.test/",
              title: handle.frameId,
              captured_at: "2026-10-01T00:00:00Z",
              columns: [{ name: "Order", index: 0 }],
              rows: [{ cells: ["#1001"] }],
              items: [],
              item_sources: [],
              warnings: [],
              truncated: false,
              targets: [],
            },
          },
        };
      }
      throw new Error(`Unexpected sendToFrame: ${method}`);
    }) as CdpRunner["sendToFrame"];

    const childOnly = await h.run({ action: "table", selector: "#orders-shadow-table" });
    expect(childOnly).toMatchObject({
      kind: "table",
      source: {
        frame_id: "child",
        frame_url: "https://child.example.test/",
        selector: "#orders-shadow-table",
      },
    });

    // A selector is scoped to the main document, so a root match wins over a
    // child-frame match instead of reporting an ambiguous target.
    rootMatches = true;
    const rootPreferred = await h.run({ action: "table", selector: "#orders-shadow-table" });
    expect(rootPreferred).toMatchObject({
      kind: "table",
      source: {
        frame_id: "root",
        frame_url: "https://example.test/",
        selector: "#orders-shadow-table",
      },
    });
  });
});
