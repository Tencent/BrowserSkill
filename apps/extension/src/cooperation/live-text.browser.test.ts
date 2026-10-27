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
import { handleClick, handleFill, handlePress } from "@/tools/interaction";
import type { CdpRunner } from "@/tools/shared";
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
  addEventListener("click", (e) => clicks.push(e.target.id + ":" + e.isTrusted), true);
  addEventListener("keydown", (e) => keys.push(e.key + ":" + e.isTrusted), true);
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
};

async function withCooperation(
  run: (page: {
    open(name: string): Promise<void>;
    set(selector: string, text: string): Promise<void>;
    mutate(expression: string): Promise<void>;
    sync(): Promise<Reply>;
    act(method: string, params: object): Promise<Reply>;
    click(context: string, selector: string): Promise<Reply>;
    press(context: string, key: string): Promise<Reply>;
    inputs(): Promise<{ clicks: string[]; keys: string[] }>;
    value(selector: string): Promise<string>;
  }) => Promise<void>,
) {
  const server = createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? "/").slice(1));
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
  try {
    await withChrome(
      { executable: process.env.BSK_CLICK_CHROME, deviceScale: 1, zoom: 1, startupTimeout: 30_000 },
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
          const { frameTree } = await local<{ frameTree: { frame: { id: string } } }>(
            "Page.getFrameTree",
          );
          const root: CdpFrame = { frameId: frameTree.frame.id, target: { tabId: 4 } };
          return { rootFrameId: frameTree.frame.id, frames: [root] };
        };
        const cdp: CdpRunner = {
          send: (_tabId, method, params) => local(method, params),
          sendToTarget: (_target, method, params) => local(method, params),
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
        const frame = async (): Promise<FrameState> => {
          const state = await evaluate<{ document: string; revision: number }>("window.coop");
          return {
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
          };
        };
        const controller = new CooperationController({
          sessions,
          readFrames: async () => new Map([[0, await frame()]]),
          resumeFrames: async () => {},
          changed: () => {},
        });
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
        };
        const act = (method: string, params: object) =>
          controller.run(
            { id: method, method, params: { session_id: "shared", tab_id: 4, ...params } },
            cdp,
            signal,
            (runner, operationSignal) =>
              handlers[method](sessions, { session_id: "shared", tab_id: 4, ...params } as never, {
                cdp: runner as CdpRunner,
                tabsApi,
                signal: operationSignal as AbortSignal,
              }),
          ) as Promise<Reply>;
        await run({
          async open(name) {
            tab.url = `${origin}/${name}`;
            await local("Page.navigate", { url: tab.url });
            await expect
              .poll(() =>
                evaluate("document.title === " + JSON.stringify(name) + " && !!window.coop"),
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
              { session_id: "shared", tab_id: 4, action: "sync", timeout_ms: 0 },
              cdp,
              signal,
            ) as Promise<Reply>,
          act,
          click: (context, selector) => act("tool.click", { context_id: context, selector }),
          press: (context, key) => act("tool.press", { context_id: context, key }),
          inputs: () => evaluate("({ clicks, keys })"),
          value: (selector) =>
            evaluate(`document.querySelector(${JSON.stringify(selector)}).value`),
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
