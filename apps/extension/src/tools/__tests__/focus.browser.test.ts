// @vitest-environment node
// Opt in with BSK_FOCUS_CHROME=/path/to/chrome; each test owns its browser/profile.
import { describe, expect, it } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { handleBlur, handleFocus } from "../interaction";
import type { CdpRunner } from "../shared";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

async function withFocusBrowser(
  run: (h: {
    evaluate: (expression: string) => Promise<unknown>;
    ref: () => Promise<void>;
    focus: (signal?: AbortSignal) => ReturnType<typeof handleFocus>;
    blur: (signal?: AbortSignal) => ReturnType<typeof handleBlur>;
    calls: string[];
    afterCommand: { current: (method: string) => void };
  }) => Promise<void>,
) {
  // Reuse the existing isolated Chrome launcher; no new browser dependency.
  const { withChrome } = await import(
    new URL(
      "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
      import.meta.url,
    ).href
  );
  await withChrome(
    { executable: process.env.BSK_FOCUS_CHROME, deviceScale: 1, zoom: 1 },
    async (send: Send) => {
      const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
      });
      const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      await send("Page.bringToFront", {}, sessionId);
      const evaluate = async (expression: string) => {
        const reply = await send<{ result: { value: unknown }; exceptionDetails?: unknown }>(
          "Runtime.evaluate",
          { expression, returnByValue: true },
          sessionId,
        );
        expect(reply.exceptionDetails).toBeUndefined();
        return reply.result.value;
      };
      await evaluate(
        `document.body.innerHTML = '<input id="target"><input id="other">'; window.probe = document.querySelector('#target');`,
      );
      const manager = new SessionManager({
        agentWindow: {
          create: async () => 100,
          remove: async () => {},
          ensureActiveTab: async () => 4,
        },
      });
      const ctx = await manager.start("aa11");
      const calls: string[] = [];
      const afterCommand = { current: (_method: string) => {} };
      const cdp: CdpRunner = {
        send: async (_tabId, method, params) => {
          calls.push(method);
          const result = await send(method, params, sessionId);
          afterCommand.current(method);
          return result as never;
        },
      };
      const deps = {
        cdp,
        tabsApi: {
          get: async (id: number) => ({ id, windowId: 100, active: true }) as chrome.tabs.Tab,
          query: async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab],
        },
      };
      await run({
        evaluate,
        calls,
        afterCommand,
        ref: async () => {
          const { result } = await send<{ result: { objectId: string } }>(
            "Runtime.evaluate",
            { expression: "window.probe" },
            sessionId,
          );
          const { node } = await send<{ node: { backendNodeId: number } }>(
            "DOM.describeNode",
            { objectId: result.objectId },
            sessionId,
          );
          await send("Runtime.releaseObject", { objectId: result.objectId }, sessionId);
          ctx.refStore.set("e1", node.backendNodeId, { tabId: 4 });
        },
        focus: (signal) =>
          handleFocus(manager, { session_id: "aa11", ref: "e1" }, { ...deps, signal }),
        blur: (signal) =>
          handleBlur(manager, { session_id: "aa11", ref: "e1" }, { ...deps, signal }),
      });
    },
  );
}

describe.skipIf(!process.env.BSK_FOCUS_CHROME)("real browser focus and blur", () => {
  it.each(["light", "open", "closed"])("verifies focus and blur in %s DOM", async (mode) => {
    await withFocusBrowser(async (h) => {
      if (mode !== "light")
        await h.evaluate(`(() => {
        const host = document.createElement('div'); document.body.append(host);
        const nested = document.createElement('div'); host.attachShadow({mode:'${mode}'}).append(nested);
        const input = document.createElement('input'); nested.attachShadow({mode:'${mode}'}).append(input);
        window.probe = input;
      })()`);
      await h.ref();
      expect(await h.focus()).toMatchObject({ focused: true });
      expect(await h.evaluate("window.probe.matches(':focus')")).toBe(true);
      expect(await h.blur()).toMatchObject({ was_focused: true, focused: false });
      expect(await h.evaluate("window.probe.matches(':focus')")).toBe(false);
      expect(h.calls.filter((method) => method === "Runtime.releaseObject")).toHaveLength(2);
    });
  });

  it("detects focus changes from event-handler microtasks", async () => {
    await withFocusBrowser(async (h) => {
      await h.ref();
      await h.evaluate(
        "window.probe.addEventListener('focus', () => queueMicrotask(() => document.querySelector('#other').focus()), {once:true})",
      );
      expect(await h.focus()).toMatchObject({ code: "cdp_failed" });
      expect(await h.focus()).toMatchObject({ focused: true });
      await h.evaluate(
        "window.probe.addEventListener('blur', () => queueMicrotask(() => window.probe.focus()), {once:true})",
      );
      expect(await h.blur()).toMatchObject({ code: "cdp_failed" });
      expect(await h.evaluate("window.probe.matches(':focus')")).toBe(true);
    });
  });

  it("cancels before blur while still releasing the resolved object", async () => {
    await withFocusBrowser(async (h) => {
      await h.ref();
      await h.focus();
      const abort = new AbortController();
      h.afterCommand.current = (method) => {
        if (method === "DOM.resolveNode") abort.abort();
      };
      expect(await h.blur(abort.signal)).toMatchObject({ code: "cancelled" });
      expect(await h.evaluate("window.probe.matches(':focus')")).toBe(true);
      expect(h.calls.at(-1)).toBe("Runtime.releaseObject");
    });
  });

  it("reports a page exception with its cause", async () => {
    await withFocusBrowser(async (h) => {
      await h.ref();
      await h.evaluate("window.probe.blur = () => { throw new Error('page blur failed'); }");
      expect(await h.blur()).toMatchObject({
        code: "cdp_failed",
        message: expect.stringContaining("page blur failed"),
      });
      expect(h.calls.at(-1)).toBe("Runtime.releaseObject");
    });
  });
});
