// @vitest-environment node
// Reuses the CI browser opt-in; every run owns its Chrome profile.
import { describe, expect, it } from "vitest";
import type { CdpFrame, CdpFrameGraph } from "@/browser-driver/frame-graph";
import { SessionManager } from "@/session-manager/manager";
import { handleClick } from "../interaction";
import { handleObserve } from "../observation";
import type { CdpRunner } from "../shared";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] };

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
    #backdrop { position:fixed; inset:0; z-index:9; background:#0008; }
    iframe { width:100%; height:120px; border:0; }
  </style><main>
    <button id="main">Main action</button>
    <canvas aria-label="Main canvas" width="40" height="30"></canvas>
    ${c.frame ? `<iframe srcdoc="<button id='child' onclick='parent.frameClicks++'>Frame action</button>"></iframe>` : ""}
  </main><button id="covered">Covered action</button>
  ${c.backdrop ? '<div id="backdrop"></div>' : ""}
  <${tag} id="panel" ${c.role ? `role="${c.role}"` : ""} ${c.modal && !c.native ? 'aria-modal="true"' : c.role ? 'aria-modal="false"' : ""}>
    <button id="inside">Panel action</button>
  </${tag}>`;
}

describe.skipIf(!process.env.BSK_CLICK_CHROME)("real browser observation layers", () => {
  it("retains usable page refs beside sidebars while preserving modal and backdrop behavior", async () => {
    const { withChrome } = await import(
      new URL(
        "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
        import.meta.url,
      ).href
    );
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
        await local("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 757,
          deviceScaleFactor: 1,
          mobile: false,
        });
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
              target: { tabId: 4 },
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
            ensureActiveTab: async () => 4,
          },
        });
        const ctx = await manager.start("layers");
        const tab = { id: 4, windowId: 100, active: true, url: "about:blank" } as chrome.tabs.Tab;
        const tabsApi = { get: async () => tab, query: async () => [tab] };
        for (const c of cases) {
          await evaluate(`document.open(); document.write(${JSON.stringify(fixture(c))}); document.close();
          window.mainClicks=[]; window.frameClicks=0;
          document.querySelector('#main').onclick=e=>mainClicks.push(e.isTrusted);
          document.querySelector('canvas').getContext('2d').fillRect(0,0,40,30);
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
          if (!c.transparent && !c.small && !blocked)
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
      },
    );
  }, 90_000);
});
