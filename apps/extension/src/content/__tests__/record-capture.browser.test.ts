// @vitest-environment node
// Opt in with BSK_RECORD_CHROME; the fixture owns a headless browser and profile.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RecordStepPayload } from "@/lib/record-bridge";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

const chromeExecutable = process.env.BSK_RECORD_CHROME;
let send: Send;
let source: string;
let close: (() => void) | undefined;
let browserRun: Promise<void> | undefined;

if (chromeExecutable) {
  beforeAll(async () => {
    const extensionRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL("../record-capture.ts", import.meta.url))],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      globalName: "RecordCaptureFixture",
      tsconfigRaw: {
        compilerOptions: { baseUrl: extensionRoot, paths: { "@/*": ["src/*"] } },
      },
    });
    source = bundle.outputFiles[0]!.text;
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

interface LabelCase {
  name: string;
  markup?: string;
  setup?: string;
  script?: string;
  target?: string;
  followUpClick?: boolean;
  keyboard?: boolean;
  checked: boolean;
  tags: string[];
}

describe.skipIf(!chromeExecutable)("label activation recording in Chrome", () => {
  it.each<LabelCase>([
    { name: "pointer label", checked: true, tags: ["label"] },
    {
      name: "plain label",
      markup: '<label for="check">Enable updates</label><input id="check" type="checkbox">',
      checked: true,
      tags: ["input"],
    },
    {
      name: "implicit label",
      markup:
        '<label style="cursor:pointer">Enable updates<input id="check" type="checkbox"></label>',
      checked: true,
      tags: ["label"],
    },
    { name: "direct checkbox", target: "#check", checked: true, tags: ["input"] },
    { name: "keyboard checkbox activation", keyboard: true, checked: true, tags: ["input"] },
    {
      name: "later independent checkbox click",
      followUpClick: true,
      checked: false,
      tags: ["label", "input"],
    },
    {
      name: "cancelled label whose handler activates its control",
      setup:
        "document.querySelector('label').addEventListener('click', event => {event.preventDefault(); check.click();});",
      checked: true,
      tags: ["label"],
    },
    {
      name: "cancelled label followed immediately by a checkbox click",
      setup:
        "document.querySelector('label').addEventListener('click', event => event.preventDefault());",
      script: "document.querySelector('label').click(); check.click();",
      checked: true,
      tags: ["label", "input"],
    },
    {
      name: "expired activation when the page disables the control",
      setup:
        "document.querySelector('label').addEventListener('click', () => {check.disabled=true;}, {once:true});",
      script:
        "document.querySelector('label').click(); await new Promise(resolve=>setTimeout(resolve,0)); check.disabled=false; check.click();",
      checked: true,
      tags: ["label", "input"],
    },
    {
      name: "disabled checkbox then enabled and clicked in the same task",
      setup: "check.disabled=true;",
      script: "document.querySelector('label').click(); check.disabled=false; check.click();",
      checked: true,
      tags: ["label", "input"],
    },
    {
      name: "label without an associated control",
      markup:
        '<label for="missing" style="cursor:pointer">Enable updates</label><input id="check" type="checkbox" aria-label="Other">',
      followUpClick: true,
      checked: true,
      tags: ["label", "input"],
    },
    {
      name: "interactive child inside a label",
      markup:
        '<label for="check" style="cursor:pointer">Enable updates <button type="button">Help</button></label><input id="check" type="checkbox">',
      target: "button",
      checked: false,
      tags: ["button"],
    },
    {
      name: "programmatic activation with detail zero",
      script: "document.querySelector('label').click();",
      checked: true,
      tags: ["label"],
    },
    {
      name: "plain programmatic label",
      markup: '<label for="check">Enable updates</label><input id="check" type="checkbox">',
      script: "document.querySelector('label').click();",
      checked: true,
      tags: ["input"],
    },
  ])("records $name once per action", async (fixture: LabelCase) => {
    const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    try {
      const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      const evaluate = async <T>(expression: string): Promise<T> => {
        const result = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true },
          sessionId,
        );
        expect(result.exceptionDetails).toBeUndefined();
        return result.result.value;
      };
      const click = async (selector: string) => {
        const point = await evaluate<{ x: number; y: number }>(`(() => {
          const rect=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
          return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
        })()`);
        for (const type of ["mousePressed", "mouseReleased"]) {
          await send(
            "Input.dispatchMouseEvent",
            { type, ...point, button: "left", clickCount: 1 },
            sessionId,
          );
        }
      };
      const markup =
        fixture.markup ??
        '<label for="check" style="cursor:pointer">Enable updates</label><input id="check" type="checkbox">';
      await evaluate(`document.body.innerHTML=${JSON.stringify(markup)}; ${fixture.setup ?? ""}`);
      await evaluate(source);
      await evaluate(`window.steps=[]; window.events=[];
        document.addEventListener('click', event => events.push({target:event.target.tagName,detail:event.detail,trusted:event.isTrusted}), true);
        window.capture=RecordCaptureFixture.startRecordCapture('label-click',step=>steps.push(step),{captureNavigation:false});`);
      if (fixture.script) await evaluate(`(async () => {${fixture.script}})()`);
      else if (fixture.keyboard) {
        await evaluate("check.focus()");
        for (const type of ["rawKeyDown", "keyUp"]) {
          await send(
            "Input.dispatchKeyEvent",
            { type, key: " ", code: "Space", windowsVirtualKeyCode: 32 },
            sessionId,
          );
        }
      } else await click(fixture.target ?? "label");
      if (fixture.followUpClick) await click("#check");
      const result = await evaluate<{
        checked: boolean;
        steps: RecordStepPayload[];
        events: { target: string; detail: number; trusted: boolean }[];
      }>("capture.dispose(); ({checked:check.checked, steps, events})");
      expect(result.checked).toBe(fixture.checked);
      expect(
        result.steps.filter((step) => step.op === "click").map((step) => step.target?.tag),
      ).toEqual(fixture.tags);
      if (!fixture.script) expect(result.events[0]?.trusted).toBe(true);
      if (fixture.name === "pointer label") {
        expect(result.events.every((event) => event.trusted)).toBe(true);
        expect(result.events.map((event) => [event.target, event.detail])).toEqual([
          ["LABEL", 1],
          ["INPUT", 1],
        ]);
      }
    } finally {
      await send("Target.closeTarget", { targetId });
    }
  });
});
