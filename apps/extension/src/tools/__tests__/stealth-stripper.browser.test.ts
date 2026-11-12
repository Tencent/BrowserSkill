// @vitest-environment node
// End-to-end real-browser regression for computed-style stealth prompt-injection stripping.
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import type { CdpFrame, CdpFrameGraph } from "@/browser-driver/frame-graph";
import { SessionManager } from "@/session-manager/manager";
import { handleObserve, handleSnapshot } from "../observation";
import type { CdpRunner } from "../shared";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] };

const IFRAME_HTML = `<!doctype html>
<body style="margin:0;background:#ffffff">
  <span style="background-clip:text;-webkit-background-clip:text;background-image:linear-gradient(transparent,transparent);color:transparent">
    INJ_IFRAME_GRAD_TRANSPARENT
  </span>
  <div style="overflow:auto;width:160px;height:40px">
    <span style="position:relative;left:-99999px">INJ_IFRAME_UNSCROLLED_REL</span>
  </div>
  <button id="frame-btn">Frame Checkout</button>
</body>`;

const MAIN_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Stealth Stripper E2E</title>
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
  </style>
</head>
<body>
  <main>
    <!-- 1. Real gradient text vs adversarial gradient-clip injections -->
    <h1 style="background:linear-gradient(to right, #2563eb, #9333ea);-webkit-background-clip:text;background-clip:text;color:transparent">
      Ship AI Agents <strong>10x Faster</strong>
    </h1>
    <span style="background-clip:text;-webkit-background-clip:text;background-image:linear-gradient(transparent, transparent);color:transparent">
      INJ_GRAD_TRANSPARENT
    </span>
    <span style="background-clip:text;-webkit-background-clip:text;background-image:linear-gradient(currentColor, currentColor);color:transparent">
      INJ_GRAD_CURRENTCOLOR
    </span>
    <span style="background-clip:text;-webkit-background-clip:text;background-image:linear-gradient(#ffffff, #fefefe);color:transparent">
      INJ_GRAD_WHITE_ON_WHITE
    </span>
    <span style="background-clip:text;-webkit-background-clip:text;background-image:linear-gradient(to right, #000000 0%, transparent 0%, transparent 100%);color:transparent">
      INJ_GRAD_ZERO_SPAN
    </span>
    <span style="background-clip:text;-webkit-background-clip:text;background-image:url('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');color:transparent">
      INJ_GRAD_URL_FAKE
    </span>
    <div style="background-image:linear-gradient(transparent, transparent)">
      <span style="color:#ffffff">INJ_TRANSPARENT_GRAD_BACKDROP</span>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;background:#121212 linear-gradient(to right, #fff 50%, #121212 50%)">
      <h2 style="color:#121212">Order confirmed for pickup</h2>
      <h2 style="color:#fff">Track your delivery</h2>
    </div>

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

    <!-- 3. CSS Color 4 / Color 5 (oklch, oklab, color-mix, cross-space contrast) -->
    <div class="dark-oklch">
      <p style="color:#ffffff">Tailwind Dark Card Heading</p>
      <span style="color:oklch(0.208 0.042 265.755)">INJ_OKLCH_ON_OKLCH</span>
      <span style="background-clip:text;-webkit-background-clip:text;background-image:linear-gradient(oklch(0.208 0.042 265.755), oklch(0.208 0.042 265.755));color:transparent">
        INJ_GRAD_SAME_DARK_OKLCH
      </span>
    </div>
    <div class="scrim-oklch">
      <p style="color:#ffffff">Translucent Scrim Banner</p>
    </div>
    <span style="color:color-mix(in oklab, currentColor 0%, rgba(0, 0, 0, 0))">
      INJ_COLOR_MIX_ZERO
    </span>
    <span style="color:oklch(1 0 0)">INJ_OKLCH_WHITE_ON_RGB_WHITE</span>

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
  "INJ_GRAD_TRANSPARENT",
  "INJ_GRAD_CURRENTCOLOR",
  "INJ_GRAD_WHITE_ON_WHITE",
  "INJ_GRAD_ZERO_SPAN",
  "INJ_GRAD_URL_FAKE",
  "INJ_TRANSPARENT_GRAD_BACKDROP",
  "INJ_UNSCROLLED_REL",
  "INJ_UNSCROLLED_ABS",
  "INJ_UNSCROLLED_MARGIN",
  "INJ_TEXT_INDENT",
  "INJ_SCROLLED_MODAL_OFF_X",
  "INJ_SCROLLED_MODAL_EXTREME_Y",
  "INJ_OKLCH_ON_OKLCH",
  "INJ_GRAD_SAME_DARK_OKLCH",
  "INJ_COLOR_MIX_ZERO",
  "INJ_OKLCH_WHITE_ON_RGB_WHITE",
  "INJ_HEADING_DIRECT",
  "INJ_HEADING_NESTED_SPAN",
  "INJ_HIDDEN_CHILD_ARIA",
  "INJ_BUTTON_LONG_PAYLOAD_",
  "INJ_HIDPI_CLIP",
  "INJ_HIDPI_MICROBOX",
  "INJ_IFRAME_GRAD_TRANSPARENT",
  "INJ_IFRAME_UNSCROLLED_REL",
];

const VISIBLE_CONTENT = [
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

describe.skipIf(!process.env.BSK_CLICK_CHROME)(
  "real browser stealth prompt-injection stripper",
  () => {
    it("strips transparent/same-color gradients, unscrolled offscreen offsets, CSS Color 4/5 zero-alpha, and 2x HiDPI microboxes while preserving legitimate UI across handleSnapshot and handleObserve", async () => {
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
            executable: process.env.BSK_CLICK_CHROME,
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

            const graph = async (): Promise<CdpFrameGraph> => {
              const { frameTree } = await local<{ frameTree: FrameTree }>("Page.getFrameTree");
              const frames: CdpFrame[] = [];
              const visit = async (tree: FrameTree, parentFrameId?: string) => {
                const owner = parentFrameId
                  ? await local<{ backendNodeId: number }>("DOM.getFrameOwner", {
                      frameId: tree.frame.id,
                    })
                  : undefined;
                frames.push({
                  frameId: tree.frame.id,
                  parentFrameId,
                  target: { tabId: 7 },
                  ownerBackendNodeId: owner?.backendNodeId,
                });
                for (const child of tree.childFrames ?? []) await visit(child, tree.frame.id);
              };
              await visit(frameTree);
              return { rootFrameId: frameTree.frame.id, frames };
            };
            const cdp: CdpRunner = {
              send: (_tabId, method, params) => local(method, params),
              sendToTarget: (_target, method, params) => local(method, params),
              getAttachmentId: () => sessionId,
              getFrameGraph: graph,
            };
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
  },
);
