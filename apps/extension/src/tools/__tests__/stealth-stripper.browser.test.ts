// @vitest-environment node
// End-to-end real-browser regressions for VOM hidden-text stripping, hero-page
// white-headline preservation, cross-frame scene annotations, and Open Shadow DOM
// / <select> / checkbox form state accuracy.
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  type FrameDocumentGraph,
  type FrameDocumentInfo,
  toFrameDocumentHandle,
} from "@/browser-driver/frame-handles";
import { SessionManager } from "@/session-manager/manager";
import { handleObserve, handleSnapshot } from "../observation";
import { type CdpRunner, createStubCdpRunner } from "../shared";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
type FrameTree = { frame: { id: string; loaderId?: string }; childFrames?: FrameTree[] };

const IFRAME_HTML = `<!doctype html>
<body style="margin:0;background:#ffffff">
  <span style="opacity:0">INJ_IFRAME_OPACITY_ZERO</span>
  <div style="overflow:auto;width:160px;height:40px">
    <span style="position:relative;left:-99999px">INJ_IFRAME_UNSCROLLED_REL</span>
  </div>
  <button id="frame-btn">Frame Checkout</button>
</body>`;

const MAIN_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>VOM Accuracy &amp; Hero Preservation E2E</title>
  <style>
    html, body { margin: 0; background: #ffffff; color: #111827; font-family: sans-serif; }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .dark-oklch {
      background-color: oklch(0.208 0.042 265.755);
      padding: 12px;
    }
    .scrim-oklch {
      background-color: oklch(0.208 0.042 265.755 / 60%);
      padding: 12px;
    }
    .hero-section {
      position: relative;
      height: 120px;
      padding: 20px;
      overflow: hidden;
    }
    .hero-before::before {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(135deg, #0f172a, #1e293b);
      z-index: 0;
    }
    .hero-before > h1 {
      position: relative;
      z-index: 1;
      color: #ffffff;
      margin: 0;
    }
    .hero-svg > svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      z-index: 0;
    }
    .hero-svg > h1 {
      position: relative;
      z-index: 1;
      color: #ffffff;
      margin: 0;
    }
    .hero-img > img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      /* Own PaintLayer (composited) with positive paintOrder while text stays normal flow */
      transform: translateZ(0);
      z-index: 0;
    }
    .hero-img > h1 {
      position: relative;
      z-index: 1;
      color: #ffffff;
      margin: 0;
    }
    .hero-sibling-overlay > .scrim {
      position: absolute;
      inset: 0;
      background: #111827;
    }
    .hero-sibling-overlay > h1 {
      position: relative;
      color: #ffffff;
      margin: 0;
    }
  </style>
</head>
<body>
  <main>
    <!-- 1. Mainstream hero banners: white headlines over <svg>, ::before, composited <img>, sibling overlays & gradient text MUST NEVER be dropped -->
    <section class="hero-section hero-svg">
      <svg viewBox="0 0 1200 200" preserveAspectRatio="none" aria-hidden="true">
        <rect width="1200" height="200" fill="#0f172a" />
      </svg>
      <h1>Build Reliable Workflows Over SVG Hero</h1>
    </section>

    <section class="hero-section hero-before">
      <h1>Deploy Globally Over Pseudo Backdrop</h1>
    </section>

    <section class="hero-section hero-img">
      <img alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Crect width='64' height='64' fill='%231e293b'/%3E%3C/svg%3E" />
      <h1>Launch Faster Over Composited Hero Image</h1>
    </section>

    <section class="hero-section hero-sibling-overlay">
      <div class="scrim"></div>
      <h1>Scale Safely Over Sibling Overlay</h1>
    </section>

    <h1 style="background:linear-gradient(to right, #2563eb, #9333ea);-webkit-background-clip:text;background-clip:text;color:transparent">
      Ship AI Agents <strong>10x Faster</strong>
    </h1>
    <div style="display:grid;grid-template-columns:1fr 1fr;background:#121212 linear-gradient(to right, #fff 50%, #121212 50%)">
      <h2 style="color:#121212">Order confirmed for pickup</h2>
      <h2 style="color:#fff">Track your delivery</h2>
    </div>

    <!-- Genuine invisible text (transparent fg without clip-text image, same-element white-on-white, opacity:0) IS stripped -->
    <span style="color:transparent">INJ_TRANSPARENT_FG</span>
    <span style="color:oklch(0.9 0.05 200 / 0)">INJ_OKLCH_TRANSPARENT_FG</span>
    <span style="background-clip:text;-webkit-background-clip:text;background-image:none;color:transparent">
      INJ_CLIP_TEXT_NO_IMAGE
    </span>
    <span style="color:#ffffff;background-color:#ffffff">INJ_SELF_WHITE_ON_WHITE</span>
    <span style="opacity:0.001">INJ_OPACITY_ZERO</span>

    <!-- 2. Unscrolled vs genuinely scrolled overflow:auto/scroll containers -->
    <div id="unscrolled-box" style="overflow:auto;width:240px;height:80px;position:relative">
      <div style="position:relative;left:-99999px">INJ_UNSCROLLED_REL</div>
      <div style="position:absolute;left:-2000px">INJ_UNSCROLLED_ABS</div>
      <div style="margin-left:-2000px">INJ_UNSCROLLED_MARGIN</div>
      <div style="text-indent:-9999px">INJ_TEXT_INDENT</div>
      <div>Visible Unscrolled Summary</div>
    </div>
    <a href="/home" style="display:block;width:120px;height:28px;text-indent:-9999px">Brand Home</a>

    <div id="scrolled-modal" style="overflow-y:auto;overflow-x:hidden;width:260px;height:100px;position:relative">
      <div style="height:40px">Modal historical row #1</div>
      <div style="position:relative;left:-2000px">INJ_SCROLLED_MODAL_OFF_X</div>
      <div style="position:relative;top:-5000px">INJ_SCROLLED_MODAL_EXTREME_Y</div>
      <div style="height:1200px">Modal spacer</div>
      <div style="height:40px">Modal active bottom row</div>
    </div>

    <div id="scrolled-table" style="overflow-x:scroll;overflow-y:hidden;width:220px;height:60px">
      <div style="width:1400px;display:flex">
        <span style="width:200px;flex:none">Order #8891</span>
        <span style="width:900px;flex:none">Spacer Column</span>
        <span style="width:200px;flex:none">Amount $420.00</span>
      </div>
    </div>

    <!-- 3. Tailwind v4 dark oklch cards & scrims preserve white text -->
    <div class="dark-oklch">
      <p style="color:#ffffff">Tailwind Dark Card Heading</p>
    </div>
    <div class="scrim-oklch">
      <p style="color:#ffffff">Translucent Scrim Banner</p>
    </div>

    <!-- 4. Retained textstyle containers, nested AX text exclusion, hidden children, and >80c button payload -->
    <h2 style="font-size:0">
      INJ_HEADING_DIRECT <span style="font-size:18px">Quarterly Revenue</span>
    </h2>
    <h3>
      <span>Net Margin</span>
      <span id="nested-stealth-wrap"><span style="color:transparent">INJ_HEADING_NESTED_SPAN</span></span>
    </h3>
    <div style="font-size:0" aria-label="INJ_HIDDEN_CHILD_ARIA">
      <span style="display:none">hidden1</span>
      <span style="visibility:hidden">hidden2</span>
      <span style="opacity:0">hidden3</span>
    </div>
    <button id="pay-btn">
      <span style="font-size:0">INJ_BUTTON_LONG_PAYLOAD_${"X".repeat(90)}</span>
      Confirm Payment
    </button>
    <button id="close-btn" aria-HasPopup="false">
      <span class="sr-only">Close dialog</span>
    </button>

    <!-- 5. 2x HiDPI 1px microboxes vs padded / overflowing visible boxes + child iframe -->
    <div style="width:1px;height:1px;overflow:hidden">INJ_HIDPI_CLIP</div>
    <div style="width:1px;height:1px;overflow:visible">INJ_HIDPI_MICROBOX</div>
    <div style="width:1px;height:1px;padding:18px;overflow:hidden">Padded Badge</div>
    <div style="width:1px;height:1px;overflow:visible">
      <span style="display:block;width:120px;height:24px">Overflowing Popover</span>
    </div>

    <iframe src="/frame" style="width:300px;height:90px;border:0"></iframe>
  </main>
</body>
</html>`;

const STEALTH_PAYLOADS = [
  "INJ_TRANSPARENT_FG",
  "INJ_OKLCH_TRANSPARENT_FG",
  "INJ_CLIP_TEXT_NO_IMAGE",
  "INJ_SELF_WHITE_ON_WHITE",
  "INJ_OPACITY_ZERO",
  "INJ_UNSCROLLED_REL",
  "INJ_UNSCROLLED_ABS",
  "INJ_UNSCROLLED_MARGIN",
  "INJ_TEXT_INDENT",
  "INJ_SCROLLED_MODAL_OFF_X",
  "INJ_SCROLLED_MODAL_EXTREME_Y",
  "INJ_HEADING_DIRECT",
  "INJ_HEADING_NESTED_SPAN",
  "INJ_HIDDEN_CHILD_ARIA",
  "INJ_BUTTON_LONG_PAYLOAD_",
  "INJ_HIDPI_CLIP",
  "INJ_HIDPI_MICROBOX",
  "INJ_IFRAME_OPACITY_ZERO",
  "INJ_IFRAME_UNSCROLLED_REL",
];

const VISIBLE_CONTENT = [
  "Build Reliable Workflows Over SVG Hero",
  "Deploy Globally Over Pseudo Backdrop",
  "Launch Faster Over Composited Hero Image",
  "Scale Safely Over Sibling Overlay",
  "Ship AI Agents",
  "10x Faster",
  "Order confirmed for pickup",
  "Track your delivery",
  "Visible Unscrolled Summary",
  "Brand Home",
  "Modal historical row #1",
  "Modal active bottom row",
  "Order #8891",
  "Amount $420.00",
  "Tailwind Dark Card Heading",
  "Translucent Scrim Banner",
  "Quarterly Revenue",
  "Net Margin",
  "Confirm Payment",
  "Close dialog",
  "Padded Badge",
  "Overflowing Popover",
  "Frame Checkout",
];

const FORM_AND_SCOPE_CHILD_HTML = `<!doctype html>
<body style="margin:0;background:#fff;font-family:sans-serif">
  <button role="tab" aria-selected="true" aria-controls="shared-panel">OOPIF Tab</button>
  <button role="tab" aria-selected="true" aria-controls="main-only-panel">OOPIF Missing Panel Tab</button>
  <div id="shared-panel">
    <p>OOPIF Active Panel Visible Line</p>
    <p style="display:none">IFRAME_SCOPE_DISPLAY_NONE</p>
    <p style="visibility:hidden">IFRAME_SCOPE_VISIBILITY_HIDDEN</p>
  </div>
</body>`;

function formAndScopeMainHtml(port: number): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>VOM Scopes &amp; Shadow Forms E2E</title></head>
<body style="margin:0;background:#fff;font-family:sans-serif">
  <main>
    <button role="tab" aria-selected="true" aria-controls="shared-panel">Main Tab</button>
    <div id="shared-panel">
      <p>Main Active Panel Visible Line</p>
      <div style="display:none">MAIN_SCOPE_DISPLAY_NONE</div>
      <div style="visibility:hidden">MAIN_SCOPE_VISIBILITY_HIDDEN</div>
      <div style="opacity:0"><span>MAIN_SCOPE_OPACITY_ZERO</span></div>
      <select aria-label="Panel Secret Plan">
        <option value="vip">MAIN_SCOPE_SELECT_OPTION</option>
      </select>
    </div>
    <div id="main-only-panel">MAIN_ONLY_SECRET_TEXT</div>
    <div id="order-card-a"></div>
    <div id="order-card-b"></div>

    <form id="checkout-form">
      <label for="country">Country</label>
      <select id="country">
        <option value="us">United States</option>
        <option value="uk">United Kingdom</option>
      </select>
      <label for="terms">Accept Terms</label>
      <input id="terms" type="checkbox" />
      <div id="shadow-host"></div>
    </form>

    <iframe id="scope-frame" src="http://localhost:${port}/scope-frame" style="width:400px;height:140px;border:1px solid #ccc"></iframe>
  </main>
  <script>
    const host = document.getElementById("shadow-host");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML =
      '<label for="shadow-name">Shadow Account Name</label>' +
      '<input id="shadow-name" type="text" value="" />' +
      '<label for="shadow-plan">Shadow Plan</label>' +
      '<select id="shadow-plan"><option value="starter">Starter</option><option value="pro">Pro</option></select>';
    root.getElementById("shadow-name").value = "Alice Shadow";

    for (const [hostId, label, detail] of [
      ["order-card-a", "Order A", "Order A Shadow Details"],
      ["order-card-b", "Order B", "Order B Shadow Details"],
    ]) {
      const card = document.getElementById(hostId);
      const cardRoot = card.attachShadow({ mode: "open" });
      cardRoot.innerHTML =
        '<div class="card">' +
        '<button aria-expanded="true" aria-controls="details">' + label + '</button>' +
        '<div id="details"><p>' + detail + '</p></div>' +
        '</div>';
    }
  </script>
</body>
</html>`;
}

describe.skipIf(!process.env.BSK_TEST_CHROME)(
  "real browser VOM hidden-text stripping, hero preservation, scopes, and shadow forms",
  () => {
    it("preserves white hero headlines over <svg>/::before/<img>/overlays while stripping genuinely invisible elements at 2x HiDPI", async () => {
      const { withChrome } = await import(
        new URL(
          "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
          import.meta.url,
        ).href
      );
      const server = createServer((req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(req.url === "/frame" ? IFRAME_HTML : MAIN_HTML);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
      try {
        await withChrome(
          {
            executable: process.env.BSK_TEST_CHROME,
            deviceScale: 2,
            zoom: 1,
            startupTimeout: 30_000,
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
            await local("Page.navigate", { url });
            await expect
              .poll(() =>
                evaluate(
                  "Boolean(document.querySelector('iframe')?.contentDocument?.getElementById('frame-btn'))",
                ),
              )
              .toBe(true);
            await evaluate(`(() => {
              document.getElementById("scrolled-modal").scrollTop = 750;
              document.getElementById("scrolled-table").scrollLeft = 650;
              return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            })()`);
            expect(await evaluate<number>("devicePixelRatio")).toBeCloseTo(2, 4);

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
                  handle: toFrameDocumentHandle(7, { frameId: tree.frame.id, loaderId }),
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
                ensureActiveTab: async () => 7,
              },
            });
            const ctx = await manager.start("stealth-e2e");
            const tab = { id: 7, windowId: 100, active: true, url } as chrome.tabs.Tab;
            const tabsApi = { get: async () => tab, query: async () => [tab] };

            const snap = await handleSnapshot(
              manager,
              { session_id: ctx.sessionId, tab_id: 7, max_tokens: 8000 },
              { cdp, tabsApi },
            );
            expect(snap).not.toHaveProperty("code");
            const snapText = "text" in snap ? snap.text : "";

            const obs = await handleObserve(
              manager,
              { session_id: ctx.sessionId, tab_id: 7, max_tokens: 8000 },
              { cdp, tabsApi },
            );
            expect(obs).not.toHaveProperty("code");
            const obsText = "text" in obs ? obs.text : "";

            for (const output of [snapText, obsText]) {
              for (const payload of STEALTH_PAYLOADS) {
                expect(output).not.toContain(payload);
              }
              for (const visible of VISIBLE_CONTENT) {
                expect(output).toContain(visible);
              }
            }
          },
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 60_000);

    it("scopes active aria-controls panels per cross-origin OOPIF, skips hidden scope descendants, and captures Open Shadow DOM / <select> / checkbox states accurately", async () => {
      const { withChrome } = await import(
        new URL(
          "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
          import.meta.url,
        ).href
      );
      let port = 0;
      const server = createServer((req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          req.url === "/scope-frame" ? FORM_AND_SCOPE_CHILD_HTML : formAndScopeMainHtml(port),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = (server.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}/`;
      const childUrl = `http://localhost:${port}/scope-frame`;
      try {
        await withChrome(
          {
            executable: process.env.BSK_TEST_CHROME,
            deviceScale: 1,
            zoom: 1,
            startupTimeout: 30_000,
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
            const evaluate = async <T>(expression: string, sid = sessionId) => {
              const reply = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
                "Runtime.evaluate",
                { expression, returnByValue: true, awaitPromise: true },
                sid,
              );
              expect(reply.exceptionDetails).toBeUndefined();
              return reply.result.value;
            };
            await local("Page.enable");
            await local("Page.bringToFront");
            await local("Page.navigate", { url });
            let oopifTarget: { targetId: string; type: string; url: string } | undefined;
            await expect
              .poll(async () => {
                const { targetInfos } = await send<{
                  targetInfos: Array<{ targetId: string; type: string; url: string }>;
                }>("Target.getTargets");
                oopifTarget = targetInfos.find((t) => t.type === "iframe" && t.url === childUrl);
                return Boolean(oopifTarget);
              })
              .toBe(true);
            const { sessionId: oopifSession } = await send<{ sessionId: string }>(
              "Target.attachToTarget",
              { targetId: oopifTarget!.targetId, flatten: true },
            );
            await send("Page.enable", {}, oopifSession);
            await expect
              .poll(() =>
                evaluate("Boolean(document.getElementById('shared-panel'))", oopifSession),
              )
              .toBe(true);

            const { frameTree: rootTree } = await local<{ frameTree: FrameTree }>(
              "Page.getFrameTree",
            );
            const { frameTree: oopifTree } = await send<{ frameTree: FrameTree }>(
              "Page.getFrameTree",
              {},
              oopifSession,
            );
            const oopifOwner = await local<{ backendNodeId: number }>("DOM.getFrameOwner", {
              frameId: oopifTree.frame.id,
            });
            const frameSessionById = new Map<string, string>([
              [rootTree.frame.id, sessionId],
              [oopifTree.frame.id, oopifSession],
            ]);
            const graph = async (): Promise<FrameDocumentGraph> => ({
              rootFrameId: rootTree.frame.id,
              frames: [
                {
                  handle: toFrameDocumentHandle(8, {
                    frameId: rootTree.frame.id,
                    loaderId: rootTree.frame.loaderId ?? "",
                  }),
                  frameId: rootTree.frame.id,
                  loaderId: rootTree.frame.loaderId ?? "",
                  processKey: "root",
                  isOutOfProcess: false,
                },
                {
                  handle: toFrameDocumentHandle(8, {
                    frameId: oopifTree.frame.id,
                    loaderId: oopifTree.frame.loaderId ?? "",
                  }),
                  frameId: oopifTree.frame.id,
                  loaderId: oopifTree.frame.loaderId ?? "",
                  parentFrameId: rootTree.frame.id,
                  ownerBackendNodeId: oopifOwner.backendNodeId,
                  processKey: oopifSession,
                  isOutOfProcess: true,
                },
              ],
            });
            const cdp: CdpRunner = createStubCdpRunner({
              send: (_tabId, method, params) => local(method, params),
              sendToFrame: (handle, method, params) =>
                send(method, params, frameSessionById.get(handle.frameId) ?? sessionId),
              getAttachmentId: () => sessionId,
              getFrameDocuments: graph,
            });
            const manager = new SessionManager({
              agentWindow: {
                create: async () => ({ windowId: 101, initialTabIds: [] }),
                remove: async () => {},
                ensureActiveTab: async () => 8,
              },
            });
            const ctx = await manager.start("vom-scopes-forms-e2e");
            const tab = { id: 8, windowId: 101, active: true, url } as chrome.tabs.Tab;
            const tabsApi = { get: async () => tab, query: async () => [tab] };

            let capturedScene: import("@browser-skill/vom").VomScene | undefined;
            const obs = await handleObserve(
              manager,
              { session_id: ctx.sessionId, tab_id: 8, max_tokens: 8000 },
              {
                cdp,
                tabsApi,
                onScene: (scene) => {
                  capturedScene = scene;
                },
              },
            );
            expect(obs).not.toHaveProperty("code");
            const text = "text" in obs ? obs.text : "";

            // 1) Active scope blocks: both main document and cross-origin OOPIF resolve their
            // OWN #shared-panel, hidden descendants and <select> options are excluded from scope
            // lines, OOPIF's #main-only-panel does NOT cross-link into the main document, and
            // repeated Open Shadow DOM hosts reusing #details resolve their own shadow panel.
            expect(text).toContain("[§ active: Main Tab]");
            expect(text).toContain("Main Active Panel Visible Line");
            expect(text).toContain("[§ active: OOPIF Tab]");
            expect(text).toContain("OOPIF Active Panel Visible Line");
            expect(text).toContain("[§ active: Order A]");
            expect(text).toContain("Order A Shadow Details");
            expect(text).toContain("[§ active: Order B]");
            expect(text).toContain("Order B Shadow Details");
            expect(text).not.toContain("MAIN_SCOPE_DISPLAY_NONE");
            expect(text).not.toContain("MAIN_SCOPE_VISIBILITY_HIDDEN");
            expect(text).not.toContain("MAIN_SCOPE_OPACITY_ZERO");
            expect(text).not.toContain("IFRAME_SCOPE_DISPLAY_NONE");
            expect(text).not.toContain("IFRAME_SCOPE_VISIBILITY_HIDDEN");
            expect(text).not.toContain("[§ active: OOPIF Missing Panel Tab]");
            const scopeByLabel = new Map(
              (capturedScene?.activeScopeBlocks ?? []).map((block) => [block.label, block.lines]),
            );
            expect(scopeByLabel.get("Main Tab")).toEqual(["Main Active Panel Visible Line"]);
            expect(scopeByLabel.get("OOPIF Tab")).toEqual(["OOPIF Active Panel Visible Line"]);
            expect(scopeByLabel.get("Order A")).toEqual(["Order A Shadow Details"]);
            expect(scopeByLabel.get("Order B")).toEqual(["Order B Shadow Details"]);

            // 2) Unchecked checkbox omits synthetic ='on' and is NOT marked filled.
            expect(text).toMatch(
              /checkbox "Accept Terms"(?: \[ctx: [^\]]+\])? \[unchecked\](?! ="on")/,
            );
            expect(text).not.toContain('[unchecked] ="on"');
            const termsNode = capturedScene?.nodes.find(
              (n) => n.role === "checkbox" && n.name === "Accept Terms",
            );
            expect(termsNode?.inputState).toBe("empty");
            expect(termsNode?.checked).toBe(false);

            // 3) Untouched <select> (both light DOM and Open Shadow DOM) is 'default', NOT 'filled'.
            const countryNode = capturedScene?.nodes.find(
              (n) => n.tag === "select" && n.name === "Country",
            );
            expect(countryNode?.inputState).toBe("default");
            const shadowPlanNode = capturedScene?.nodes.find(
              (n) => n.tag === "select" && n.name === "Shadow Plan",
            );
            expect(shadowPlanNode?.inputState).toBe("default");

            // 4) Open Shadow DOM <input> live value is enriched accurately.
            expect(text).toMatch(
              /textbox "Shadow Account Name"(?: \[ctx: [^\]]+\])? \[filled\] ="Alice Shadow"/,
            );
          },
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 60_000);
  },
);
