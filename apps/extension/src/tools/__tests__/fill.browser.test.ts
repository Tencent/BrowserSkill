// @vitest-environment node
// Opt in with BSK_FILL_CHROME=/path/to/chrome; the suite owns its browser/profile and each test gets a fresh tab.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CdpFrame } from "@/browser-driver/frame-graph";
import { SessionManager } from "@/session-manager/manager";
import { handleFill } from "../interaction";
import { handleObserve } from "../observation";
import type { CdpRunner } from "../shared";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

let browserSend: Send;
let closeBrowser: (() => void) | undefined;
let browserRun: Promise<void> | undefined;

if (process.env.BSK_FILL_CHROME) {
  beforeAll(async () => {
    const { withChrome } = await import(
      new URL(
        "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
        import.meta.url,
      ).href
    );
    const ready = Promise.withResolvers<Send>();
    const closed = Promise.withResolvers<void>();
    closeBrowser = () => closed.resolve();
    browserRun = withChrome(
      { executable: process.env.BSK_FILL_CHROME, deviceScale: 1, zoom: 1 },
      async (send: Send) => {
        ready.resolve(send);
        await closed.promise;
      },
    );
    browserRun!.catch(ready.reject);
    browserSend = await ready.promise;
  }, 30_000);
  afterAll(async () => {
    closeBrowser?.();
    await browserRun;
  }, 30_000);
}

async function withFillBrowser(
  { background, markup }: { background: boolean; markup: string },
  run: (h: {
    evaluate: (expression: string) => Promise<unknown>;
    ref: (expression: string) => Promise<void>;
    fill: (
      value: string,
      clearBefore?: boolean,
      signal?: AbortSignal,
      selector?: string,
      ref?: string,
    ) => ReturnType<typeof handleFill>;
    afterCommand: (hook: (method: string, params?: object) => void | Promise<void>) => void;
    calls: string[];
    observe: () => ReturnType<typeof handleObserve>;
  }) => Promise<void>,
) {
  const send = browserSend;
  // Closing each target restores the launcher's blank foreground page.
  const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
    url: "about:blank",
    background,
  });
  try {
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
    const calls: string[] = [];
    let afterCommand: ((method: string, params?: object) => void | Promise<void>) | undefined;
    const cdp: CdpRunner = {
      send: async (_tabId, method, params) => {
        calls.push(method);
        const result = await send(method, params, sessionId);
        await afterCommand?.(method, params);
        return result as never;
      },
    };
    cdp.sendToTarget = (_target, method, params) => cdp.send(4, method, params);
    cdp.getAttachmentId = () => sessionId;
    cdp.getFrameGraph = async () => {
      type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] };
      const { frameTree } = await send<{ frameTree: FrameTree }>(
        "Page.getFrameTree",
        {},
        sessionId,
      );
      const frames: CdpFrame[] = [];
      const visit = async (tree: FrameTree, parentFrameId?: string) => {
        const owner = parentFrameId
          ? await send<{ backendNodeId: number }>(
              "DOM.getFrameOwner",
              { frameId: tree.frame.id },
              sessionId,
            )
          : undefined;
        frames.push({
          frameId: tree.frame.id,
          parentFrameId,
          target: { tabId: 4 },
          ownerBackendNodeId: owner?.backendNodeId,
        });
        for (const child of tree.childFrames ?? []) await visit(child, tree.frame.id);
      };
      await visit(frameTree);
      return { rootFrameId: frameTree.frame.id, frames };
    };
    const deps = {
      cdp,
      tabsApi: {
        get: async (id: number) => ({ id, windowId: 100, active: !background }) as chrome.tabs.Tab,
        query: async () => [{ id: 4, windowId: 100, active: !background } as chrome.tabs.Tab],
      },
    };
    await run({
      evaluate,
      calls,
      observe: () =>
        handleObserve(manager, { session_id: "aa11" }, { ...deps, conditionalSurfaceProbe: false }),
      afterCommand: (hook) => {
        afterCommand = hook;
      },
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
      fill: (value, clearBefore, signal, selector, ref = "e1") =>
        handleFill(
          manager,
          {
            session_id: "aa11",
            ...(selector ? { selector } : { ref }),
            value,
            clear_before: clearBefore,
          },
          { ...deps, signal },
        ),
    });
  } finally {
    await send("Target.closeTarget", { targetId });
  }
}

const { acceptedTargets, rejectedTargets, editorMarkup } = await import(
  new URL(
    "../../../../../evals/browser/cases/regression/fill-editor-roots/fill-editor-roots.fixture.mjs",
    import.meta.url,
  ).href
);

type AcceptedTarget = { name: string; markup: string; steps: [string, boolean, string, string?][] };
type RejectedTarget = { name: string; markup: string };
const guard = '<input id="guard" value="untouched"><p id="outside">outside text</p>';
const outsideTarget = `(() => {
  const body = document.body.cloneNode(true);
  body.querySelector('#target').replaceWith(document.createComment('fill target'));
  return body.innerHTML;
})()`;

const unchangedState = `JSON.stringify({
  html: document.body.innerHTML,
  focus: document.activeElement.id,
  selection: [document.querySelector('#guard').selectionStart, document.querySelector('#guard').selectionEnd],
  scroll: [scrollX, scrollY], events: window.fillEvents
})`;

describe.skipIf(!process.env.BSK_FILL_CHROME)("native controls and editing hosts", () => {
  describe.each([
    ["foreground", false],
    ["background", true],
  ] as const)("%s", (_name, background) => {
    it.each(acceptedTargets as AcceptedTarget[])("fills $name", async ({ markup, steps }) => {
      await withFillBrowser({ background, markup: guard + markup }, async (h) => {
        await h.ref("document.querySelector('#target')");
        const outsideBefore = await h.evaluate(outsideTarget);
        for (const [value, clearBefore, expected, domText] of steps) {
          const result = await h.fill(value, clearBefore);
          expect(
            result,
            JSON.stringify({
              value,
              state: await h.evaluate(
                "({ html: document.querySelector('#target').innerHTML, text: document.querySelector('#target').innerText, content: document.querySelector('#target').textContent })",
              ),
            }),
          ).toMatchObject({ value_length: expected.length });
          expect(await h.evaluate(outsideTarget)).toBe(outsideBefore);
          // innerText exposes line breaks introduced by browser editing, while
          // textContent preserves invisible characters that cleanup must not erase.
          const actual = await h.evaluate(`(() => {
            const t = document.querySelector('#target');
            if (t.matches('input,textarea')) return t.value;
            const selection = document.getSelection();
            selection.selectAllChildren(t);
            const selected = selection.toString();
            selection.removeAllRanges();
            return { text: t.innerText, content: t.textContent, selected };
          })()`);
          if (typeof actual === "string") expect(actual).toBe(expected);
          else {
            const { content, selected } = actual as { content: string; selected: string };
            if (domText !== undefined) expect(content).toBe(domText);
            else expect(selected).toBe(expected);
            if (expected === "\u200b") expect(content).toBe(expected);
          }
          expect(await h.evaluate("document.querySelector('#guard').value")).toBe("untouched");
          expect(await h.evaluate("document.querySelector('#outside').textContent")).toBe(
            "outside text",
          );
        }
      });
    }, 30_000);

    it.each(rejectedTargets as RejectedTarget[])("rejects $name without side effects", async ({
      markup,
    }) => {
      await withFillBrowser(
        { background, markup: guard + '<div style="height:1800px"></div>' + markup },
        async (h) => {
          await h.ref("document.querySelector('#target')");
          await h.evaluate(`document.querySelector('#guard').focus(); document.querySelector('#guard').setSelectionRange(1, 3);
          window.fillEvents = []; for (const type of ['focus', 'blur', 'input', 'change']) document.addEventListener(type, e => window.fillEvents.push([type, e.target.id]), true);`);
          const before = await h.evaluate(unchangedState);
          for (const [value, clearBefore] of [
            ["hello", true],
            ["", true],
            ["hello", false],
          ] as const) {
            expect(await h.fill(value, clearBefore)).toMatchObject({
              code: "invalid_params",
              data: { reason: "target_not_fillable" },
            });
            expect(await h.evaluate(unchangedState)).toBe(before);
          }
          expect(h.calls).not.toContain("DOM.focus");
          expect(h.calls).not.toContain("DOM.scrollIntoViewIfNeeded");
          expect(h.calls).not.toContain("Input.insertText");
        },
      );
    }, 30_000);

    it.each([
      ['<input id="target" type="number" value="12">', "invalid"],
      ['<input id="target" maxlength="3" value="old">', "longer"],
    ])(
      "rejects invalid values before focus: %s",
      async (markup, value) => {
        await withFillBrowser({ background, markup: guard + markup }, async (h) => {
          await h.ref("document.querySelector('#target')");
          await h.evaluate("document.querySelector('#guard').focus(); window.fillEvents = []");
          const before = await h.evaluate(unchangedState);
          expect(await h.fill(value)).toMatchObject({
            code: "invalid_params",
            data: { reason: "fill_value_invalid" },
          });
          expect(await h.evaluate(unchangedState)).toBe(before);
          expect(h.calls).not.toContain("DOM.focus");
        });
      },
      30_000,
    );

    it("uses the same contract for selectors", async () => {
      await withFillBrowser({ background, markup: editorMarkup }, async (h) => {
        expect(await h.fill("hello", true, undefined, "#paragraph")).toMatchObject({
          data: { reason: "target_not_fillable" },
        });
        expect(await h.fill("hello", true, undefined, "#editor")).toMatchObject({
          value_length: 5,
        });
        expect(await h.evaluate("document.querySelector('#editor').textContent")).toBe("hello");
      });
    }, 30_000);
  });
});

describe.skipIf(!process.env.BSK_FILL_CHROME)("fill lifecycle and discoverability", () => {
  it.each([
    "",
    "true",
    "plaintext-only",
  ])("fills the editor ref from observation: %s", async (attribute) => {
    await withFillBrowser(
      {
        background: false,
        markup: editorMarkup.replace(
          "contenteditable aria-label",
          `contenteditable="${attribute}" aria-label`,
        ),
      },
      async (h) => {
        const observation = await h.observe();
        expect(observation).not.toHaveProperty("code");
        if (!("text" in observation)) throw new Error("observation failed");
        const ref = observation.text.match(/(@e\d+) textbox "Message editor"/)?.[1];
        expect(ref, observation.text).toBeDefined();
        expect(await h.fill("from observation", true, undefined, undefined, ref)).toMatchObject({
          value_length: 16,
        });
        expect(await h.evaluate("document.querySelector('#editor').textContent")).toBe(
          "from observation",
        );
      },
    );
  }, 30_000);

  it.each(["iframe", "shadow"])("fills roots and rejects descendants in %s", async (kind) => {
    await withFillBrowser(
      { background: false, markup: guard + '<div id="container"></div>' },
      async (h) => {
        const markup =
          '<div id="editor" contenteditable="true">old<p id="paragraph">keep</p></div>';
        const root =
          kind === "iframe"
            ? "document.querySelector('iframe').contentDocument"
            : "document.querySelector('#container').shadowRoot";
        await h.evaluate(
          kind === "iframe"
            ? `(() => { const f = document.createElement('iframe'); document.body.append(f); f.contentDocument.body.innerHTML = ${JSON.stringify(markup)}; })()`
            : `document.querySelector('#container').attachShadow({mode:'open'}).innerHTML = ${JSON.stringify(markup)}`,
        );
        await h.ref(`${root}.querySelector('#paragraph')`);
        const before = await h.evaluate(`${root}.querySelector('#editor').innerHTML`);
        expect(await h.fill("wrong")).toMatchObject({ data: { reason: "target_not_fillable" } });
        expect(await h.evaluate(`${root}.querySelector('#editor').innerHTML`)).toBe(before);
        await h.ref(`${root}.querySelector('#editor')`);
        expect(await h.fill("hello")).toMatchObject({ value_length: 5 });
        expect(await h.fill("!", false)).toMatchObject({ value_length: 6 });
        expect(await h.evaluate(`${root}.querySelector('#editor').textContent`)).toBe("hello!");
      },
    );
  }, 30_000);

  it.each([
    ["DOM.resolveNode", "old"],
    ["DOM.scrollIntoViewIfNeeded", "old"],
    ["DOM.focus", "old"],
    ["cleared", ""],
    ["Input.insertText", "hello"],
    ["notified", "hello"],
    ["verified", "hello"],
  ])(
    "cancels after %s without leaving temporary content",
    async (phase, expected) => {
      await withFillBrowser(
        { background: false, markup: guard + '<div id="target" contenteditable="true">old</div>' },
        async (h) => {
          await h.ref("document.querySelector('#target')");
          const controller = new AbortController();
          h.afterCommand((method, params) => {
            const declaration =
              (params as { functionDeclaration?: string })?.functionDeclaration ?? "";
            const matched =
              method === phase ||
              (phase === "cleared" && declaration.includes("this.textContent = ''")) ||
              (phase === "notified" && declaration.includes("new Event('change'")) ||
              (phase === "verified" && declaration.startsWith("function(expected)"));
            if (matched) controller.abort();
          });
          expect(await h.fill("hello", true, controller.signal)).toMatchObject({
            code: "cancelled",
          });
          expect(await h.evaluate("document.querySelector('#target').textContent")).toBe(expected);
          expect(await h.evaluate("document.querySelector('#guard').value")).toBe("untouched");
          expect(h.calls.filter((method) => method === "Runtime.releaseObject")).toHaveLength(1);
          if (expected !== "hello") expect(h.calls).not.toContain("Input.insertText");
        },
      );
    },
    30_000,
  );

  it.each([
    "focus",
    "input",
    "change",
  ])("does not report success when a %s handler replaces the editor", async (event) => {
    await withFillBrowser(
      { background: false, markup: guard + '<div id="target" contenteditable="true">old</div>' },
      async (h) => {
        await h.ref("document.querySelector('#target')");
        await h.evaluate(`document.querySelector('#target').addEventListener(${JSON.stringify(event)}, event => {
        const replacement = event.target.cloneNode(true); replacement.textContent = 'replacement'; event.target.replaceWith(replacement);
      }, {once:true})`);
        expect(await h.fill("hello")).toHaveProperty("code");
        expect(await h.evaluate("document.querySelector('#target').textContent")).toBe(
          "replacement",
        );
        expect(await h.evaluate("document.querySelector('#guard').value")).toBe("untouched");
        if (event !== "change") expect(h.calls).not.toContain("Input.insertText");
      },
    );
  }, 30_000);

  it("rechecks a root that becomes a descendant during focus", async () => {
    await withFillBrowser(
      {
        background: false,
        markup: guard + '<div id="wrapper"><div id="target" contenteditable="true">old</div></div>',
      },
      async (h) => {
        await h.ref("document.querySelector('#target')");
        await h.evaluate(
          "document.querySelector('#target').addEventListener('focus', () => document.querySelector('#wrapper').contentEditable = 'true', {once:true})",
        );
        expect(await h.fill("hello")).toMatchObject({ data: { reason: "target_not_fillable" } });
        expect(await h.evaluate("document.querySelector('#target').textContent")).toBe("old");
        expect(h.calls).not.toContain("Input.insertText");
      },
    );
  }, 30_000);
});

describe.skipIf(!process.env.BSK_FILL_CHROME)("fill focus changes", () => {
  it.each([
    false,
    true,
  ])("stops when focus changes after root caret placement (background=%s)", async (background) => {
    await withFillBrowser(
      { background, markup: guard + '<div id="target" contenteditable="true">old</div>' },
      async (h) => {
        await h.ref("document.querySelector('#target')");
        h.afterCommand(async (method, params) => {
          const script = params as {
            functionDeclaration?: string;
            arguments?: { value: unknown }[];
          };
          if (
            method === "Runtime.callFunctionOn" &&
            script.functionDeclaration?.startsWith("function(before, placeCaret") &&
            script.arguments?.[1].value === true
          ) {
            await h.evaluate("document.querySelector('#guard').focus()");
          }
        });
        expect(await h.fill("hello", false)).toMatchObject({ data: { reason: "fill_focus_lost" } });
        expect(await h.evaluate("document.querySelector('#guard').value")).toBe("untouched");
        expect(await h.evaluate("document.querySelector('#target').textContent")).toBe("old");
        expect(h.calls).not.toContain("Input.insertText");
      },
    );
  }, 30_000);
});

describe.skipIf(!process.env.BSK_FILL_CHROME)("fill caret validation", () => {
  it("stops if page code moves the caret within the same editor", async () => {
    await withFillBrowser(
      { background: false, markup: guard + '<div id="target" contenteditable="true">old</div>' },
      async (h) => {
        await h.ref("document.querySelector('#target')");
        h.afterCommand(async (method, params) => {
          const script = params as {
            functionDeclaration?: string;
            arguments?: { value: unknown }[];
          };
          if (
            method === "Runtime.callFunctionOn" &&
            script.functionDeclaration?.startsWith("function(before, placeCaret") &&
            script.arguments?.[1].value === true
          ) {
            await h.evaluate(
              "document.getSelection().collapse(document.querySelector('#target'), 0)",
            );
          }
        });
        expect(await h.fill("hello", false)).toMatchObject({ data: { reason: "fill_focus_lost" } });
        expect(await h.evaluate("document.querySelector('#target').textContent")).toBe("old");
        expect(h.calls).not.toContain("Input.insertText");
      },
    );
  }, 30_000);
});
