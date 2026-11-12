// @vitest-environment node
// Opt in with BSK_CLICK_CHROME. Uses real input in its own browser/profile.

import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RecordStepPayload } from "@/lib/record-bridge";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

let send: Send;
let bundle: string;
let close: (() => void) | undefined;
let browserRun: Promise<void> | undefined;

if (process.env.BSK_CLICK_CHROME) {
  beforeAll(async () => {
    const built = await build({
      entryPoints: [fileURLToPath(new URL("../record-capture.ts", import.meta.url))],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "Recording",
      platform: "browser",
    });
    bundle = built.outputFiles[0].text;
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
      { executable: process.env.BSK_CLICK_CHROME, deviceScale: 1, zoom: 1 },
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

const buttons = [
  { markup: '<input id="action" type="submit" value="Submit">', name: "Submit", event: "submit" },
  { markup: '<input id="action" type="reset" value="Reset">', name: "Reset", event: "reset" },
  {
    markup: '<input id="action" type="image" alt="Send image" style="width:80px;height:30px">',
    name: "Send image",
    event: "submit",
  },
  { markup: '<input id="action" type="button" value="Action">', name: "Action" },
  {
    markup: '<button id="action" type="submit"><span>Submit</span></button>',
    name: "Submit",
    event: "submit",
  },
];

describe.skipIf(!process.env.BSK_CLICK_CHROME)("record native form buttons", () => {
  for (const search of [false, true]) {
    it.each(buttons)(`records $name with search field=${search}`, async ({
      markup,
      name,
      event,
    }) => {
      const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
      });
      try {
        const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
          targetId,
          flatten: true,
        });
        const evaluate = async <T>(expression: string): Promise<T> => {
          const reply = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
            "Runtime.evaluate",
            { expression, returnByValue: true },
            sessionId,
          );
          expect(reply.exceptionDetails).toBeUndefined();
          return reply.result.value;
        };
        const click = async (selector: string) => {
          const point = await evaluate<{ x: number; y: number }>(`(() => {
            const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
            return {x:r.x+r.width/2,y:r.y+r.height/2};
          })()`);
          for (const type of ["mousePressed", "mouseReleased"]) {
            await send(
              "Input.dispatchMouseEvent",
              { type, ...point, button: "left", clickCount: 1 },
              sessionId,
            );
          }
        };
        await evaluate(`document.body.innerHTML = ${JSON.stringify(`<form><input id="field" ${search ? 'type="search" name="q"' : 'name="field"'} aria-label="Field" value="initial">${markup}</form>`)};
          ${bundle}
          window.steps = []; window.events = [];
          const form = document.querySelector('form');
          for (const type of ['submit', 'reset']) form.addEventListener(type, event => {
            if (type === 'submit') event.preventDefault();
            window.events.push(type);
          });
          document.querySelector('#action').addEventListener('click', event => window.events.push(event.isTrusted ? 'click' : 'synthetic'));
          window.capture = Recording.startRecordCapture('buttons', step => window.steps.push(step), {captureNavigation:false});`);
        await click("#field");
        await send("Input.insertText", { text: " edited" }, sessionId);
        const edited = await evaluate<string>("document.querySelector('#field').value");
        await click("#action");
        const result = await evaluate<{
          steps: RecordStepPayload[];
          events: string[];
          value: string;
        }>(
          "window.capture.dispose(); ({steps:window.steps,events:window.events,value:document.querySelector('#field').value})",
        );
        expect(result.events).toEqual(event ? ["click", event] : ["click"]);
        expect(result.steps.map((step) => step.op)).toEqual(["fill", "click"]);
        expect(result.steps[0]).toMatchObject({ value: edited, target: { name: "Field" } });
        expect(result.steps[1]).toMatchObject({ target: { role: "button", name } });
        expect(result.value).toBe(event === "reset" ? "initial" : edited);
      } finally {
        await send("Target.closeTarget", { targetId });
      }
    });
  }
});
