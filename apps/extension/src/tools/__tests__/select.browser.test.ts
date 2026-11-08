// @vitest-environment node
// Opt in with BSK_SELECT_CHROME; the fixture owns a headless browser and profile.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { handleSelect } from "../interaction";
import type { CdpRunner } from "../shared";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

let send: Send;
let close: (() => void) | undefined;
let browserRun: Promise<void> | undefined;
const chromeExecutable = process.env.BSK_SELECT_CHROME;

if (chromeExecutable) {
  beforeAll(async () => {
    const { withChrome } = await import(
      new URL(
        "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
        import.meta.url,
      ).href
    );
    const ready = Promise.withResolvers<Send>();
    const closed = Promise.withResolvers<void>();
    close = () => closed.resolve();
    browserRun = withChrome(
      { executable: chromeExecutable, deviceScale: 1, zoom: 1 },
      async (command: Send) => {
        ready.resolve(command);
        await closed.promise;
      },
    );
    browserRun!.catch(ready.reject);
    send = await ready.promise;
  }, 30_000);
  afterAll(async () => {
    close?.();
    await browserRun;
  }, 30_000);
}

describe.skipIf(!chromeExecutable)("select disabled state in Chrome", () => {
  it.each([
    { name: "directly disabled", markup: "<select disabled></select>", disabled: true },
    {
      name: "disabled fieldset",
      markup: "<fieldset disabled><select></select></fieldset>",
      disabled: true,
    },
    {
      name: "first legend exception",
      markup: "<fieldset disabled><legend><select></select></legend></fieldset>",
      disabled: false,
    },
    {
      name: "second legend",
      markup:
        "<fieldset disabled><legend>First</legend><legend><select></select></legend></fieldset>",
      disabled: true,
    },
    {
      name: "disabled by focus handler",
      markup: '<select onfocus="this.disabled=true"></select>',
      disabled: true,
      focusDisables: true,
    },
    {
      name: "fieldset disabled by focus handler",
      markup: '<fieldset><select onfocus="this.parentElement.disabled=true"></select></fieldset>',
      disabled: true,
      focusDisables: true,
    },
    { name: "enabled", markup: "<select></select>", disabled: false },
  ])("respects $name", async ({ markup, disabled, focusDisables }) => {
    const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    try {
      const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      const evaluate = async (expression: string) => {
        const reply = await send<{ result: { value: unknown }; exceptionDetails?: unknown }>(
          "Runtime.evaluate",
          { expression, returnByValue: true },
          sessionId,
        );
        expect(reply.exceptionDetails).toBeUndefined();
        return reply.result.value;
      };
      await evaluate(`document.body.innerHTML = ${JSON.stringify(markup)};
        const select = document.querySelector('select');
        select.innerHTML = '<option value="us">United States</option><option value="ca">Canada</option>';
        window.events = [];
        for (const type of ['input', 'change']) select.addEventListener(type, () => window.events.push(type));`);
      const manager = new SessionManager({
        agentWindow: {
          create: async () => ({ windowId: 100, initialTabIds: [] }),
          remove: async () => {},
          ensureActiveTab: async () => 4,
        },
      });
      await manager.start("aa11");
      const cdp: CdpRunner = {
        send: async (_tabId, method, params) => send(method, params, sessionId) as never,
      };
      const result = await handleSelect(
        manager,
        {
          session_id: "aa11",
          selector: "select",
          values: ["ca"],
        },
        {
          cdp,
          tabsApi: {
            get: async (id) => ({ id, windowId: 100, active: true }) as chrome.tabs.Tab,
            query: async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab],
          },
        },
      );
      expect(result).toMatchObject(
        disabled
          ? focusDisables
            ? { code: "invalid_params", message: "select requires an enabled <select>" }
            : { code: "cdp_failed" }
          : { selected_values: ["ca"] },
      );
      expect(
        await evaluate(
          "({ value: document.querySelector('select').value, events: window.events })",
        ),
      ).toEqual({ value: disabled ? "us" : "ca", events: disabled ? [] : ["input", "change"] });
    } finally {
      await send("Target.closeTarget", { targetId });
    }
  });
});

describe.skipIf(!chromeExecutable)("select target lifetime in Chrome", () => {
  it.each([
    ["unchanged", false],
    ["replaced during focus", true],
    ["removed during focus", true],
    ["adopted during focus", true],
    ["adopted during scrolling", true],
    ["moved within the document", false],
    ["shadow root", false],
    ["iframe", false],
  ] as const)(
    "handles a select %s",
    async (mode: string, stale: boolean) => {
      const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
      });
      try {
        const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
          targetId,
          flatten: true,
        });
        const evaluate = async (expression: string) => {
          const reply = await send<{ result: { value: unknown }; exceptionDetails?: unknown }>(
            "Runtime.evaluate",
            { expression, returnByValue: true },
            sessionId,
          );
          expect(reply.exceptionDetails).toBeUndefined();
          return reply.result.value;
        };
        await evaluate(`(() => {
        const mode = ${JSON.stringify(mode)};
        document.body.innerHTML = '<div id="container"></div><iframe></iframe>';
        let root = document.querySelector('#container');
        if (mode === 'shadow root') root = root.attachShadow({mode:'open'});
        if (mode === 'iframe') root = document.querySelector('iframe').contentDocument.body;
        root.innerHTML = '<select><option value="a">Alpha</option><option value="b">Beta</option></select>';
        const select = root.querySelector('select');
        window.oldSelect = select;
        window.originalOwner = select.ownerDocument;
        window.liveRoot = root;
        window.events = [];
        for (const type of ['input', 'change']) select.addEventListener(type, () => window.events.push(type));
        select.addEventListener('focus', () => {
          if (mode === 'replaced during focus') select.replaceWith(select.cloneNode(true));
          if (mode === 'removed during focus') select.remove();
          if (mode === 'adopted during focus') document.querySelector('iframe').contentDocument.body.append(select);
          if (mode === 'moved within the document') document.body.append(select);
        }, {once:true});
      })()`);
        const { result } = await send<{ result: { objectId: string } }>(
          "Runtime.evaluate",
          { expression: "window.oldSelect" },
          sessionId,
        );
        const { node } = await send<{ node: { backendNodeId: number } }>(
          "DOM.describeNode",
          { objectId: result.objectId },
          sessionId,
        );
        await send("Runtime.releaseObject", { objectId: result.objectId }, sessionId);
        const manager = new SessionManager({
          agentWindow: {
            create: async () => ({ windowId: 100, initialTabIds: [] }),
            remove: async () => {},
            ensureActiveTab: async () => 4,
          },
        });
        const ctx = await manager.start("aa11");
        ctx.refStore.set("e1", node.backendNodeId, { tabId: 4 });
        const cdp: CdpRunner = {
          send: async (_tabId, method, params) => {
            const result = await send(method, params, sessionId);
            // A scroll callback can adopt the node before the caller resumes.
            if (mode === "adopted during scrolling" && method === "DOM.scrollIntoViewIfNeeded")
              await evaluate(
                "document.querySelector('iframe').contentDocument.body.append(window.oldSelect)",
              );
            return result as never;
          },
        };
        const reply = await handleSelect(
          manager,
          { session_id: "aa11", ref: "e1", values: ["b"] },
          {
            cdp,
            tabsApi: {
              get: async (id) => ({ id, windowId: 100, active: true }) as chrome.tabs.Tab,
              query: async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab],
            },
          },
        );
        const state = await evaluate(`({
        oldValue: window.oldSelect.value,
        connected: window.oldSelect.isConnected,
        sameDocument: window.oldSelect.ownerDocument === window.originalOwner,
        liveValue: window.liveRoot.querySelector('select')?.value,
        events: window.events
      })`);
        expect(reply, JSON.stringify({ mode, reply, state })).toMatchObject(
          stale
            ? { code: "cdp_failed", data: { reason: "target_detached", effect_state: "none" } }
            : { selected_values: ["b"] },
        );
        expect(state).toMatchObject({
          oldValue: stale ? "a" : "b",
          events: stale ? [] : ["input", "change"],
        });
        if (mode === "replaced during focus")
          expect(state).toMatchObject({ connected: false, liveValue: "a" });
        if (mode.startsWith("adopted"))
          expect(state).toMatchObject({ connected: true, sameDocument: false });
      } finally {
        await send("Target.closeTarget", { targetId });
      }
    },
    30_000,
  );
});
