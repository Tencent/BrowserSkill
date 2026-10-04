// @vitest-environment node
// Opt in with BSK_CLICK_CHROME=/path/to/chrome; each test owns its browser/profile.
import { describe, expect, it } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { handleFill } from "../interaction";
import type { CdpRunner } from "../shared";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

async function withFillBrowser(
  { background, markup }: { background: boolean; markup: string },
  run: (h: {
    evaluate: (expression: string) => Promise<unknown>;
    ref: (expression: string) => Promise<void>;
    fill: (value: string, clearBefore?: boolean) => ReturnType<typeof handleFill>;
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
    { executable: process.env.BSK_CLICK_CHROME, deviceScale: 1, zoom: 1 },
    async (send: Send) => {
      // A background target stays behind the launcher's first page.
      const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
        background,
      });
      const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      if (!background) await send("Page.bringToFront", {}, sessionId);
      const evaluate = async (expression: string) => {
        const reply = await send<{ result: { value: unknown }; exceptionDetails?: unknown }>(
          "Runtime.evaluate",
          { expression, returnByValue: true },
          sessionId,
        );
        expect(reply.exceptionDetails).toBeUndefined();
        return reply.result.value;
      };
      await evaluate(`document.body.innerHTML = ${JSON.stringify(markup)}`);
      expect(await evaluate("document.hasFocus()")).toBe(!background);
      const manager = new SessionManager({
        agentWindow: {
          create: async () => ({ windowId: 100, initialTabIds: [] }),
          remove: async () => {},
          ensureActiveTab: async () => 4,
        },
      });
      const ctx = await manager.start("aa11");
      const cdp: CdpRunner = {
        send: async (_tabId, method, params) => (await send(method, params, sessionId)) as never,
      };
      const deps = {
        cdp,
        tabsApi: {
          get: async (id: number) =>
            ({ id, windowId: 100, active: !background }) as chrome.tabs.Tab,
          query: async () => [{ id: 4, windowId: 100, active: !background } as chrome.tabs.Tab],
        },
      };
      await run({
        evaluate,
        ref: async (expression) => {
          const { result } = await send<{ result: { objectId: string } }>(
            "Runtime.evaluate",
            { expression },
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
        fill: (value, clearBefore) =>
          handleFill(
            manager,
            { session_id: "aa11", ref: "e1", value, clear_before: clearBefore },
            deps,
          ),
      });
    },
  );
}

const editor = (target: string) =>
  `<div id="host" contenteditable="true"><p id="before">first</p>${target}<p id="after">keep</p></div>`;
const paragraphs = `[...document.querySelectorAll('#host > p')].map((p) => p.textContent)`;

describe.skipIf(!process.env.BSK_CLICK_CHROME)("real browser fill of editor paragraphs", () => {
  describe.each([
    ["foreground", false],
    ["background", true],
  ])("in a %s tab", (_mode, background) => {
    describe.each([
      ["a paragraph", '<p id="target">old</p>'],
      ["a focusable paragraph", '<p id="target" tabindex="0">old</p>'],
      ["a span in a paragraph", '<p>a <span id="target">old</span> b</p>'],
    ])("targeting %s", (_name, target) => {
      it("replaces only the target's text", async () => {
        await withFillBrowser({ background, markup: editor(target) }, async (h) => {
          await h.ref("document.querySelector('#target')");
          expect(await h.fill("hello")).toMatchObject({ value_length: 5 });
          expect(await h.evaluate("document.querySelector('#target').textContent")).toBe("hello");
          expect(await h.evaluate(paragraphs)).toEqual(
            target.startsWith("<p>") ? ["first", "a hello b", "keep"] : ["first", "hello", "keep"],
          );
        });
      });

      it("appends to the target's text", async () => {
        await withFillBrowser({ background, markup: editor(target) }, async (h) => {
          await h.ref("document.querySelector('#target')");
          expect(await h.fill("hello", false)).toMatchObject({ value_length: 8 });
          expect(await h.evaluate("document.querySelector('#target').textContent")).toBe(
            "oldhello",
          );
          expect(await h.evaluate(paragraphs)).toEqual(
            target.startsWith("<p>")
              ? ["first", "a oldhello b", "keep"]
              : ["first", "oldhello", "keep"],
          );
        });
      });
    });

    it("clears the target when the value is empty", async () => {
      await withFillBrowser({ background, markup: editor('<p id="target">old</p>') }, async (h) => {
        await h.ref("document.querySelector('#target')");
        expect(await h.fill("")).toMatchObject({ value_length: 0 });
        expect(await h.evaluate(paragraphs)).toEqual(["first", "", "keep"]);
      });
    });

    describe.each([
      ["an empty paragraph", '<p id="target"></p>'],
      ["an empty paragraph holding a break", '<p id="target"><br></p>'],
      ["an empty span in a paragraph", '<p>a <span id="target"></span> b</p>'],
    ])("targeting %s", (_name, target) => {
      it.each([
        ["replace", true],
        ["append", false],
      ])("types into the target, not a sibling (%s)", async (_how, clearBefore) => {
        await withFillBrowser({ background, markup: editor(target) }, async (h) => {
          await h.ref("document.querySelector('#target')");
          expect(await h.fill("hello", clearBefore)).toMatchObject({ value_length: 5 });
          expect(await h.evaluate("document.querySelector('#target').textContent")).toBe("hello");
          expect(await h.evaluate("document.querySelector('#before').textContent")).toBe("first");
          expect(await h.evaluate("document.querySelector('#after').textContent")).toBe("keep");
          expect(await h.evaluate("document.querySelector('#host').textContent")).not.toContain(
            "\u200B",
          );
        });
      });
    });

    it("refills a paragraph it has just cleared", async () => {
      await withFillBrowser({ background, markup: editor('<p id="target">old</p>') }, async (h) => {
        await h.ref("document.querySelector('#target')");
        expect(await h.fill("")).toMatchObject({ value_length: 0 });
        expect(await h.fill("hello")).toMatchObject({ value_length: 5 });
        expect(await h.evaluate(paragraphs)).toEqual(["first", "hello", "keep"]);
        expect(await h.evaluate("document.querySelectorAll('#target').length")).toBe(1);
      });
    });

    it.each([
      ["a multiline replacement", "one\ntwo", true],
      ["a multiline append", "one\ntwo", false],
      ["a trailing newline", "hello\n", true],
      ["a carriage return", "one\r\ntwo", true],
    ])("rejects %s before changing the editor", async (_name, value, clearBefore) => {
      await withFillBrowser({ background, markup: editor('<p id="target">old</p>') }, async (h) => {
        const html = await h.evaluate("document.querySelector('#host').innerHTML");
        await h.ref("document.querySelector('#target')");
        expect(await h.fill(value, clearBefore)).toMatchObject({
          code: "invalid_params",
          data: { reason: "fill_value_invalid" },
        });
        expect(await h.evaluate("document.querySelector('#host').innerHTML")).toBe(html);
      });
    });

    it("still fills a multiline value into the whole editing host", async () => {
      await withFillBrowser({ background, markup: editor('<p id="target">old</p>') }, async (h) => {
        await h.ref("document.querySelector('#host')");
        expect(await h.fill("one\ntwo")).toMatchObject({ value_length: 7 });
      });
    });

    it("still replaces the whole editing host when it is the target", async () => {
      await withFillBrowser({ background, markup: editor('<p id="target">old</p>') }, async (h) => {
        await h.ref("document.querySelector('#host')");
        expect(await h.fill("hello")).toMatchObject({ value_length: 5 });
        expect(await h.evaluate("document.querySelector('#host').innerText")).toBe("hello");
      });
    });

    it("rejects a focusable element outside any editor without moving focus", async () => {
      await withFillBrowser(
        {
          background,
          markup: '<input id="field"><div id="target" tabindex="0">text</div>',
        },
        async (h) => {
          await h.evaluate(`(() => {
            const field = document.querySelector('#field');
            window.blurs = 0;
            field.addEventListener('blur', () => window.blurs++);
            field.focus();
          })()`);
          await h.ref("document.querySelector('#target')");
          expect(await h.fill("hello")).toMatchObject({
            code: "invalid_params",
            data: { reason: "target_not_fillable" },
          });
          expect(await h.evaluate("document.activeElement.id")).toBe("field");
          expect(await h.evaluate("window.blurs")).toBe(0);
          expect(await h.evaluate("document.querySelector('#target').textContent")).toBe("text");
        },
      );
    });
  });
});
