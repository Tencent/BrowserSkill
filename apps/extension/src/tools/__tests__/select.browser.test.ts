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

if (process.env.BSK_SELECT_CHROME) {
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
      { executable: process.env.BSK_SELECT_CHROME, deviceScale: 1, zoom: 1 },
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

describe.skipIf(!process.env.BSK_SELECT_CHROME)("select disabled state in Chrome", () => {
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
