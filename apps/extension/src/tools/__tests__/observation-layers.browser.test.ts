// @vitest-environment node
// Reuses the CI browser opt-in; every run owns its Chrome profile.
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  type FrameDocumentGraph,
  type FrameDocumentInfo,
  toFrameDocumentHandle,
} from "@/browser-driver/frame-handles";
import { SessionManager } from "@/session-manager/manager";
import { handleClick } from "../interaction";
import { handleObserve, handleSnapshot } from "../observation";
import { type CdpRunner, createStubCdpRunner } from "../shared";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
type FrameTree = { frame: { id: string; loaderId?: string }; childFrames?: FrameTree[] };

const cases = [
  { name: "sidebar 64%", width: 64 },
  { name: "sidebar 95%", width: 95 },
  { name: "nonmodal dialog role", width: 64, role: "dialog" },
  { name: "nonmodal alertdialog role", width: 64, role: "alertdialog" },
  { name: "native show", width: 64, native: "show" },
  { name: "native showModal", width: 64, native: "showModal", modal: true },
  { name: "ARIA modal", width: 64, role: "dialog", modal: true },
  { name: "small native modal", width: 20, native: "showModal", small: true, modal: true },
  { name: "small ARIA modal", width: 20, role: "dialog", small: true, modal: true },
  { name: "ignored ARIA modal", width: 64, role: "dialog", ariaModal: true, ignored: true },
  { name: "ARIA modal on a non-dialog", width: 64, ariaModal: true },
  { name: "CSS backdrop", width: 64, backdrop: true },
  { name: "pointer-transparent sidebar", width: 95, transparent: true },
  { name: "iframe beside sidebar", width: 64, frame: true },
];

function fixture(c: (typeof cases)[number]): string {
  const tag = c.native ? "dialog" : "aside";
  return `<!doctype html><style>
    * { box-sizing: border-box; } html,body { margin:0; }
    main { width:${100 - c.width}vw; padding:8px; }
    button { display:block; width:100%; height:32px; margin:0 0 8px; padding:0; }
    #panel { position:fixed; right:0; top:0; left:auto; bottom:auto; margin:0;
      width:${c.width}vw; height:${c.small ? "120px" : "100vh"}; max-width:none; max-height:none;
      background:white; border:0; padding:8px; z-index:10; ${c.transparent ? "pointer-events:none;" : ""} }
    #covered { position:absolute; top:200px; left:60vw; width:80px; }
    #offscreen { position:absolute; top:150vh; left:8px; width:120px; }
    #backdrop { position:fixed; inset:0; z-index:9; background:#0008; }
    iframe { width:100%; height:120px; border:0; }
  </style><main>
    <button id="main">Main action</button>
    <canvas aria-label="Main canvas" width="40" height="30"></canvas>
    ${c.frame ? `<iframe srcdoc="<button id='child' onclick='parent.frameClicks++'>Frame action</button>"></iframe>` : ""}
  </main><button id="covered">Covered action</button>
  <button id="offscreen">Offscreen action</button>
  ${c.backdrop ? '<div id="backdrop"></div>' : ""}
  <${tag} id="panel" ${c.role ? `role="${c.role}"` : ""} ${c.ariaModal || (c.modal && !c.native) ? 'aria-modal="true"' : c.role ? 'aria-modal="false"' : ""} ${c.ignored ? 'aria-hidden="true"' : ""}>
    <button id="inside">Panel action</button>
  </${tag}>`;
}

function partialOverlapFixture(): string {
  return `<!doctype html><style>
    * { box-sizing: border-box; } html,body { margin:0; min-height:2000px; }
    #sticky-bar { position:sticky; top:0; height:48px; width:100%; background:#fff; z-index:10; }
    #card-wrap { position:absolute; left:24px; top:180px; width:240px; height:180px; }
    #product-card { display:block; width:240px; height:180px; padding:12px; background:#f5f5f5; }
    #card-badge { position:absolute; top:4px; right:4px; width:48px; height:24px; background:#f50; color:#fff; }
    #sticky-grazed { position:absolute; left:300px; top:138px; width:160px; height:44px; }
    #fab-card { position:fixed; right:16px; bottom:16px; width:240px; height:120px; display:block; padding:12px; background:#f0f8ff; z-index:1; }
    #fab-ball { position:fixed; right:16px; bottom:16px; width:56px; height:56px; z-index:10; }
    #covered-container { position:absolute; left:40px; top:400px; width:160px; height:80px; background:#eee; }
    #escaped-child { position:absolute; left:190px; top:20px; width:130px; height:36px; }
    #partial-panel { position:fixed; left:30px; top:290px; width:180px; height:160px; z-index:10; background:#fff; padding:8px; }
    #truly-covered { position:absolute; left:50px; top:490px; width:120px; height:32px; }
    #neg-z-card { position:absolute; left:520px; top:220px; width:220px; height:100px; z-index:0; padding:16px; }
    #neg-z-bg { position:absolute; inset:0; z-index:-1; background:#eef; }
    #neg-z-bg-img { position:absolute; inset:0; width:100%; height:100%; }
    #neg-z-btn { width:150px; height:36px; }
  </style>
  <header id="sticky-bar"><span>Top Nav</span></header>
  <main>
    <div id="card-wrap">
      <a id="product-card" href="#product">Product Card</a>
      <span id="card-badge">促销</span>
    </div>
    <button id="sticky-grazed">Sticky Grazed</button>
    <a id="fab-card" href="#support-card">Corner Card</a>
    <div id="covered-container" role="button" tabindex="0">
      <span>Covered Container</span>
      <button id="escaped-child">Escaped Child</button>
    </div>
    <button id="truly-covered">Truly Covered</button>
    <div id="neg-z-card">
      <div id="neg-z-bg"><img id="neg-z-bg-img" alt="Decor" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" /></div>
      <button id="neg-z-btn">Over Negative Z</button>
    </div>
  </main>
  <aside id="partial-panel"><button id="panel-btn">Panel Button</button></aside>
  <button id="fab-ball">客服</button>`;
}

describe.skipIf(!process.env.BSK_TEST_CHROME)("real browser observation layers", () => {
  it.each([
    { deviceScale: 1, zoom: 1 },
    { deviceScale: 1.25, zoom: 1 },
    { deviceScale: 1.5, zoom: 1 },
    { deviceScale: 1, zoom: 1.1 },
  ])("preserves sidebar, modal and backdrop behavior at DPR $deviceScale / zoom $zoom", async ({
    deviceScale,
    zoom,
  }) => {
    const { withChrome } = await import(
      new URL(
        "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
        import.meta.url,
      ).href
    );
    // A normal origin is needed for Chrome's saved page zoom to apply.
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><title>Observation layers</title>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      await withChrome(
        { executable: process.env.BSK_TEST_CHROME, deviceScale, zoom, startupTimeout: 30_000 },
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
          await local("Page.navigate", { url });
          await expect.poll(() => evaluate("document.title")).toBe("Observation layers");
          const metrics = await local<{ cssVisualViewport: { zoom: number } }>(
            "Page.getLayoutMetrics",
          );
          expect(metrics.cssVisualViewport.zoom).toBeCloseTo(zoom, 4);
          expect(await evaluate<number>("devicePixelRatio")).toBeCloseTo(deviceScale * zoom, 4);
          const graph = async (): Promise<FrameDocumentGraph> => {
            const { frameTree } = await local<{ frameTree: FrameTree }>("Page.getFrameTree");
            const frames: FrameDocumentInfo[] = [];
            const visit = async (tree: FrameTree, parentFrameId?: string) => {
              const owner = parentFrameId
                ? await local<{ backendNodeId: number }>("DOM.getFrameOwner", {
                    frameId: tree.frame.id,
                  })
                : undefined;
              const loaderId = tree.frame.loaderId ?? "";
              frames.push({
                handle: toFrameDocumentHandle(4, { frameId: tree.frame.id, loaderId }),
                frameId: tree.frame.id,
                loaderId,
                parentFrameId,
                ownerBackendNodeId: owner?.backendNodeId,
                processKey: "root",
                isOutOfProcess: false,
              });
              for (const child of tree.childFrames ?? []) await visit(child, tree.frame.id);
            };
            await visit(frameTree);
            return { rootFrameId: frameTree.frame.id, frames };
          };
          const cdp: CdpRunner = createStubCdpRunner({
            send: (_tabId, method, params) => local(method, params),
            sendToFrame: (_handle, method, params) => local(method, params),
            getAttachmentId: () => sessionId,
            getFrameDocuments: graph,
          });
          const manager = new SessionManager({
            agentWindow: {
              create: async () => ({ windowId: 100, initialTabIds: [] }),
              remove: async () => {},
              ensureActiveTab: async () => 4,
            },
          });
          const ctx = await manager.start("layers");
          const tab = { id: 4, windowId: 100, active: true, url } as chrome.tabs.Tab;
          const tabsApi = { get: async () => tab, query: async () => [tab] };
          for (const c of cases) {
            await evaluate(`document.open(); document.write(${JSON.stringify(fixture(c))}); document.close();
          window.mainClicks=[]; window.frameClicks=0;
          document.querySelector('#main').onclick=e=>mainClicks.push(e.isTrusted);
          document.querySelector('canvas').getContext('2d').fillRect(0,0,40,30);
          scrollTo(0,0);
          ${c.native ? `document.querySelector('#panel').${c.native}();` : ""}`);
            if (c.frame)
              await expect
                .poll(() =>
                  evaluate(
                    "!!document.querySelector('iframe').contentDocument?.querySelector('#child')",
                  ),
                )
                .toBe(true);
            const result = await handleObserve(
              manager,
              { session_id: ctx.sessionId },
              { cdp, tabsApi, conditionalSurfaceProbe: false },
            );
            expect(result, c.name + ": " + JSON.stringify(result)).not.toHaveProperty("code");
            if (!("text" in result)) throw new Error("Observation failed");
            const blocked = c.modal || c.backdrop || false;
            const mainRef = result.text.match(/(@e\d+) button "Main action"/)?.[1];
            expect(!!mainRef, c.name + "\n" + result.text).toBe(!blocked);
            expect(result.text.includes("@layers 2"), c.name + "\n" + result.text).toBe(blocked);
            if (blocked) expect(result.text, c.name).not.toContain('button "Offscreen action"');
            if (c.backdrop) expect(result.text, c.name).toContain("L1 mask cover=100%");
            expect(result.text.includes("[visual:screenshot]"), c.name + "\n" + result.text).toBe(
              !blocked,
            );
            if (!blocked) {
              const hit = await evaluate<boolean>(
                `(() => { const b=document.querySelector('#main'),r=b.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b; })()`,
              );
              expect(hit, c.name).toBe(true);
              const clicked = await handleClick(
                manager,
                { session_id: ctx.sessionId, ref: mainRef },
                { cdp, tabsApi },
              );
              expect(clicked, c.name + ": " + JSON.stringify(clicked)).not.toHaveProperty("code");
              expect(await evaluate("mainClicks"), c.name).toEqual([true]);
            }
            if (!c.transparent && !c.small && !c.ignored && !blocked)
              expect(result.text, c.name).not.toContain('button "Covered action"');
            if (c.frame) {
              const frameRef = result.text.match(/(@e\d+) button "Frame action"/)?.[1];
              expect(frameRef, result.text).toBeDefined();
              const clicked = await handleClick(
                manager,
                { session_id: ctx.sessionId, ref: frameRef },
                { cdp, tabsApi },
              );
              expect(clicked).not.toHaveProperty("code");
              expect(await evaluate("frameClicks")).toBe(1);
            }
          }

          // Real-DOM partial-overlap, sticky graze, floating widget graze, covered-container
          // child rescue, and negative z-index background regression check.
          await evaluate(`document.open(); document.write(${JSON.stringify(partialOverlapFixture())}); document.close();
          window.clicks = {};
          for (const id of ['product-card', 'sticky-grazed', 'fab-card', 'escaped-child', 'neg-z-btn']) {
            const el = document.getElementById(id);
            el.onclick = (e) => { e.preventDefault(); window.clicks[id] = [...(window.clicks[id] || []), e.isTrusted]; };
          }
          scrollTo(0, 100);`);
          await expect.poll(() => evaluate<number>("Math.round(scrollY)")).toBe(100);

          const partialObs = await handleObserve(
            manager,
            { session_id: ctx.sessionId },
            { cdp, tabsApi, conditionalSurfaceProbe: false },
          );
          expect(partialObs, JSON.stringify(partialObs)).not.toHaveProperty("code");
          if (!("text" in partialObs)) throw new Error("Partial-overlap observation failed");
          expect(partialObs.text).toContain("@layers 1 focus=L1");
          expect(partialObs.text).toContain("L1 page");
          expect(partialObs.text).not.toContain('button "Covered Container"');
          expect(partialObs.text).not.toContain('button "Truly Covered"');
          expect(partialObs.text).toContain('button "Panel Button"');
          expect(partialObs.text).toContain('button "客服"');

          const expectedTargets = [
            { id: "sticky-grazed", pattern: /(@e\d+) button "Sticky Grazed"/ },
            { id: "product-card", pattern: /(@e\d+) link "Product Card"/ },
            { id: "fab-card", pattern: /(@e\d+) link "Corner Card"/ },
            { id: "escaped-child", pattern: /(@e\d+) button "Escaped Child"/ },
            { id: "neg-z-btn", pattern: /(@e\d+) button "Over Negative Z"/ },
          ];
          for (const item of expectedTargets) {
            const ref = partialObs.text.match(item.pattern)?.[1];
            expect(ref, `${item.id}\n${partialObs.text}`).toBeDefined();
            const hit = await evaluate<boolean>(
              `(() => { const el=document.getElementById(${JSON.stringify(item.id)}), r=el.getBoundingClientRect(); const hit=document.elementFromPoint(r.x+r.width/2, r.y+r.height/2); return hit === el || el.contains(hit); })()`,
            );
            expect(hit, `elementFromPoint(${item.id})`).toBe(true);
            const clicked = await handleClick(
              manager,
              { session_id: ctx.sessionId, ref },
              { cdp, tabsApi },
            );
            expect(clicked, `${item.id}: ${JSON.stringify(clicked)}`).not.toHaveProperty("code");
            expect(await evaluate(`window.clicks[${JSON.stringify(item.id)}]`), item.id).toEqual([
              true,
            ]);
          }

          const partialSnap = await handleSnapshot(
            manager,
            { session_id: ctx.sessionId },
            { cdp, tabsApi },
          );
          expect(partialSnap, JSON.stringify(partialSnap)).not.toHaveProperty("code");
          if (!("text" in partialSnap)) throw new Error("Partial-overlap snapshot failed");
          for (const item of expectedTargets) {
            expect(partialSnap.text, item.id).toMatch(item.pattern);
          }
          expect(partialSnap.text).not.toContain('button "Truly Covered"');
        },
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 90_000);
});
