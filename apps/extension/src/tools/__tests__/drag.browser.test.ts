// @vitest-environment node

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CdpFrame, CdpTarget } from "@/browser-driver/frame-graph";
import { pointerTargetValidator } from "@/cooperation/pointer-target";
import { SessionManager } from "@/session-manager/manager";
import type { DragParams } from "@/transport/types";
import { handleDrag } from "../drag";
import { handleObserve } from "../observation";
import type { CdpRunner } from "../shared";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
const { dragMarkup, dragScript } = await import(
  new URL(
    "../../../../../evals/browser/cases/regression/drag-interactions/drag-interactions.fixture.mjs",
    import.meta.url,
  ).href
);
let send: Send;
let close: () => void;
let run: Promise<void>;
if (process.env.BSK_DRAG_CHROME) {
  beforeAll(async () => {
    const { withChrome } = await import(
      new URL(
        "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
        import.meta.url,
      ).href
    );
    const ready = Promise.withResolvers<Send>(),
      done = Promise.withResolvers<void>();
    close = done.resolve;
    run = withChrome(
      { executable: process.env.BSK_DRAG_CHROME, deviceScale: 1, zoom: 1 },
      async (s: Send) => {
        ready.resolve(s);
        await done.promise;
      },
    );
    run.catch(ready.reject);
    send = await ready.promise;
  }, 30000);
  afterAll(async () => {
    close?.();
    await run;
  }, 30000);
}

type Hook = (method: string, params?: Record<string, unknown>) => void | Promise<void>;
async function withPage(
  test: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>,
  background = false,
) {
  const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
    url: "about:blank",
    background,
  });
  try {
    await test(await harness(targetId, background));
  } finally {
    await send("Target.closeTarget", { targetId });
  }
}
async function harness(targetId: string, background: boolean) {
  const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  if (!background) await send("Page.bringToFront", {}, sessionId);
  const evaluate = async <T = unknown>(expression: string): Promise<T> => {
    const reply = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    expect(reply.exceptionDetails).toBeUndefined();
    return reply.result.value;
  };
  await evaluate(`document.body.innerHTML=${JSON.stringify(dragMarkup)};${dragScript}`);
  const manager = new SessionManager({
    agentWindow: {
      create: async () => ({ windowId: 100, initialTabIds: [] }),
      remove: async () => {},
      ensureActiveTab: async () => 4,
    },
  });
  const ctx = await manager.start("aa11");
  let hook: Hook = () => {};
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const forward = async <T>(target: CdpTarget, method: string, params?: object): Promise<T> => {
    calls.push({ method, params: params as Record<string, unknown> });
    const result = await send<T>(method, params, target.sessionId ?? sessionId);
    await hook(method, params as Record<string, unknown>);
    return result;
  };
  const cdp: CdpRunner = {
    send: (_tab, method, params) => forward({ tabId: 4 }, method, params),
    sendToTarget: forward,
  };
  const frames = async () => {
    type Tree = { frame: { id: string; name?: string }; childFrames?: Tree[] };
    const { frameTree } = await send<{ frameTree: Tree }>("Page.getFrameTree", {}, sessionId);
    const result: CdpFrame[] = [];
    const visit = async (tree: Tree, parentFrameId?: string) => {
      const owner = parentFrameId
        ? await send<{ backendNodeId: number }>(
            "DOM.getFrameOwner",
            { frameId: tree.frame.id },
            sessionId,
          )
        : undefined;
      result.push({
        frameId: tree.frame.id,
        parentFrameId,
        target: { tabId: 4 },
        ownerBackendNodeId: owner?.backendNodeId,
      });
      for (const child of tree.childFrames ?? []) await visit(child, tree.frame.id);
    };
    await visit(frameTree);
    return { rootFrameId: frameTree.frame.id, frames: result };
  };
  cdp.getFrameGraph = frames;
  cdp.verifyPointerTarget = pointerTargetValidator(cdp);
  const deps = {
    cdp,
    tabsApi: {
      get: async (id: number) => ({ id, windowId: 100, active: !background }) as chrome.tabs.Tab,
      query: async () => [{ id: 4, windowId: 100, active: !background } as chrome.tabs.Tab],
    },
  };
  return {
    ctx,
    cdp,
    calls,
    evaluate,
    frames,
    setHook: (h: Hook) => {
      hook = h;
    },
    drag: (params: Partial<DragParams>, signal?: AbortSignal) =>
      handleDrag(
        manager,
        {
          session_id: "aa11",
          source: { selector: "#pointer" },
          delta: { x: 120, y: 0 },
          duration_ms: 100,
          ...params,
        },
        { ...deps, signal },
      ),
    observe: () =>
      handleObserve(manager, { session_id: "aa11" }, { ...deps, conditionalSurfaceProbe: false }),
    ref: async (expression: string, ref = "e1", frameId?: string) => {
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
      ctx.refStore.set(ref, node.backendNodeId, { tabId: 4, frameId });
    },
  };
}

let libraryBundle: string | undefined;
async function dndKitBundle() {
  if (!libraryBundle) {
    const result = await build({
      entryPoints: [
        new URL(
          "../../../../../evals/browser/cases/regression/drag-interactions/libraries.tsx",
          import.meta.url,
        ).pathname,
      ],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      nodePaths: [new URL("../../../node_modules", import.meta.url).pathname],
      define: { "process.env.NODE_ENV": '"production"' },
    });
    libraryBundle = result.outputFiles[0].text;
  }
  return libraryBundle;
}
const ok = (result: unknown) => expect(result, JSON.stringify(result)).not.toHaveProperty("code");
describe.skipIf(!process.env.BSK_DRAG_CHROME)("real browser drag", () => {
  it.each(["mouse", "pointer", "hold"])("moves %s with real input and releases", async (id) => {
    await withPage(async (h) => {
      ok(
        await h.drag({
          source: { selector: `#${id}` },
          delta: { x: 120, y: 35 },
          hold_ms: id === "hold" ? 260 : 0,
        }),
      );
      expect(await h.evaluate(`window.moved.${id}`)).toEqual({ dx: 120, dy: 35 });
      expect(
        await h.evaluate(
          `events.filter(e=>e.id===${JSON.stringify(id)}&&e.type.endsWith('down')).every(e=>e.trusted)`,
        ),
      ).toBe(true);
      expect(
        await h.evaluate(
          `events.filter(e=>e.type===${JSON.stringify(id === "mouse" ? "mouseup" : "pointerup")}).at(-1).buttons`,
        ),
      ).toBe(0);
      if (id === "hold")
        expect(await h.evaluate<number>("window.held")).toBeGreaterThanOrEqual(260);
    });
  });
  it("preserves middle-button and modifiers", async () =>
    withPage(async (h) => {
      ok(await h.drag({ source: { selector: "#mouse" }, button: "middle", modifiers: ["shift"] }));
      expect(await h.evaluate("events.find(e=>e.type==='mousedown')")).toMatchObject({
        button: 1,
        buttons: 4,
        shift: true,
        trusted: true,
      });
      expect(await h.evaluate("window.moved.mouse.dx")).toBe(120);
    }));
  it("performs native HTML drag with DataTransfer and trusted drop", async () =>
    withPage(async (h) => {
      ok(
        await h.drag({
          source: { selector: "#native" },
          target: { selector: "#drop" },
          delta: undefined,
          duration_ms: 250,
        }),
      );
      expect(await h.evaluate("window.drops")).toBe(1);
      expect(await h.evaluate("native.parentElement.id")).toBe("drop");
      expect(
        await h.evaluate(
          "events.filter(e=>['dragstart','dragover','drop','dragend'].includes(e.type)).map(e=>[e.type,e.trusted])",
        ),
      ).toEqual(
        expect.arrayContaining([
          ["dragstart", true],
          ["dragover", true],
          ["drop", true],
          ["dragend", true],
        ]),
      );
    }));
  it("changes a native range value", async () =>
    withPage(async (h) => {
      ok(await h.drag({ source: { selector: "#range" }, delta: { x: 70, y: 0 } }));
      expect(await h.evaluate<number>("Number(range.value)")).toBeGreaterThan(70);
    }));
  it("resizes a panel through its handle", async () =>
    withPage(async (h) => {
      ok(await h.drag({ source: { selector: "#handle" }, delta: { x: 50, y: 30 } }));
      expect(await h.evaluate("[resize.style.width,resize.style.height]")).toEqual([
        "190px",
        "100px",
      ]);
    }));
  it("reorders pointer-based cards", async () =>
    withPage(async (h) => {
      ok(
        await h.drag({
          source: { selector: "#first" },
          target: { selector: "#third" },
          delta: undefined,
        }),
      );
      expect(await h.evaluate("Array.from(sort.children,e=>e.id)")).toEqual([
        "second",
        "third",
        "first",
      ]);
    }));
  it("draws on canvas and moves SVG content", async () =>
    withPage(async (h) => {
      ok(
        await h.drag({
          source: { selector: "#canvas", offset: { x: -100, y: 0 } },
          delta: { x: 100, y: 0 },
        }),
      );
      expect(
        await h.evaluate(
          "Array.from(canvas.getContext('2d').getImageData(0,0,360,120).data).some(v=>v!==0)",
        ),
      ).toBe(true);
      ok(await h.drag({ source: { selector: "#svg" }, delta: { x: 80, y: 20 } }));
      expect(await h.evaluate("[svg.getAttribute('x'),svg.getAttribute('y')]")).toEqual([
        "100",
        "30",
      ]);
    }));
  it.each([-100, 100])("preserves a source offset of %s with the production validator", async (x) =>
    withPage(async (h) => {
      ok(
        await h.drag({
          source: { selector: "#canvas", offset: { x, y: 20 } },
          delta: { x: 20, y: 10 },
        }),
      );
      const expected = await h.evaluate<{ x: number; y: number }>(
        `(()=>{const r=canvas.getBoundingClientRect();return {x:r.x+r.width/2+${x},y:r.y+r.height/2+20}})()`,
      );
      const down = await h.evaluate<{ x: number; y: number }>(
        "events.find(e=>e.id==='canvas'&&e.type==='pointerdown')",
      );
      expect(down.x).toBeCloseTo(expected.x, 0);
      expect(down.y).toBeCloseTo(expected.y, 0);
      expect(await h.evaluate("window.moved.canvas")).toEqual({ dx: 20, dy: 10 });
    }));
  it.each([
    "covered",
    "moved",
    "outside",
  ])("rejects an offset point that is %s before pressing", async (kind) =>
    withPage(async (h) => {
      if (kind === "covered")
        await h.evaluate(
          `canvas.scrollIntoView({block:'center'});const r=canvas.getBoundingClientRect();const cover=document.createElement('div');cover.style='position:fixed;z-index:1000;width:30px;height:30px;background:red;left:'+(r.x+r.width/2-115)+'px;top:'+(r.y+r.height/2-15)+'px';document.body.append(cover)`,
        );
      if (kind === "moved")
        h.setHook(async (method, p) => {
          if (method === "Input.dispatchMouseEvent" && p?.type === "mouseMoved") {
            h.setHook(() => {});
            await h.evaluate("canvas.style.transform='translateX(20px)'");
          }
        });
      const result = await h.drag({
        source: { selector: "#canvas", offset: { x: kind === "outside" ? 300 : -100, y: 0 } },
        delta: { x: 20, y: 0 },
      });
      expect(result).toMatchObject({ code: expect.any(String), data: { effect_state: "none" } });
      if (kind === "moved")
        expect(result).toHaveProperty("message", expect.stringMatching(/moved/));
      expect(h.calls.some((call) => call.params?.type === "mousePressed")).toBe(false);
    }));
  it("uses VOM refs for native source and an empty drop area", async () =>
    withPage(async (h) => {
      const observation = await h.observe();
      ok(observation);
      if ("code" in observation) throw new Error(observation.message);
      const find = (name: string) => {
        const line = observation.text.split("\n").find((l) => l.includes('"' + name + '"'));
        const ref = line?.match(/@e\d+/)?.[0];
        expect(ref, observation.text).toBeTruthy();
        return ref!;
      };
      ok(
        await h.drag({
          source: { ref: find("Native card") },
          target: { ref: find("Done") },
          delta: undefined,
          observation_id: observation.observation_id,
        }),
      );
      expect(await h.evaluate("window.drops")).toBe(1);
    }));
  it("distinguishes duplicate names using VOM refs", async () =>
    withPage(async (h) => {
      await h.evaluate(
        `mouse.setAttribute('aria-label','Item');pointer.setAttribute('aria-label','Item')`,
      );
      const observation = await h.observe();
      if ("code" in observation) throw new Error(observation.message);
      const refs = observation.text
        .split("\n")
        .filter((l) => l.includes('"Item"'))
        .map((l) => l.match(/@e\d+/)?.[0])
        .filter(Boolean);
      expect(refs).toHaveLength(2);
      ok(await h.drag({ source: { ref: refs[1] }, delta: { x: 60, y: 0 } }));
      expect(await h.evaluate("window.moved")).toEqual({ pointer: { dx: 60, dy: 0 } });
    }));
  it("rejects an old observation token before input", async () =>
    withPage(async (h) => {
      const old = await h.observe();
      if ("code" in old) throw new Error(old.message);
      await h.observe();
      expect(await h.drag({ observation_id: old.observation_id })).toMatchObject({
        code: "not_found",
        data: { effect_state: "none" },
      });
      expect(
        h.calls.some(
          (call) =>
            call.method === "Input.dispatchMouseEvent" && call.params?.type === "mousePressed",
        ),
      ).toBe(false);
    }));
  it.each([
    "ambiguous",
    "covered",
    "hidden",
    "offscreen",
    "zero",
    "wrong-tab",
    "detached",
    "disabled",
    "inert",
  ])("rejects %s endpoints without pressing", async (kind) =>
    withPage(async (h) => {
      let params: Partial<DragParams> = {};
      if (kind === "ambiguous") params = { source: { selector: ".box" } };
      if (kind === "covered")
        await h.evaluate(
          "document.body.insertAdjacentHTML('beforeend','<div style=\"position:fixed;inset:0;z-index:1000;background:#fff\"></div>')",
        );
      if (kind === "disabled") await h.evaluate("pointer.setAttribute('aria-disabled','true')");
      if (kind === "inert") await h.evaluate("pointer.inert=true");
      if (kind === "hidden") await h.evaluate("pointer.style.display='none'");
      if (kind === "offscreen") params = { delta: { x: 10000, y: 0 } };
      if (kind === "zero") params = { delta: { x: 0, y: 0 } };
      if (kind === "wrong-tab") {
        h.ctx.refStore.set("e1", 1, { tabId: 99 });
        params = { source: { ref: "e1" } };
      }
      if (kind === "detached") {
        await h.ref("pointer");
        await h.evaluate("pointer.remove()");
        params = { source: { ref: "e1" } };
      }
      expect(await h.drag(params)).toHaveProperty("code");
      expect(
        h.calls.some(
          (call) =>
            call.method === "Input.dispatchMouseEvent" && call.params?.type === "mousePressed",
        ),
      ).toBe(false);
    }));
  it.each([
    "hold",
    "move",
    "native",
  ])("cancels during %s, releases input and allows the next drag", async (stage) =>
    withPage(async (h) => {
      const controller = new AbortController();
      let moves = 0;
      h.setHook((method, p) => {
        if (method !== "Input.dispatchMouseEvent") return;
        if (stage === "hold" && p?.type === "mousePressed") controller.abort();
        if (stage !== "hold" && p?.type === "mouseMoved" && p.buttons && ++moves === 2)
          controller.abort();
      });
      const result = await h.drag(
        stage === "native"
          ? { source: { selector: "#native" }, target: { selector: "#drop" }, delta: undefined }
          : { hold_ms: stage === "hold" ? 300 : 0 },
        controller.signal,
      );
      expect(result).toMatchObject({ code: "cancelled", data: { effect_state: "unknown" } });
      expect(await h.evaluate("window.drops")).toBe(0);
      h.setHook(() => {});
      ok(await h.drag({ source: { selector: "#mouse" }, delta: { x: 50, y: 0 } }));
      expect(await h.evaluate("window.moved.mouse")).toEqual({ dx: 50, dy: 0 });
    }));
  it("rejects a source replaced by hover before pressing", async () =>
    withPage(async (h) => {
      h.setHook(async (method, p) => {
        if (method === "Input.dispatchMouseEvent" && p?.type === "mouseMoved") {
          h.setHook(() => {});
          await h.evaluate("pointer.replaceWith(pointer.cloneNode(true))");
        }
      });
      expect(await h.drag({})).toHaveProperty("code");
      expect(h.calls.some((c) => c.params?.type === "mousePressed")).toBe(false);
    }));
  it("retires a gesture when its document changes and releases its button", async () =>
    withPage(async (h) => {
      h.setHook((method, p) => {
        if (method === "Input.dispatchMouseEvent" && p?.type === "mousePressed")
          h.ctx.refStore.invalidateTab(4);
      });
      expect(await h.drag({})).toMatchObject({
        code: "cdp_failed",
        data: { effect_state: "unknown" },
      });
      expect(h.calls.filter((c) => c.params?.type === "mouseReleased")).toHaveLength(1);
      expect(await h.evaluate("window.moved.pointer")).toBeUndefined();
    }));
  it("times out while holding and does not resume input later", async () =>
    withPage(async (h) => {
      expect(await h.drag({ hold_ms: 400, timeout_ms: 180 })).toMatchObject({ code: "timeout" });
      const count = h.calls.filter((c) => c.method === "Input.dispatchMouseEvent").length;
      await new Promise((r) => setTimeout(r, 450));
      expect(h.calls.filter((c) => c.method === "Input.dispatchMouseEvent")).toHaveLength(count);
      expect(await h.evaluate("events.filter(e=>e.type==='pointerup').at(-1).buttons")).toBe(0);
    }));
  it("retires a delayed press reply and never resumes the gesture", async () =>
    withPage(async (h) => {
      const delayed = Promise.withResolvers<void>();
      h.setHook((method, p) =>
        method === "Input.dispatchMouseEvent" && p?.type === "mousePressed"
          ? delayed.promise
          : undefined,
      );
      expect(await h.drag({ timeout_ms: 180 })).toMatchObject({
        code: "timeout",
        data: { effect_state: "unknown" },
      });
      const count = h.calls.filter((c) => c.method === "Input.dispatchMouseEvent").length;
      delayed.resolve();
      await new Promise((r) => setTimeout(r, 80));
      expect(h.calls.filter((c) => c.method === "Input.dispatchMouseEvent")).toHaveLength(count);
      expect(await h.evaluate("window.moved.pointer")).toBeUndefined();
    }));
  it("supports a shadow-root handle via ref", async () =>
    withPage(async (h) => {
      await h.evaluate(
        `const host=document.createElement('div');document.body.prepend(host);const shadow=host.attachShadow({mode:'open'});shadow.innerHTML='<div style="width:100px;height:50px;cursor:grab;touch-action:none" id="shadow">Handle</div>';window.shadowHandle=shadow.firstChild;installDrag(shadowHandle,'pointer',(x,y)=>window.shadowMove=[x,y]);`,
      );
      await h.ref("window.shadowHandle");
      ok(await h.drag({ source: { ref: "e1" }, delta: { x: 40, y: 10 } }));
      expect(await h.evaluate("window.shadowMove")).toEqual([40, 10]);
    }));
  it("supports an iframe ref and remeasures after scrolling", async () =>
    withPage(async (h) => {
      await h.evaluate(
        `document.body.style.paddingTop='1800px';const f=document.createElement('iframe');document.body.prepend(f);f.contentDocument.body.innerHTML='<div id="inside" style="width:100px;height:60px;cursor:grab;touch-action:none">Inside</div>';const el=f.contentDocument.querySelector('#inside');el.onpointerdown=e=>{el.setPointerCapture(e.pointerId);window.frameStart=[e.clientX,e.clientY]};el.onpointermove=e=>{if(e.buttons)window.frameMove=[e.clientX-frameStart[0],e.clientY-frameStart[1]]};window.frameElementForTest=el;`,
      );
      const graph = await h.frames();
      const frame = graph.frames.find((f) => f.parentFrameId)!;
      await h.ref("window.frameElementForTest", "e1", frame.frameId);
      ok(await h.drag({ source: { ref: "e1" }, delta: { x: 60, y: 20 } }));
      expect(await h.evaluate("window.frameMove")).toEqual([60, 20]);
    }));
  it("delivers input in a background tab and restores readiness", async () =>
    withPage(async (h) => {
      ok(await h.drag({ source: { selector: "#mouse" } }));
      expect(await h.evaluate("window.moved.mouse.dx")).toBe(120);
    }, true));
  it.each([false, true])("reorders real SortableJS cards (fallback=%s)", async (forceFallback) =>
    withPage(async (h) => {
      const require = createRequire(import.meta.url);
      const library = await readFile(require.resolve("sortablejs/Sortable.min.js"), "utf8");
      await h.evaluate(
        `document.body.innerHTML='<div id="items"><div id="alpha">Alpha</div><div id="beta">Beta</div><div id="gamma">Gamma</div></div><style>#items>div{width:180px;height:60px;margin:12px;background:#def}</style>';${library};Sortable.create(document.querySelector('#items'),{forceFallback:${forceFallback},animation:0,onEnd:()=>window.sorted=true});void 0;`,
      );
      ok(
        await h.drag({
          source: { selector: "#alpha" },
          target: { selector: "#gamma", offset: { x: 0, y: 20 } },
          delta: undefined,
          duration_ms: 700,
        }),
      );
      await expect
        .poll(() => h.evaluate("Array.from(document.querySelector('#items').children,e=>e.id)"))
        .toEqual(["beta", "gamma", "alpha"]);
      expect(await h.evaluate("window.sorted")).toBe(true);
    }));
  it("reorders real dnd-kit cards with a distance activation threshold", async () =>
    withPage(async (h) => {
      await h.evaluate(`document.body.innerHTML='<div id="app"></div>';${await dndKitBundle()}`);
      await expect.poll(() => h.evaluate("!!document.querySelector('#gamma')")).toBe(true);
      ok(
        await h.drag({
          source: { selector: "#alpha" },
          target: { selector: "#gamma" },
          delta: undefined,
          duration_ms: 700,
        }),
      );
      await expect
        .poll(() => h.evaluate("Array.from(document.querySelector('#items').children,e=>e.id)"))
        .toEqual(["beta", "gamma", "alpha"]);
    }));
  it("clears background focus emulation on cancellation", async () =>
    withPage(async (h) => {
      const abort = new AbortController();
      h.setHook((method, p) => {
        if (method === "Input.dispatchMouseEvent" && p?.type === "mousePressed") abort.abort();
      });
      expect(await h.drag({ hold_ms: 300 }, abort.signal)).toMatchObject({ code: "cancelled" });
      expect(
        h.calls.some(
          (c) => c.method === "Emulation.setFocusEmulationEnabled" && c.params?.enabled === false,
        ),
      ).toBe(true);
    }, true));
});
