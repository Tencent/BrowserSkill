import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { handleRead } from "../read";
import type { CdpRunner } from "../shared";
import { collectDomRead } from "./collector";
import type { ReadParams } from "./types";
import { validateRead } from "./validation";

const fields = [{ key: "label", read: "text" as const }];
describe("declarative DOM reads", () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<article id="row" data-id="42"><span>A</span><input value="v"><input type="checkbox" checked></article>';
  });
  const collect = (patch: Partial<ReadParams> = {}) =>
    collectDomRead.call(
      document.documentElement,
      validateRead({ session_id: "s", selector: "#row", ...patch }),
    );
  it("reads exact text, native values and attributes, not arbitrary properties", () => {
    const result = collect({
      fields: [
        { key: "id", read: "attribute", attribute: "data-id" },
        { key: "text", read: "text", selector: "span" },
        { key: "value", read: "value", selector: "input:not([type])" },
        { key: "checked", read: "checked", selector: "input[type=checkbox]" },
        { key: "missing", read: "exists", selector: ".missing" },
      ],
    });
    expect(result.items[0].values).toEqual({
      id: "42",
      text: "A",
      value: "v",
      checked: true,
      missing: false,
    });
    for (const patch of [
      { expression: "fetch('/write')" },
      { readonly: true },
      { fields: [{ key: "x", read: "onclick" }] },
      { fields: [{ key: "x", read: "text", callback: "setTimeout(x)" }] },
      { expect: [] },
    ])
      expect(() => validateRead({ session_id: "s", ...patch } as ReadParams)).toThrow();
  });
  it("handles bounds, ambiguous fields and invalid selectors without partial success", () => {
    expect(collect({ selector: "input", max_nodes: 1 }).truncated).toBe(true);
    expect(
      collect({ fields: [{ key: "v", read: "value", selector: "input" }] }).error?.reason,
    ).toBe("read_field_ambiguous");
    expect(collect({ selector: "[" }).error?.reason).toBe("read_selector_invalid");
    document.querySelector("span")!.textContent = "x".repeat(2048);
    const limited = collect({ max_bytes: 1024 });
    expect(limited).toMatchObject({ items: [], error: { reason: "read_limit" } });
  });
  it("redacts sensitive fields and their ancestor text", () => {
    document.body.innerHTML =
      '<div id="row"><textarea autocomplete="section-auth one-time-code">secret</textarea></div>';
    expect(collect().items[0]).toMatchObject({ values: { text: null }, redacted: ["text"] });
    expect(
      collect({
        selector: "textarea",
        fields: [
          { key: "x", read: "value" },
          { key: "attr", read: "attribute", attribute: "autocomplete" },
        ],
      }).items[0],
    ).toMatchObject({ values: { x: null, attr: null }, redacted: ["x", "attr"] });
  });
  it("does not quietly redirect a detached node to a replacement", () => {
    const node = document.querySelector("#row")!;
    node.replaceWith(node.cloneNode(true));
    expect(collectDomRead.call(node, validateRead({ session_id: "s", fields })).error?.reason).toBe(
      "read_target_stale",
    );
  });
});

async function fixture() {
  const manager = new SessionManager({
    agentWindow: {
      create: vi.fn(async () => ({ windowId: 100, initialTabIds: [] })),
      remove: vi.fn(async () => {}),
      ensureActiveTab: vi.fn(async () => 7),
    },
  });
  await manager.start("s");
  const tab = {
    id: 7,
    windowId: 100,
    active: true,
    url: "https://test.example/",
  } as chrome.tabs.Tab;
  const state = { root: 1, attachment: "a", afterCapture: async () => {} };
  const rootReply = () => ({
    result: { deepSerializedValue: { type: "node", value: { backendNodeId: state.root } } },
  });
  const send = vi.fn(async (_tab: number, method: string, args?: object): Promise<unknown> => {
    if (method === "Page.getFrameTree")
      return { frameTree: { frame: { id: "root", url: tab.url } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 3 };
    if (method === "Runtime.releaseObjectGroup") return {};
    if (method === "Runtime.evaluate") return rootReply();
    if (method === "DOM.resolveNode") return { object: { objectId: "node" } };
    if (method === "Runtime.callFunctionOn") {
      if (!(args as { arguments?: unknown[] }).arguments) return rootReply();
      await state.afterCapture();
      return {
        result: {
          value: {
            frame_url: tab.url,
            title: "Test",
            captured_at: "now",
            truncated: false,
            items: [{ node: { backendNodeId: 2 }, values: { label: "A" }, redacted: [] }],
          },
        },
      };
    }
    throw new Error(method);
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
  const run = (patch: object = {}, signal?: AbortSignal) =>
    handleRead(
      manager,
      { session_id: "s", fields, ...patch },
      { cdp, tabsApi: { get: vi.fn(async () => ({ ...tab })), query: vi.fn(async () => [tab]) } },
      signal,
    );
  return { manager, state, tab, run, send, cdp };
}
describe("DOM read identity and lifecycle", () => {
  it.each([
    "root",
    "child",
  ] as const)("reports a missing %s document element as stale without publishing a read", async (frame) => {
    const h = await fixture();
    const original = h.send.getMockImplementation()!;
    h.send.mockImplementation(async (tabId, method, args) => {
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: (args as { frameId: string }).frameId === "child" ? 4 : 3 };
      if (
        method === "Runtime.evaluate" &&
        (args as { contextId: number }).contextId === (frame === "child" ? 4 : 3)
      )
        return { result: { deepSerializedValue: { type: "null" } } };
      return original(tabId, method, args);
    });
    const store = h.manager.get("s")!.refStore;
    if (frame === "child") {
      store.set("e1", 2, { tabId: 7, frameId: "child", loaderId: "child-loader" });
      vi.mocked(h.cdp.getFrameGraph!).mockResolvedValue({
        rootFrameId: "root",
        frames: [
          {
            frameId: "child",
            target: { tabId: 7, sessionId: "child-session" },
            loaderId: "child-loader",
          },
        ],
      });
    }
    const size = store.size();
    expect(await h.run(frame === "child" ? { ref: "@e1" } : {})).toMatchObject({
      code: "not_found",
      data: { reason: "read_target_stale", phase: "read", effect_state: "none" },
    });
    expect(store.size()).toBe(size);
    expect(h.send).not.toHaveBeenCalledWith(7, "Runtime.callFunctionOn", expect.anything());
    expect(h.send).toHaveBeenCalledWith(7, "Runtime.releaseObjectGroup", expect.anything());
  });
  it("does not collect or depend on unrelated child renderers for a main-document read", async () => {
    const h = await fixture();
    vi.mocked(h.cdp.getFrameGraph!).mockRejectedValue(
      new Error("unrelated OOPIF cannot be observed"),
    );
    expect(await h.run()).toMatchObject({ scope: "current_dom" });
    expect(h.cdp.getFrameGraph).not.toHaveBeenCalled();
  });
  it("rejects invalid read capabilities before touching CDP", async () => {
    const h = await fixture();
    expect(await h.run({ expression: "document.body.remove()", readonly: true })).toMatchObject({
      code: "invalid_params",
      data: { effect_state: "none" },
    });
    expect(h.send).not.toHaveBeenCalled();
  });
  it.each([
    "root",
    "attachment",
    "route",
    "refs",
    "session",
    "cancel",
  ])("does not publish stale results or refs after %s changes", async (kind) => {
    const h = await fixture();
    const abort = new AbortController();
    h.state.afterCapture = async () => {
      if (kind === "root") h.state.root++;
      if (kind === "attachment") h.state.attachment = "new";
      if (kind === "route") h.tab.url += "other";
      if (kind === "refs") h.manager.get("s")!.refStore.invalidateTab(7);
      if (kind === "session") await h.manager.stop("s");
      if (kind === "cancel") abort.abort();
    };
    const reply = await h.run({}, abort.signal);
    expect(reply).toMatchObject({
      code: kind === "cancel" ? "cancelled" : "not_found",
      data: { effect_state: "none" },
    });
    expect(h.manager.get("s")?.refStore.size() ?? 0).toBe(0);
    expect(h.send).toHaveBeenCalledWith(7, "Runtime.releaseObjectGroup", expect.anything());
  });
  it("publishes a current sample with stable refs without replacing an observation", async () => {
    const h = await fixture();
    const store = h.manager.get("s")!.refStore;
    store.enableStableRefs();
    const token = store.observationId;
    const revision = store.revision;
    const first = await h.run();
    expect(await h.run()).toEqual(first);
    expect(store.observationId).toBe(token);
    expect(store.revision).toBe(revision);
    expect(first).toMatchObject({
      scope: "current_dom",
      items: [{ ref: expect.stringMatching(/^@e\d+$/), values: { label: "A" } }],
    });
  });
});
