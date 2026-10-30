// @vitest-environment node
// Opt in with BSK_CLICK_CHROME; each test owns its browser, profile and HTTP server.
// Real Chrome observations, target resolution and native input run through the
// production controller. The page reports DOM revisions like the content
// script's collector, so this is integration rather than installed-extension
// end-to-end coverage.
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpFrame, CdpFrameGraph } from "@/browser-driver/frame-graph";
import { SessionManager } from "@/session-manager/manager";
import { handleEvaluate } from "@/tools/evaluate";
import { handleClick, handleFill, handlePress } from "@/tools/interaction";
import { handleObserve, handleScreenshot, handleSnapshot } from "@/tools/observation";
import type { CdpRunner } from "@/tools/shared";
import type { RequestFrame } from "@/transport/types";
import { CooperationController } from "./controller";
import type { FrameState } from "./types";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
type Reply = Record<string, any>;

// Counts DOM mutations like cooperation-capture.ts and records trusted input.
const collector = `<script>
  window.coop = { document: Math.random().toString(36).slice(2), revision: 0 };
  new MutationObserver(() => coop.revision++).observe(document, {
    subtree: true, childList: true, attributes: true, characterData: true });
  window.clicks = [];
  window.keys = [];
  window.releases = [];
  addEventListener("click", (e) => clicks.push(e.target.id + ":" + e.isTrusted), true);
  addEventListener("keydown", (e) => keys.push(e.key + ":" + e.isTrusted), true);
  addEventListener("mouseup", (e) => releases.push("mouse:" + e.isTrusted), true);
  addEventListener("keyup", (e) => releases.push(e.key + ":" + e.isTrusted), true);
</script>`;

const pages: Record<string, string> = {
  // Continue in form A; a plain clock in form B.
  clock: `<main><form aria-label="A"><button id="continue" type="button">Continue</button></form>
    <form aria-label="B"><span id="clock">10:00:00</span></form></main>`,
  // Pay shares a fixed panel with its price inside <main>.
  panel: `<main><form aria-label="A"><button id="continue" type="button">Continue</button></form>
    <div id="panel" style="position:fixed;left:250px;top:150px">
      <span id="price" aria-hidden="true">$100</span><button id="pay" type="button">Pay</button>
    </div></main>`,
  "visible-panel": `<main><form aria-label="A"><button id="continue" type="button">Continue</button></form>
    <div id="panel" style="position:fixed;left:250px;top:150px">
      <span id="price">$100</span><button id="pay" type="button">Pay</button>
    </div></main>`,
  // A selector can target an element the observation leaves out.
  // It is not focusable: Chrome drops aria-hidden around a focused element.
  hidden: `<main><div aria-hidden="true"><span id="hidden">Hidden</span></div>
    <button id="styled" class="plain" type="button">Styled</button>
    <span id="clock">10:00:00</span></main>`,
  // A search form beside a clock in another form.
  search: `<main><form aria-label="A" onsubmit="event.preventDefault()">
      <input id="query" aria-label="Query">
      <button id="go" type="button">Go</button></form>
    <form aria-label="B"><span id="clock">10:00:00</span></form></main>`,
  // A landmark-free app: clock and menu in the header, a priced card below.
  app: `<div id="root"><div class="app">
    <header><span id="clock">10:00:00</span><button id="menu" type="button">Menu</button></header>
    <div class="content"><div class="card"><span id="price">$100</span>
      <button id="buy" type="button">Buy</button></div></div></div></div>`,
  live: `<main><form aria-label="Checkout" onsubmit="event.preventDefault()">
    <span id="clock" style="display:inline-block;width:100px">Tick 0</span>
    <label>City <input id="city"></label><label>Quantity <input id="quantity"></label>
    <span id="price">$100</span><button id="pay" data-record-id="order-1" type="button">Pay</button>
    <button id="cancel" type="button">Cancel</button>
    </form></main>`,
  redirect: `<label>Requested <input id="requested" onfocus="document.querySelector('#other').focus()"></label>
    <label>Other <input id="other"></label>`,
  "frame-navigation": `<button id="open" onclick="document.querySelector('iframe').src='/frame-next'">Open detail</button>
    <form action="/frame-next" target="detail"><label>Query <input id="query" name="query"></label></form>
    <iframe name="detail" src="/frame-initial"></iframe>`,
  "frame-initial": "<p>Initial detail</p>",
  "frame-next": "<p>Saved detail</p>",
  canvas: `<canvas id="canvas" width="200" height="100"></canvas>
    <script>const context = document.querySelector('canvas').getContext('2d');
      context.fillStyle = 'blue'; context.fillRect(0, 0, 200, 100);</script>`,
};

async function withCooperation(
  run: (page: {
    open(name: string): Promise<void>;
    set(selector: string, text: string): Promise<void>;
    mutate(expression: string): Promise<void>;
    sync(): Promise<Reply>;
    observe(visual?: boolean): Promise<Reply>;
    screenshot(ref: string): Promise<Reply>;
    act(method: string, params: object): Promise<Reply>;
    click(context: string, selector: string): Promise<Reply>;
    press(context: string, key: string): Promise<Reply>;
    inputs(): Promise<{ clicks: string[]; keys: string[] }>;
    value(selector: string): Promise<string>;
    captures(): { dom: number; accessibility: number };
    read<T>(expression: string): Promise<T>;
  }) => Promise<void>,
  options: { policy?: "strict" | "target" } = {},
) {
  const server = createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? "/").slice(1).split("?")[0]);
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><title>${name}</title><body>${pages[name] ?? ""}${collector}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { withChrome } = await import(
    new URL(
      "../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
      import.meta.url,
    ).href
  );
  let onNavigation: ((sessionId: string) => void) | undefined;
  try {
    await withChrome(
      {
        executable: process.env.BSK_CLICK_CHROME,
        deviceScale: 1,
        zoom: 1,
        startupTimeout: 30_000,
        onEvent: (event: { method: string; sessionId: string }) => {
          if (event.method === "Page.frameNavigated") onNavigation?.(event.sessionId);
        },
      },
      async (send: Send) => {
        const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
          url: "about:blank",
        });
        const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
          targetId,
          flatten: true,
        });
        const local: Send = (method, params) => send(method, params, sessionId);
        const evaluate = async <T>(expression: string) => {
          const reply = await local<{ result: { value: T }; exceptionDetails?: unknown }>(
            "Runtime.evaluate",
            { expression, returnByValue: true, awaitPromise: true },
          );
          expect(reply.exceptionDetails).toBeUndefined();
          return reply.result.value;
        };
        await local("Page.enable");
        await local("Page.bringToFront");
        const graph = async (): Promise<CdpFrameGraph> => {
          interface Tree {
            frame: { id: string };
            childFrames?: Tree[];
          }
          const { frameTree } = await local<{ frameTree: Tree }>("Page.getFrameTree");
          const frames: CdpFrame[] = [];
          const visit = (tree: Tree, parentFrameId?: string) => {
            frames.push({ frameId: tree.frame.id, parentFrameId, target: { tabId: 4 } });
            for (const child of tree.childFrames ?? []) visit(child, tree.frame.id);
          };
          visit(frameTree);
          return { rootFrameId: frameTree.frame.id, frames };
        };
        const captures = { dom: 0, accessibility: 0 };
        const instrumented: Send = (method, params) => {
          if (method === "DOMSnapshot.captureSnapshot") captures.dom++;
          if (method === "Accessibility.getFullAXTree") captures.accessibility++;
          return local(method, params);
        };
        const cdp: CdpRunner = {
          send: (_tabId, method, params) => instrumented(method, params),
          sendToTarget: (_target, method, params) => instrumented(method, params),
          getAttachmentId: () => sessionId,
          getFrameGraph: graph,
        };
        const sessions = new SessionManager({
          agentWindow: {
            create: async () => ({ windowId: 100, initialTabIds: [4] }),
            remove: async () => {},
            ensureActiveTab: async () => 4,
          },
        });
        await sessions.start("shared");
        const tab = { id: 4, windowId: 100, active: true, url: origin } as chrome.tabs.Tab;
        const tabsApi = { get: async () => tab, query: async () => [tab] };
        vi.stubGlobal("chrome", { tabs: tabsApi });
        const frameState = (state: { document: string; revision: number }): FrameState => ({
          document: state.document,
          revision: state.revision,
          structure: state.revision,
          human: 0,
          busy: false,
          editing: false,
          lastInput: 0,
          fields: [],
          fieldsComplete: true,
          events: [],
        });
        const frame = async () =>
          frameState(await evaluate<{ document: string; revision: number }>("window.coop"));
        const controller = new CooperationController({
          sessions,
          readFrames: async () => {
            const states = await evaluate<Array<{ document: string; revision: number }>>(
              "[window, ...Array.from(document.querySelectorAll('iframe'), f => f.contentWindow)].map(w => w.coop)",
            );
            return new Map(states.map((state, id) => [id, frameState(state)]));
          },
          resumeFrames: async () => {},
          changed: () => {},
        });
        onNavigation = (eventSession) => {
          if (eventSession === sessionId) {
            sessions.invalidateTabRefs(4);
            controller.invalidate(4);
          }
        };
        const signal = new AbortController().signal;
        await controller.run(
          { id: "start", method: "tool.session_start", params: { session_id: "shared" } },
          cdp,
          signal,
          async () => ({ agent_window_id: 100 }),
        );
        const handlers: Record<string, typeof handleClick> = {
          "tool.click": handleClick,
          "tool.press": handlePress as never,
          "tool.fill": handleFill as never,
          "tool.evaluate": handleEvaluate as never,
        };
        const act = (method: string, params: object) => {
          const request: RequestFrame = {
            id: crypto.randomUUID(),
            method,
            params: { session_id: "shared", tab_id: 4, ...params },
          };
          return controller.run(request, cdp, signal, (runner, operationSignal) =>
            handlers[method](sessions, request.params as never, {
              cdp: runner as CdpRunner,
              tabsApi,
              signal: operationSignal as AbortSignal,
            }),
          ) as Promise<Reply>;
        };
        await run({
          async open(name) {
            sessions.invalidateTabRefs(4);
            controller.invalidate(4);
            tab.url = `${origin}/${name}`;
            await local("Page.navigate", { url: tab.url });
            await expect
              .poll(() =>
                evaluate(
                  "document.title === " +
                    JSON.stringify(name) +
                    " && !!window.coop && Array.from(document.querySelectorAll('iframe')).every(f => !!f.contentWindow.coop)",
                ),
              )
              .toBe(true);
          },
          async set(selector, text) {
            await this.mutate(
              `document.querySelector(${JSON.stringify(selector)}).firstChild.nodeValue = ${JSON.stringify(text)}`,
            );
          },
          async mutate(expression) {
            const before = (await frame()).revision;
            await evaluate(expression);
            // The action check only re-observes after the collector reports a mutation.
            await expect.poll(async () => (await frame()).revision > before).toBe(true);
          },
          sync: () =>
            controller.command(
              {
                session_id: "shared",
                tab_id: 4,
                action: "sync",
                timeout_ms: 0,
                ...(options.policy ? { control_policy: options.policy } : {}),
              },
              cdp,
              signal,
            ) as Promise<Reply>,
          observe: (visual = false) =>
            controller.run(
              {
                id: crypto.randomUUID(),
                method: visual ? "tool.observe" : "tool.snapshot",
                params: { session_id: "shared", tab_id: 4 },
              },
              cdp,
              signal,
              (runner) =>
                (visual ? handleObserve : handleSnapshot)(
                  sessions,
                  { session_id: "shared", tab_id: 4 },
                  { cdp: runner, tabsApi },
                  signal,
                ),
            ) as Promise<Reply>,
          screenshot: (ref) =>
            controller.run(
              {
                id: crypto.randomUUID(),
                method: "tool.screenshot",
                params: { session_id: "shared", tab_id: 4, ref },
              },
              cdp,
              signal,
              (runner) =>
                handleScreenshot(
                  sessions,
                  { session_id: "shared", tab_id: 4, ref },
                  {
                    cdp: runner,
                    tabsApi,
                    captureApi: {
                      ...tabsApi,
                      captureVisibleTab: async () => {
                        throw new Error("unexpected tab screenshot");
                      },
                    },
                    sendToTab: async () => undefined,
                  },
                  signal,
                ),
            ) as Promise<Reply>,
          act,
          click: (context, selector) => act("tool.click", { context_id: context, selector }),
          press: (context, key) => act("tool.press", { context_id: context, key }),
          inputs: () => evaluate("({ clicks, keys })"),
          value: (selector) =>
            evaluate(`document.querySelector(${JSON.stringify(selector)}).value`),
          captures: () => ({ ...captures }),
          read: evaluate,
        });
      },
    );
  } finally {
    server.close();
  }
}

const learned = expect.stringContaining("changed by itself");
const changed = "The action's observed content changed; synchronize and replan";
const refused = { data: { reason: "cooperation_sync_required", effect_state: "none" } };

describe.skipIf(!process.env.BSK_CLICK_CHROME)("completed input during frame navigation", () => {
  afterEach(() => vi.unstubAllGlobals());

  describe.each(["strict", "target"] as const)("%s policy", (policy) => {
    it.each([
      "click",
      "press",
      "evaluate",
    ])("retains a completed %s receipt and rejects its old context", async (action) => {
      await withCooperation(
        async (page) => {
          await page.open("frame-navigation");
          const synced = await page.sync();
          expect(synced.context_id, JSON.stringify(synced)).toEqual(expect.any(String));
          const params = {
            context_id: synced.context_id,
            ...(policy === "target" ? { observation_id: synced.observation_id } : {}),
          };
          const result = await page.act(`tool.${action}`, {
            ...params,
            ...(action === "click"
              ? { selector: "#open" }
              : action === "press"
                ? { selector: "#query", key: "Enter" }
                : {
                    expression: `(async () => {
              const frame = document.querySelector('iframe');
              await new Promise(resolve => { frame.onload = resolve; frame.src = '/frame-next'; });
              return false;
            })()`,
                  }),
          });
          if (action === "evaluate") expect(result).toMatchObject({ ok: true, value: false });
          else if (action === "press")
            expect(result).toMatchObject({ tab_id: 4, key: "Enter", code: "Enter" });
          else
            expect(result).toMatchObject({
              tab_id: 4,
              x: expect.any(Number),
              y: expect.any(Number),
            });
          await expect
            .poll(() => page.read("document.querySelector('iframe').contentDocument.title"))
            .toBe("frame-next");
          expect(
            await page.read("document.querySelector('iframe').contentDocument.body.textContent"),
          ).toContain("Saved detail");
          if (action !== "evaluate")
            expect(await page.read("window.releases")).toContain(
              action === "press" ? "Enter:true" : "mouse:true",
            );
          const inputs = await page.inputs();
          expect(await page.click(synced.context_id, "#open")).toMatchObject({
            code: "permission_denied",
          });
          expect(await page.inputs()).toEqual(inputs);
          const next = await page.sync();
          expect(next.context_id).not.toBe(synced.context_id);
        },
        { policy },
      );
    }, 120_000);
  });
});

describe.skipIf(!process.env.BSK_CLICK_CHROME)("shared control with self-updating text", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports a plain text clock once, then stops refusing every action", async () => {
    await withCooperation(async (page) => {
      await page.open("clock");
      const first = await page.sync();
      await page.set("#clock", "10:00:01");
      const replies = [await page.click(first.context_id, "#continue")];
      for (let tick = 2; tick <= 4; tick++) {
        const synced = await page.sync();
        await page.set("#clock", `10:00:0${tick}`);
        replies.push(await page.click(synced.context_id, "#continue"));
      }
      // Previously every cycle was refused and no click ever arrived.
      expect((await page.inputs()).clicks).toEqual([
        "continue:true",
        "continue:true",
        "continue:true",
      ]);
      expect(replies[0]).toMatchObject({
        ...refused,
        message: expect.stringContaining('"10:00:00" → "10:00:01"'),
      });
      for (const reply of replies.slice(1)) expect(reply).not.toHaveProperty("code");
    });
  }, 120_000);

  it("does not let a refused context retry with newly learned text", async () => {
    await withCooperation(async (page) => {
      await page.open("clock");
      const first = await page.sync();
      await page.set("#clock", "10:00:01");
      expect(await page.click(first.context_id, "#continue")).toMatchObject({ message: learned });
      expect(await page.click(first.context_id, "#continue")).toMatchObject({
        ...refused,
        message: "This action requires the context returned by the latest cooperate sync",
      });
      expect((await page.inputs()).clicks).toEqual([]);
    });
  }, 120_000);

  it("never relaxes key presses without a target", async () => {
    await withCooperation(async (page) => {
      await page.open("clock");
      await page.set("#clock", "10:00:01");
      const first = await page.sync();
      await page.set("#clock", "10:00:02");
      expect(await page.click(first.context_id, "#continue")).toMatchObject({ message: learned });
      const synced = await page.sync();
      await page.set("#clock", "10:00:03");
      expect(await page.press(synced.context_id, "Enter")).toMatchObject({
        ...refused,
        message: changed,
      });
      expect(await page.inputs()).toEqual({ clicks: [], keys: [] });
    });
  }, 120_000);

  it.each([
    "panel",
    "visible-panel",
  ])("keeps a price in the target's positioned panel exact (%s)", async (name) => {
    await withCooperation(async (page) => {
      await page.open(name);
      const first = await page.sync();
      await page.set("#price", "$200");
      const elsewhere = await page.click(first.context_id, "#continue");
      const synced = await page.sync();
      await page.set("#price", "$300");
      const paid = await page.click(synced.context_id, "#pay");
      expect((await page.inputs()).clicks).toEqual([]);
      expect(paid).toMatchObject({ ...refused, message: changed });
      // Acting elsewhere may learn the visible price, never the aria-hidden one.
      expect(elsewhere).toMatchObject({
        ...refused,
        message: name === "panel" ? changed : learned,
      });
    });
  }, 120_000);

  it("keeps declared dependencies working while unrelated text ticks", async () => {
    await withCooperation(async (page) => {
      await page.open("clock");
      for (let tick = 1; tick <= 2; tick++) {
        const context = (await page.sync()).context_id;
        await page.set("#clock", `10:00:0${tick}`);
        expect(
          await page.act("tool.click", {
            context_id: context,
            selector: "#continue",
            depends_on: ["#continue"],
          }),
        ).not.toHaveProperty("code");
      }
      expect((await page.inputs()).clicks).toEqual(["continue:true", "continue:true"]);
    });
  }, 120_000);

  it("tolerates learned text for fills and key presses on a target", async () => {
    await withCooperation(async (page) => {
      await page.open("search");
      let context = (await page.sync()).context_id;
      await page.set("#clock", "10:00:01");
      const fill = (text: string) =>
        page.act("tool.fill", { context_id: context, selector: "#query", value: text });
      expect(await fill("ignored")).toMatchObject({ ...refused, message: learned });
      context = (await page.sync()).context_id;
      await page.set("#clock", "10:00:02");
      expect(await fill("weather")).not.toHaveProperty("code");
      expect(await page.value("#query")).toBe("weather");
      context = (await page.sync()).context_id;
      await page.set("#clock", "10:00:03");
      // A press result reports the pressed key's code, so match its shape.
      expect(
        await page.act("tool.press", { context_id: context, selector: "#query", key: "Enter" }),
      ).toMatchObject({ key: "Enter", code: "Enter" });
      expect((await page.inputs()).keys).toContain("Enter:true");
    });
  }, 120_000);

  it("keeps the exact whole-page check for a target outside the observation", async () => {
    await withCooperation(async (page) => {
      await page.open("hidden");
      // A cosmetic change passes the whole-page check, as before this change.
      let context = (await page.sync()).context_id;
      await page.mutate("document.querySelector('#styled').className = 'hovered'");
      expect(await page.click(context, "#hidden")).not.toHaveProperty("code");
      // Without an observed region to protect, self-updating text is never learned.
      for (let tick = 1; tick <= 2; tick++) {
        context = (await page.sync()).context_id;
        await page.set("#clock", `10:00:0${tick}`);
        expect(await page.click(context, "#hidden")).toMatchObject({
          ...refused,
          message: changed,
        });
      }
      expect((await page.inputs()).clicks).toEqual(["hidden:true"]);
    });
  }, 120_000);

  it("tolerates a header clock in a landmark-free app but keeps a card's price exact", async () => {
    await withCooperation(async (page) => {
      await page.open("app");
      let context = (await page.sync()).context_id;
      await page.set("#clock", "10:00:01");
      expect(await page.click(context, "#buy")).toMatchObject({ message: learned });
      context = (await page.sync()).context_id;
      await page.set("#clock", "10:00:02");
      expect(await page.click(context, "#buy")).not.toHaveProperty("code");
      // A price learned while acting in the header still protects its own card.
      context = (await page.sync()).context_id;
      await page.set("#price", "$200");
      expect(await page.click(context, "#menu")).toMatchObject({ message: learned });
      context = (await page.sync()).context_id;
      await page.set("#price", "$300");
      expect(await page.click(context, "#buy")).toMatchObject({ ...refused, message: changed });
      expect((await page.inputs()).clicks).toEqual(["buy:true"]);
    });
  }, 120_000);
});

describe.skipIf(!process.env.BSK_CLICK_CHROME)("target policy in a real browser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("compares both policies when a counter changes inside the target's form", async () => {
    for (const policy of ["strict", "target"] as const) {
      await withCooperation(
        async (page) => {
          await page.open("live");
          let synced = await page.sync();
          const before = page.captures();
          for (let tick = 1; tick <= 4; tick++) {
            if (policy === "strict" && tick > 1) synced = await page.sync();
            await page.set("#clock", `Tick ${tick}`);
            const result = await page.click(synced.context_id, "#pay");
            if (policy === "strict") expect(result).toMatchObject(refused);
            else expect(result, JSON.stringify(result)).not.toHaveProperty("code");
          }
          const after = page.captures();
          expect((await page.inputs()).clicks).toEqual(
            policy === "target" ? Array(4).fill("pay:true") : [],
          );
          if (policy === "target") expect(after).toEqual(before);
          else {
            expect(after.dom).toBeGreaterThan(before.dom);
            expect(after.accessibility).toBeGreaterThan(before.accessibility);
          }
        },
        { policy },
      );
    }
  }, 120_000);

  it("reuses one context beside a continuously changing clock without capturing the page again", async () => {
    await withCooperation(
      async (page) => {
        await page.open("live");
        await page.mutate(`window.tick = 1; document.querySelector('#clock').textContent = 'Tick 1';
        window.clockTimer = setInterval(() => document.querySelector('#clock').textContent = 'Tick ' + ++tick, 16)`);
        const synced = await page.sync();
        expect(synced.control_policy).toBe("target");
        expect(synced.context_id).toEqual(expect.any(String));
        const captures = page.captures();
        const tick = await page.read<number>("tick");
        for (let action = 0; action < 4; action++) {
          const clicked = await page.click(synced.context_id, "#pay");
          expect(clicked, JSON.stringify(clicked)).not.toHaveProperty("code");
        }
        expect(await page.read<number>("tick")).toBeGreaterThan(tick);
        expect((await page.inputs()).clicks).toEqual(Array(4).fill("pay:true"));
        expect(page.captures()).toEqual(captures);
      },
      { policy: "target" },
    );
  }, 120_000);

  it("keeps observed refs after insertion, reordering and a supplementary snapshot", async () => {
    await withCooperation(
      async (page) => {
        await page.open("live");
        const synced = await page.sync();
        const pay = synced.observation.text.match(/(@e\d+) button "Pay"/)?.[1];
        expect(pay).toEqual(expect.any(String));
        await page.mutate(`const form = document.querySelector('form');
        form.insertAdjacentHTML('afterbegin', '<button id="inserted" type="button">Inserted</button>');
        form.prepend(document.querySelector('#cancel'))`);
        const observed = await page.observe();
        expect(observed.text).toContain(`${pay} button "Pay"`);
        expect(observed.observation_id).not.toBe(synced.observation.observation_id);
        const captures = page.captures();
        expect(
          await page.act("tool.click", { context_id: synced.context_id, ref: pay }),
        ).not.toHaveProperty("code");
        expect((await page.inputs()).clicks).toEqual(["pay:true"]);
        expect(page.captures()).toEqual(captures);
      },
      { policy: "target" },
    );
  }, 120_000);

  it("fills multiple fields and sends directed Enter using the same control receipt", async () => {
    await withCooperation(
      async (page) => {
        await page.open("live");
        const synced = await page.sync();
        const captures = page.captures();
        for (const [selector, value] of [
          ["#city", "Shanghai"],
          ["#quantity", "2"],
        ]) {
          const result = await page.act("tool.fill", {
            context_id: synced.context_id,
            selector,
            value,
          });
          expect(result).not.toHaveProperty("code");
          expect(await page.value(selector)).toBe(value);
        }
        expect(
          await page.act("tool.press", {
            context_id: synced.context_id,
            selector: "#quantity",
            key: "Enter",
          }),
        ).toMatchObject({ key: "Enter", code: "Enter" });
        expect((await page.inputs()).keys).toContain("Enter:true");
        expect(page.captures()).toEqual(captures);
      },
      { policy: "target" },
    );
  }, 120_000);

  it("reports changed price, record identity and action label before dispatching a click", async () => {
    await withCooperation(
      async (page) => {
        await page.open("live");
        const synced = await page.sync();
        await page.set("#price", "$200");
        const captures = page.captures();
        const price = await page.act("tool.click", {
          context_id: synced.context_id,
          selector: "#pay",
          expect: [{ target: "#price", field: "text", equals: "$100" }],
        });
        expect(price).toMatchObject({
          data: {
            reason: "precondition_failed",
            phase: "precondition",
            effect_state: "none",
            target: "#price",
            field: "text",
            expected: "$100",
            actual: "$200",
          },
        });
        await page.mutate("document.querySelector('#pay').dataset.recordId = 'order-2'");
        const record = await page.act("tool.click", {
          context_id: synced.context_id,
          selector: "#pay",
          expect: [
            { target: "#pay", field: "attribute", attribute: "data-record-id", equals: "order-1" },
          ],
        });
        expect(record).toMatchObject({
          data: {
            reason: "precondition_failed",
            phase: "precondition",
            effect_state: "none",
            target: "#pay",
            field: "attribute",
            expected: "order-1",
            actual: "order-2",
          },
        });
        await page.set("#pay", "Delete");
        const renamed = await page.act("tool.click", {
          context_id: synced.context_id,
          selector: "#pay",
          expect: [{ target: "#pay", field: "text", equals: "Pay" }],
        });
        expect(renamed).toMatchObject({
          data: {
            reason: "precondition_failed",
            phase: "precondition",
            effect_state: "none",
            target: "#pay",
            field: "text",
            expected: "Pay",
            actual: "Delete",
          },
        });
        expect((await page.inputs()).clicks).toEqual([]);
        expect(page.captures()).toEqual(captures);
      },
      { policy: "target" },
    );
  }, 120_000);

  it("waits for a disabled target to become enabled before dispatching exactly one click", async () => {
    await withCooperation(
      async (page) => {
        await page.open("live");
        const synced = await page.sync();
        const captures = page.captures();
        await page.mutate(`document.querySelector('#pay').disabled = true;
        setTimeout(() => document.querySelector('#pay').disabled = false, 100)`);
        const clicked = await page.act("tool.click", {
          context_id: synced.context_id,
          selector: "#pay",
          timeout_ms: 1000,
        });
        expect(clicked, JSON.stringify(clicked)).not.toHaveProperty("code");
        expect((await page.inputs()).clicks).toEqual(["pay:true"]);
        expect(page.captures()).toEqual(captures);
      },
      { policy: "target" },
    );
  }, 120_000);

  it("refuses disabled, covered and removed targets without clicking a replacement", async () => {
    await withCooperation(
      async (page) => {
        await page.open("live");
        const synced = await page.sync();
        const pay = synced.observation.text.match(/(@e\d+) button "Pay"/)?.[1];
        expect(pay).toEqual(expect.any(String));
        let context = synced.context_id;
        const click = (timeout_ms = 1000) =>
          page.act("tool.click", { context_id: context, ref: pay, timeout_ms });
        await page.mutate("document.querySelector('#pay').disabled = true");
        expect(await click(50)).toMatchObject({
          data: { reason: "target_disabled", effect_state: "none" },
        });
        await page.mutate(`document.querySelector('#pay').disabled = false;
        const cover = document.createElement('div'); cover.id = 'cover';
        cover.style.cssText = 'position:fixed;inset:0;background:white;z-index:9999'; document.body.append(cover)`);
        expect(await click()).toMatchObject({
          data: { reason: "target_covered", phase: "target" },
        });
        // Pointer preparation may have hovered the page; reconcile that unknown effect.
        await page.mutate("document.querySelector('#cover').remove()");
        context = (await page.sync()).context_id;
        await page.mutate(
          "const old = document.querySelector('#pay'); const replacement = old.cloneNode(true); old.replaceWith(replacement)",
        );
        expect(await click()).toMatchObject({
          data: { reason: "target_detached", phase: "target", effect_state: "none" },
        });
        expect((await page.inputs()).clicks).toEqual([]);
      },
      { policy: "target" },
    );
  }, 120_000);

  it("rejects ambiguous selectors and rejects the old context after navigation", async () => {
    await withCooperation(
      async (page) => {
        await page.open("live");
        const synced = await page.sync();
        const ambiguous = await page.click(synced.context_id, "button");
        expect(ambiguous).toMatchObject({
          code: "invalid_params",
          message: expect.stringContaining("selector matched 2 elements"),
        });
        expect((await page.inputs()).clicks).toEqual([]);
        await page.open("live");
        expect(await page.click(synced.context_id, "#pay")).toMatchObject({
          data: {
            reason: "control_context_invalid",
            phase: "control",
            effect_state: "none",
          },
        });
        expect((await page.inputs()).clicks).toEqual([]);
        const fresh = await page.sync();
        expect(fresh.context_id).not.toBe(synced.context_id);
        expect(await page.click(fresh.context_id, "#pay")).not.toHaveProperty("code");
        expect((await page.inputs()).clicks).toEqual(["pay:true"]);
      },
      { policy: "target" },
    );
  }, 120_000);

  it("does not send a directed key to a page-redirected focus recipient", async () => {
    await withCooperation(
      async (page) => {
        await page.open("redirect");
        const synced = await page.sync();
        const pressed = await page.act("tool.press", {
          context_id: synced.context_id,
          selector: "#requested",
          key: "Enter",
        });
        expect(pressed).toMatchObject({
          data: { reason: "target_focus_lost", phase: "target", effect_state: "unknown" },
        });
        expect(await page.read("document.activeElement.id")).toBe("other");
        expect((await page.inputs()).keys).toEqual([]);
      },
      { policy: "target" },
    );
  }, 120_000);

  it("keeps a sync baseline through visual observation and screenshot, then consumes it once", async () => {
    await withCooperation(
      async (page) => {
        await page.open("canvas");
        const synced = await page.sync();
        const observed = await page.observe(true);
        const canvas = observed.text.match(/(@e\d+) canvas.*\[visual:screenshot\]/)?.[1];
        expect(canvas, JSON.stringify(observed)).toEqual(expect.any(String));
        expect(observed.observation_id).not.toBe(synced.observation_id);
        const shot = await page.screenshot(canvas);
        expect(shot.capture_id, JSON.stringify(shot.capture_unavailable)).toEqual(
          expect.any(String),
        );
        const params = {
          context_id: synced.context_id,
          observation_id: synced.observation_id,
          ref: canvas,
          capture_id: shot.capture_id,
          image_x: shot.width / 2,
          image_y: shot.height / 2,
        };
        const clicked = await page.act("tool.click", params);
        expect(clicked, JSON.stringify(clicked)).not.toHaveProperty("code");
        expect((await page.inputs()).clicks).toEqual(["canvas:true"]);
        expect(await page.act("tool.click", params)).toMatchObject({
          data: {
            reason: "observation_required",
            phase: "observation",
            effect_state: "none",
          },
        });
        expect((await page.inputs()).clicks).toEqual(["canvas:true"]);
      },
      { policy: "target" },
    );
  }, 120_000);
});
