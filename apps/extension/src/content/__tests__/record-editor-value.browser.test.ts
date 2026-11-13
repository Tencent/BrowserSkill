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

interface Helpers {
  click: (selector: string) => Promise<void>;
  insert: (text: string) => Promise<void>;
  enter: (shift?: boolean) => Promise<void>;
}

/** Records one editing session on a fresh tab and returns its emitted steps. */
async function recordEditor(
  markup: string,
  edit: (helpers: Helpers) => Promise<void>,
): Promise<{ steps: RecordStepPayload[]; html: string; inner: string }> {
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
    const insert = (text: string) => send("Input.insertText", { text }, sessionId);
    const enter = async (shift = false) => {
      const key = {
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      };
      const modifiers = shift ? 8 : 0;
      await send(
        "Input.dispatchKeyEvent",
        { type: "keyDown", ...key, modifiers, text: "\r" },
        sessionId,
      );
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...key, modifiers }, sessionId);
    };
    await evaluate(`document.body.innerHTML = ${JSON.stringify(markup)};
      ${bundle}
      window.steps = [];
      window.capture = Recording.startRecordCapture('editor', step => window.steps.push(step), {captureNavigation:false});`);
    await edit({ click, insert, enter });
    return await evaluate(
      `window.capture.dispose(); ({steps:window.steps,
        html:document.querySelector('#editor').innerHTML,
        inner:document.querySelector('#editor').innerText})`,
    );
  } finally {
    await send("Target.closeTarget", { targetId });
  }
}

const editor = '<div id="editor" contenteditable="true" aria-label="Editor"></div>';

/** The last fill step, which carries the value at the end of the session. */
function finalValue(steps: RecordStepPayload[]) {
  return steps.filter((step) => step.op === "fill").at(-1)?.value;
}

describe.skipIf(!process.env.BSK_CLICK_CHROME)("record contenteditable values", () => {
  it("keeps the line break that Enter inserts between two typed lines", async () => {
    const result = await recordEditor(editor, async (h) => {
      await h.click("#editor");
      await h.insert("Alpha");
      await h.enter();
      await h.insert("Beta");
    });

    expect(result.html).toBe("Alpha<div>Beta</div>");
    expect(result.steps.map((step) => step.op)).toEqual(["fill", "press", "fill"]);
    expect(result.steps[0]).toMatchObject({ target: { name: "Editor" }, value: "Alpha" });
    expect(finalValue(result.steps)).toBe("Alpha\nBeta");
  });

  it("keeps the line break that Shift+Enter inserts", async () => {
    const result = await recordEditor(editor, async (h) => {
      await h.click("#editor");
      await h.insert("Alpha");
      await h.enter(true);
      await h.insert("Beta");
    });

    expect(finalValue(result.steps)).toBe("Alpha\nBeta");
  });

  it("keeps an empty line between two typed lines", async () => {
    const result = await recordEditor(editor, async (h) => {
      await h.click("#editor");
      await h.insert("Alpha");
      await h.enter();
      await h.enter();
      await h.insert("Beta");
    });

    expect(finalValue(result.steps)).toBe("Alpha\n\nBeta");
  });

  it("keeps a trailing empty line and the whitespace a pre-wrap editor displays", async () => {
    const result = await recordEditor(
      '<div id="editor" contenteditable="true" aria-label="Editor" style="white-space: pre-wrap"></div>',
      async (h) => {
        await h.click("#editor");
        await h.insert("  Alpha  ");
        await h.enter();
      },
    );

    expect(finalValue(result.steps)).toBe("  Alpha  \n");
  });

  it("reads a rich editor as rendered text", async () => {
    const result = await recordEditor(
      '<div id="editor" contenteditable="true" aria-label="Editor"><p>One</p><p>Two</p></div>',
      async (h) => {
        await h.click("#editor p:last-child");
        await h.insert("!");
      },
    );

    // Paragraphs render with a margin, so the rendered text separates them twice.
    expect(result.inner).toBe("One\n\nTwo!");
    expect(finalValue(result.steps)).toBe(result.inner);
  });

  it("keeps a typed edge space as a space instead of the non-breaking space Chrome types", async () => {
    const result = await recordEditor(editor, async (h) => {
      await h.click("#editor");
      await h.insert("  Alpha  ");
    });

    // Chrome types a space at a line edge as U+00A0; the trace must not carry it.
    expect(result.html).toContain("&nbsp;");
    expect(finalValue(result.steps)).toBe("  Alpha  ");
    expect([...finalValue(result.steps)!].some((char) => char.codePointAt(0) === 0xa0)).toBe(false);
  });
});
