import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { RefStore, type VisualRefInput } from "@/session-manager/ref-store";
import { handleDownload } from "../download";
import { handleRequestHelp, resetHelpLifecycleForTests } from "../human-loop";
import { handleClick, handleFill, handleHover, handlePress, handleSelect } from "../interaction";
import { handleGetHtml, handleScreenshot } from "../observation";
import type { CdpRunner } from "../shared";
import { lookupRefTarget, lookupSnapshotRef, resolveSnapshotRef } from "../snapshot-ref";
import { handleUpload } from "../upload";

function visual(): VisualRefInput {
  return {
    kind: "visual-region",
    candidate: {
      document: {
        attachmentId: "a",
        target: { tabId: 4, sessionId: "child" },
        frameId: "frame",
        documentElementBackendNodeId: 1,
      },
      backendNodeId: 42,
      parentBackendNodeId: 1,
      region: {
        status: "available",
        borderBox: { x: 0, y: 0, width: 100, height: 50 },
        crop: { x: 0, y: 0, width: 100, height: 50 },
      },
    },
  };
}

async function setup() {
  const manager = new SessionManager({
    agentWindow: {
      create: async () => 100,
      remove: async () => {},
      ensureActiveTab: async () => 4,
    },
  });
  const ctx = await manager.start("test");
  ctx.refStore.replace([
    ["e1", visual()],
    ["e2", { backendNodeId: 43, tabId: 4 }],
  ]);
  const send = vi.fn(async () => {
    throw new Error("unexpected target operation");
  });
  const cdp = { send, sendToTarget: send, trackSessionTab: vi.fn() } as unknown as CdpRunner;
  const tab = { id: 4, windowId: 100, active: true, url: "https://example.com" } as chrome.tabs.Tab;
  const tabsApi = { get: vi.fn(async () => tab), query: vi.fn(async () => [tab]) };
  return { manager, ctx, send, cdp, tabsApi };
}

describe("typed visual refs", () => {
  afterEach(() => resetHelpLifecycleForTests());

  it("keeps candidate evidence and cannot resolve a visual anchor as a bare DOM node", () => {
    const store = new RefStore();
    const input = visual();
    store.replace([
      ["@e1", input],
      ["e2", { backendNodeId: 43, tabId: 4 }],
    ]);
    const entry = store.resolveEntry("e1");
    expect(entry?.kind).toBe("visual-region");
    if (entry?.kind !== "visual-region") throw new Error("missing visual ref");
    expect(entry.candidate).toBe(input.candidate);
    expect(entry.generation).toBe(1);
    expect(store.resolve("@e1")).toBeNull();
    expect(store.resolve("e2")).toBe(43);
    // The latest observation replaces both target kinds; eN strings carry no generation.
    store.replace([["e1", { backendNodeId: 99, tabId: 4 }]]);
    expect(store.resolve("e1")).toBe(99);
    expect(store.resolveEntry("e1")).toMatchObject({ kind: "dom", generation: 2 });
    expect(store.resolveEntry("e2")).toBeNull();
  });

  it("rejects missing visual identity without partially publishing a replacement", () => {
    const store = new RefStore();
    store.set("e1", 10, { tabId: 4 });
    const invalid = visual();
    invalid.candidate.document.attachmentId = "";
    expect(() =>
      store.replace([
        ["e2", 20],
        ["e3", invalid],
      ]),
    ).toThrow(TypeError);
    expect(store.resolveEntry("e1")).toMatchObject({ generation: 0, backendNodeId: 10 });
    expect(store.size()).toBe(1);
    store.replace([["e1", visual()]]);
    expect(store.resolveEntry("e1")?.generation).toBe(1);
  });

  it("isolates tabs/sessions and distinguishes unsupported targets from missing refs", async () => {
    const { ctx } = await setup();
    expect(lookupRefTarget(ctx, "@e1", 4)?.kind).toBe("visual-region");
    expect(lookupRefTarget(ctx, "e1", 5)).toBeNull();
    expect(lookupSnapshotRef(ctx, "e1", 4)).toBeNull();
    expect(resolveSnapshotRef(ctx, "e1", 4)).toMatchObject({
      code: "unsupported",
      data: { reason: "ref_kind_unsupported" },
    });
    expect(resolveSnapshotRef(ctx, "e1", 5)).toMatchObject({
      code: "not_found",
      data: { reason: "ref_not_found" },
    });
    expect(lookupRefTarget({ ...ctx, refStore: new RefStore() }, "e1", 4)).toBeNull();
    expect(lookupSnapshotRef(ctx, "e2", 4)).toMatchObject({ backendNodeId: 43 });
  });

  it.each([
    "click",
    "fill",
    "hover",
    "press",
    "select",
    "get_html",
    "screenshot",
  ])("rejects visual refs in %s before target effects", async (tool) => {
    const { manager, send, cdp, tabsApi } = await setup();
    const params = { session_id: "test", tab_id: 4, ref: "@e1" };
    const deps = { cdp, tabsApi };
    const captureVisibleTab = vi.fn();
    let result: unknown;
    switch (tool) {
      case "click":
        result = await handleClick(manager, params, deps);
        break;
      case "fill":
        result = await handleFill(manager, { ...params, value: "hello" }, deps);
        break;
      case "hover":
        result = await handleHover(manager, params, deps);
        break;
      case "press":
        result = await handlePress(manager, { ...params, key: "Enter" }, deps);
        break;
      case "select":
        result = await handleSelect(manager, { ...params, values: ["one"] }, deps);
        break;
      case "get_html":
        result = await handleGetHtml(manager, params, deps);
        break;
      case "screenshot":
        result = await handleScreenshot(manager, params, {
          ...deps,
          captureApi: { ...tabsApi, captureVisibleTab },
        });
        break;
    }
    expect(result).toMatchObject({ code: "unsupported", data: { reason: "ref_kind_unsupported" } });
    expect(send).not.toHaveBeenCalled();
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });

  it.each([
    "input",
    "drop",
    "download",
  ] as const)("rejects visual refs before %s file-transfer setup", async (mode) => {
    const { manager, send, cdp, tabsApi } = await setup();
    const params = { session_id: "test", tab_id: 4, ref: "e1" };
    const result =
      mode === "download"
        ? await handleDownload(
            manager,
            { ...params, browser_relative_dir: "test" },
            { cdp, tabsApi },
          )
        : await handleUpload(
            manager,
            {
              ...params,
              mode,
              files: [{ transfer_id: "test", name: "test.txt", staged_path: "/unused/test.txt" }],
            },
            { cdp, tabsApi },
          );
    expect(result).toMatchObject({ code: "unsupported", data: { reason: "ref_kind_unsupported" } });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not scroll or highlight a visual anchor in human help", async () => {
    const { manager, cdp, tabsApi, send } = await setup();
    const sendToTab = vi.fn(async (_tab: number, _message: unknown) => ({
      type: "bsk-help-response",
      outcome: "continued",
    }));
    const result = await handleRequestHelp(
      manager,
      { session_id: "test", tab_id: 4, prompt: "help", targets: [{ ref: "@e1" }] },
      {
        cdp,
        tabsApi,
        sendToTab,
        windows: { update: vi.fn(async () => ({}) as never) },
        activateTab: vi.fn(async () => {}),
        notifications: null,
        autoAttachLifecycle: false,
      },
    );
    expect(result).toMatchObject({ resolved_targets: [{ ref: "@e1", matched: false }] });
    expect(send).not.toHaveBeenCalled();
    expect(sendToTab.mock.calls[0][1]).toMatchObject({ rects: [], selectors: [] });
  });
});
