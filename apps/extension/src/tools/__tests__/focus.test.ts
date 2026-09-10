import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpTarget } from "@/browser-driver/frame-graph";
import { SessionManager } from "@/session-manager/manager";
import { handleBlur, handleFocus } from "../interaction";
import type { CdpRunner } from "../shared";

interface ScriptParams {
  functionDeclaration: string;
}
interface Call {
  target: CdpTarget;
  method: string;
}

async function setup(element?: HTMLElement, childSession = false) {
  if (!element) {
    document.body.innerHTML = '<input id="target"><input id="other">';
    element = document.querySelector<HTMLInputElement>("#target")!;
  }
  const targetElement = element;
  const manager = new SessionManager({
    agentWindow: {
      create: async () => 100,
      remove: async () => {},
      ensureActiveTab: async () => 4,
    },
  });
  const ctx = await manager.start("aa11");
  ctx.refStore.set("e1", 12, {
    tabId: 4,
    ...(childSession ? { frameId: "child", cdpSessionId: "child-session" } : {}),
  });
  const calls: Call[] = [];
  const afterCommand = vi.fn<(call: Call) => void>();
  const script = vi.fn(async (params: ScriptParams) => {
    try {
      const fn = new Function(`return (${params.functionDeclaration})`)();
      return { result: { value: await fn.call(targetElement) } };
    } catch (error) {
      return { exceptionDetails: { text: "Uncaught", exception: { description: String(error) } } };
    }
  });
  const focus = vi.fn(() => targetElement.focus());
  const release = vi.fn(async () => ({}));
  const send = async (target: CdpTarget, method: string, params?: object) => {
    const call = { target, method };
    calls.push(call);
    try {
      switch (method) {
        case "DOM.getDocument":
          return { root: { nodeId: 1 } };
        case "DOM.querySelector":
          return { nodeId: 2 };
        case "DOM.describeNode":
          return { node: { backendNodeId: 12 } };
        case "DOM.scrollIntoViewIfNeeded":
          return {};
        case "DOM.resolveNode":
          return { object: { objectId: "focus-target" } };
        case "DOM.focus":
          focus();
          return {};
        case "Runtime.callFunctionOn":
          return await script(params as ScriptParams);
        case "Runtime.releaseObject":
          return await release();
        default:
          throw new Error(`unexpected ${method}`);
      }
    } finally {
      afterCommand(call);
    }
  };
  const cdp: CdpRunner = {
    send: (tabId, method, params) => send({ tabId }, method, params) as never,
    sendToTarget: send as CdpRunner["sendToTarget"],
    getFrameGraph: vi.fn(async () => ({
      rootFrameId: "main",
      frames: [
        { frameId: "main", target: { tabId: 4 } },
        ...(childSession
          ? [
              {
                frameId: "child",
                parentFrameId: "main",
                ownerBackendNodeId: 99,
                target: { tabId: 4, sessionId: "child-session" },
              },
            ]
          : []),
      ],
    })),
  };
  const tabsApi = {
    get: vi.fn(async (id: number) => ({ id, windowId: 100, active: true }) as chrome.tabs.Tab),
    query: vi.fn(async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab]),
  };
  return {
    element: targetElement,
    calls,
    afterCommand,
    script,
    focus,
    release,
    cdp,
    tabsApi,
    run: (
      action: "focus" | "blur",
      signal?: AbortSignal,
      params: { ref?: string; selector?: string; tab_id?: number } = { ref: "e1" },
    ) =>
      (action === "focus" ? handleFocus : handleBlur)(
        manager,
        { session_id: "aa11", ...params },
        { cdp, tabsApi, signal },
      ),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("focus and blur state verification", () => {
  it.each(["open", "closed"] as const)("handles nested %s shadow roots", async (mode) => {
    const host = document.createElement("div");
    document.body.append(host);
    const outer = host.attachShadow({ mode });
    const innerHost = document.createElement("div");
    outer.append(innerHost);
    const inner = innerHost.attachShadow({ mode });
    const element = document.createElement("input");
    inner.append(element);
    const h = await setup(element);
    expect(await h.run("focus")).toMatchObject({ focused: true });
    expect(inner.activeElement).toBe(element);
    expect(await h.run("blur")).toMatchObject({ was_focused: true, focused: false });
    expect(inner.activeElement).toBeNull();
    expect(h.release).toHaveBeenCalledTimes(2);
  });

  it("keeps DOM focus usable when the document is in the background", async () => {
    const h = await setup();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    expect(await h.run("focus")).toMatchObject({ focused: true });
    expect(await h.run("blur")).toMatchObject({ was_focused: true, focused: false });
  });

  it("blurring an unfocused target preserves the other element's focus", async () => {
    const h = await setup();
    const other = document.querySelector<HTMLInputElement>("#other")!;
    other.focus();
    expect(await h.run("blur")).toMatchObject({ was_focused: false, focused: false });
    expect(document.activeElement).toBe(other);
  });

  it("detects focus redirected by a focus handler's microtask", async () => {
    const h = await setup();
    h.element.addEventListener("focus", () =>
      queueMicrotask(() => document.querySelector<HTMLInputElement>("#other")!.focus()),
    );
    expect(await h.run("focus")).toMatchObject({
      code: "cdp_failed",
      message: "target element did not become focused",
    });
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("does not report blur success when a microtask restores focus", async () => {
    const h = await setup();
    h.element.focus();
    h.element.addEventListener("blur", () => queueMicrotask(() => h.element.focus()));
    expect(await h.run("blur")).toMatchObject({
      code: "cdp_failed",
      message: "target element remained focused after blur()",
    });
    expect(document.activeElement).toBe(h.element);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it.each(["focus", "blur"] as const)("rejects a detached %s target", async (action) => {
    const h = await setup();
    h.element.remove();
    expect(await h.run(action)).toMatchObject({ code: "cdp_failed" });
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("preserves a script exception's cause", async () => {
    const h = await setup();
    vi.spyOn(h.element, "blur").mockImplementation(() => {
      throw new Error("page blur failed");
    });
    expect(await h.run("blur")).toMatchObject({
      code: "cdp_failed",
      message: expect.stringContaining("page blur failed"),
    });
    expect(h.release).toHaveBeenCalledOnce();
  });

  it.each(["focus", "blur"] as const)("rejects malformed %s script results", async (action) => {
    const h = await setup();
    h.script.mockResolvedValueOnce({ result: { value: null } });
    expect(await h.run(action)).toMatchObject({
      code: "cdp_failed",
      message: expect.stringContaining("unexpected result"),
    });
    expect(h.release).toHaveBeenCalledOnce();
  });

  it.each([
    "focus",
    "blur",
  ] as const)("keeps %s, verification and cleanup in the OOPIF session", async (action) => {
    const h = await setup(undefined, true);
    if (action === "blur") h.element.focus();
    expect(await h.run(action)).toMatchObject({ focused: action === "focus" });
    const targetCalls = h.calls.filter((call) => call.method !== "DOM.scrollIntoViewIfNeeded");
    expect(targetCalls.every((call) => call.target.sessionId === "child-session")).toBe(true);
    expect(targetCalls.at(-1)?.method).toBe("Runtime.releaseObject");
  });

  it.each(["focus", "blur"] as const)("rejects %s on a user tab before CDP", async (action) => {
    const h = await setup();
    h.tabsApi.get.mockResolvedValue({ id: 9, windowId: 200, active: true } as chrome.tabs.Tab);
    expect(await h.run(action, undefined, { ref: "e1", tab_id: 9 })).toMatchObject({
      code: "permission_denied",
    });
    expect(h.calls).toEqual([]);
  });

  it("does not replace a successful result when navigation disposed the remote object", async () => {
    const h = await setup();
    h.release.mockRejectedValue(new Error("Cannot find context"));
    expect(await h.run("focus")).toMatchObject({ focused: true });
  });
});

describe("focus and blur cancellation", () => {
  const boundaries = [
    "DOM.getDocument",
    "DOM.querySelector",
    "DOM.describeNode",
    "DOM.resolveNode",
    "Runtime.callFunctionOn",
  ];
  for (const action of ["focus", "blur"] as const) {
    it.each(
      action === "focus" ? [...boundaries, "DOM.scrollIntoViewIfNeeded", "DOM.focus"] : boundaries,
    )(`${action} stops after cancellation during %s`, async (method) => {
      const h = await setup();
      const abort = new AbortController();
      let cancelledAfter = 0;
      h.afterCommand.mockImplementation((call) => {
        if (call.method === method && !abort.signal.aborted) {
          cancelledAfter = h.calls.length;
          abort.abort();
        }
      });
      expect(await h.run(action, abort.signal, { selector: "#target" })).toMatchObject({
        code: "cancelled",
      });
      expect(abort.signal.aborted).toBe(true);
      expect(
        h.calls.slice(cancelledAfter).every((call) => call.method === "Runtime.releaseObject"),
      ).toBe(true);
      if (h.calls.some((call) => call.method === "DOM.resolveNode"))
        expect(h.release).toHaveBeenCalledOnce();
    });

    it(`${action} stops if cancellation arrives while resolving the tab`, async () => {
      const h = await setup();
      const abort = new AbortController();
      h.tabsApi.query.mockImplementation(async () => {
        abort.abort();
        return [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab];
      });
      expect(await h.run(action, abort.signal)).toMatchObject({ code: "cancelled" });
      expect(h.calls).toEqual([]);
    });
  }

  it("does not scroll frame owners after cancellation in an OOPIF", async () => {
    const h = await setup(undefined, true);
    const abort = new AbortController();
    h.afterCommand.mockImplementation((call) => {
      if (call.method === "DOM.scrollIntoViewIfNeeded") abort.abort();
    });
    expect(await h.run("focus", abort.signal)).toMatchObject({ code: "cancelled" });
    expect(h.calls.filter((call) => call.method === "DOM.scrollIntoViewIfNeeded")).toHaveLength(1);
    expect(h.focus).not.toHaveBeenCalled();
  });
});
