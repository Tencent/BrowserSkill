// @vitest-environment node
// Opt in with BSK_CLICK_CHROME. Uses real input in its own browser/profile.

import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
      stdin: {
        contents: `export {startRecordCapture} from './content/record-capture';
          export {appendRecordedPayload} from './lib/recording/step-buffer';
          export {reduceTraceStepsV3} from './lib/recording/trace-reducer-v3';
          export {readFillableValue} from './lib/fillable-value';`,
        resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
        loader: "ts",
      },
      minify: true,
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

async function withEditor(
  markup: string,
  run: (h: {
    evaluate: <T>(expression: string) => Promise<T>;
    type: (text: string) => Promise<void>;
    clear: () => Promise<void>;
    enter: (shift?: boolean) => Promise<void>;
    finish: () => Promise<string[]>;
  }) => Promise<void>,
) {
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
    await evaluate(`document.body.innerHTML = ${JSON.stringify(`${markup}<button id="done">Done</button>`)};
      ${bundle}
      window.steps = [];
      window.capture = Recording.startRecordCapture('lines', step => window.steps.push(step), {captureNavigation:false});
      document.querySelector('#editor').focus();`);
    await run({
      evaluate,
      clear: async () => {
        for (const key of [
          { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 },
          { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, modifiers: 0 },
        ]) {
          for (const type of ["keyDown", "keyUp"]) {
            await send("Input.dispatchKeyEvent", { type, ...key }, sessionId);
          }
        }
      },
      type: async (text) => {
        await send("Input.insertText", { text }, sessionId);
      },
      enter: async (shift = false) => {
        for (const type of ["keyDown", "keyUp"]) {
          await send(
            "Input.dispatchKeyEvent",
            {
              type,
              key: "Enter",
              code: "Enter",
              windowsVirtualKeyCode: 13,
              modifiers: shift ? 8 : 0,
              ...(type === "keyDown" ? { text: "\r" } : {}),
            },
            sessionId,
          );
        }
      },
      finish: async () => {
        const point = await evaluate<{ x: number; y: number }>(`(() => {
          const r = document.querySelector('#done').getBoundingClientRect();
          return {x:r.x+r.width/2,y:r.y+r.height/2};
        })()`);
        for (const type of ["mousePressed", "mouseReleased"]) {
          await send(
            "Input.dispatchMouseEvent",
            { type, ...point, button: "left", clickCount: 1 },
            sessionId,
          );
        }
        // The state IDs stand in for observation capture. This exercises the real
        // buffer/reducer, not installed-extension transport or state matching.
        return evaluate<string[]>(`window.capture.dispose();
          (() => {
            const buffer = {steps:[],navigation:{pendingNavigation:false}};
            for (const step of window.steps) Recording.appendRecordedPayload(buffer, step);
            const trace = Recording.reduceTraceStepsV3(buffer.steps.map(step => ({...step,preStateId:'before',postStateId:'after'})));
            return trace.steps.filter(step => step.op === 'fill').map(step => step.value);
          })()`);
      },
    });
  } finally {
    await send("Target.closeTarget", { targetId });
  }
}

describe.skipIf(!process.env.BSK_CLICK_CHROME)("record multiline editing in Chrome", () => {
  it.each([
    { name: "Enter", enters: 1, shift: false, last: "Beta", value: "Alpha\nBeta" },
    { name: "Shift+Enter", enters: 1, shift: true, last: "Beta", value: "Alpha\nBeta" },
    { name: "blank line", enters: 2, shift: false, last: "Beta", value: "Alpha\n\nBeta" },
    { name: "trailing newline", enters: 1, shift: false, last: "", value: "Alpha\n" },
  ])("preserves $name in the final trace fill", async ({ enters, shift, last, value }) => {
    await withEditor(
      '<div id="editor" contenteditable="true" aria-label="Editor"></div>',
      async (h) => {
        await h.type("Alpha");
        for (let i = 0; i < enters; i++) await h.enter(shift);
        if (last) await h.type(last);
        expect((await h.finish()).at(-1)).toBe(value);
        // Minified production code must remain safe to serialize into the fill tool.
        expect(
          await h.evaluate(
            `(${await h.evaluate<string>("Recording.readFillableValue.toString()")}).call(document.querySelector('#editor'))`,
          ),
        ).toBe(value);
      },
    );
  });

  it("keeps rich paragraph boundaries and the serialized reader agrees", async () => {
    await withEditor(
      '<div id="editor" contenteditable="true" aria-label="Editor"><p>Alpha <b>bold</b></p><p>Beta</p></div>',
      async (h) => {
        await h.type("New ");
        const rendered = await h.evaluate<string>("document.querySelector('#editor').innerText");
        expect(rendered).toContain("\n");
        expect(await h.finish()).toEqual([rendered]);
        expect(
          await h.evaluate(
            `(${await h.evaluate<string>("Recording.readFillableValue.toString()")}).call(document.querySelector('#editor'))`,
          ),
        ).toBe(rendered);
      },
    );
  });

  it.each([
    "true",
    "plaintext-only",
  ])("records pasted newlines in contenteditable=%s", async (mode) => {
    await withEditor(
      `<div id="editor" contenteditable="${mode}" aria-label="Editor" style="white-space:pre-wrap"></div>`,
      async (h) => {
        await h.type(" Alpha\n\nBeta ");
        expect(await h.finish()).toEqual([" Alpha\n\nBeta "]);
      },
    );
  });

  it("keeps textarea values and masks sensitive editable values", async () => {
    await withEditor('<textarea id="editor" aria-label="Editor"></textarea>', async (h) => {
      await h.type("Alpha\nBeta");
      expect(await h.finish()).toEqual(["Alpha\nBeta"]);
    });
    await withEditor(
      '<div id="editor" contenteditable="true" aria-label="Editor" autocomplete="one-time-code"></div>',
      async (h) => {
        await h.type("123\n456");
        expect(await h.finish()).toEqual(["***"]);
      },
    );
  });

  it("does not record a fill just from focusing an empty placeholder", async () => {
    await withEditor(
      '<div id="editor" contenteditable="true" aria-label="Editor"><br></div>',
      async (h) => {
        expect(await h.finish()).toEqual([]);
      },
    );
  });

  it("records an empty value after clearing an editor", async () => {
    await withEditor(
      '<div id="editor" contenteditable="true" aria-label="Editor">before</div>',
      async (h) => {
        await h.clear();
        expect(await h.finish()).toEqual([""]);
      },
    );
  });
});
