// @vitest-environment node
// Opt in: BSK_BACKGROUND_CHROME=/path/to/chrome. Owns an isolated headed profile.
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { SessionManager } from "@/session-manager/manager";
import { handleClick } from "../interaction";
import { handleObserve, handleScreenshot, handleSnapshot } from "../observation";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
const html = `<!doctype html><style>body{margin:0;height:4000px;background:rgb(0,170,40)}button{display:block;width:200px;height:50px}canvas{display:block}</style>
<button id="paint">Paint blue</button><canvas id="canvas" width="200" height="100"></canvas>
<script>
const canvas=document.querySelector('canvas'), ctx=canvas.getContext('2d');
ctx.fillStyle='rgb(230,180,10)';ctx.fillRect(0,0,200,100);
document.querySelector('button').onclick=()=>requestAnimationFrame(()=>{document.body.style.background='rgb(20,40,210)'});
canvas.onclick=()=>requestAnimationFrame(()=>{ctx.fillStyle='rgb(180,30,90)';ctx.fillRect(0,0,200,100)});
</script>`;

function closeColor(actual: number[], expected: number[]) {
  expected.forEach((value, index) =>
    expect(Math.abs(actual[index] - value)).toBeLessThanOrEqual(3),
  );
}

describe.skipIf(!process.env.BSK_BACKGROUND_CHROME)(
  "background screenshot browser regression",
  () => {
    it.each([
      { deviceScale: 1, zoom: 1 },
      { deviceScale: 2, zoom: 1.25 },
    ])("captures current target pixels and preserves ref interactions at $deviceScale/$zoom", async ({
      deviceScale,
      zoom,
    }) => {
      const server = createServer((_req, res) => {
        res.setHeader("content-type", "text/html");
        res.end(html);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture address");
      const url = `http://127.0.0.1:${address.port}`;
      try {
        const { withChrome } = await import(
          new URL(
            "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
            import.meta.url,
          ).href
        );
        await withChrome(
          { executable: process.env.BSK_BACKGROUND_CHROME, deviceScale, zoom, headless: false },
          async (send: Send) => {
            const { targetInfos } = await send<{
              targetInfos: { targetId: string; type: string }[];
            }>("Target.getTargets");
            const control = targetInfos.find((target) => target.type === "page")!;
            const controlSession = (
              await send<{ sessionId: string }>("Target.attachToTarget", {
                targetId: control.targetId,
                flatten: true,
              })
            ).sessionId;
            const targets = new Map<number, string>();
            const sessions = new Map<number, string>();
            const calls: string[] = [];
            for (const id of [7, 8])
              targets.set(
                id,
                (
                  await send<{ targetId: string }>("Target.createTarget", {
                    url: "about:blank",
                    background: true,
                  })
                ).targetId,
              );
            const api: CdpDebuggerApi = {
              attach: async ({ tabId }) => {
                sessions.set(
                  tabId!,
                  (
                    await send<{ sessionId: string }>("Target.attachToTarget", {
                      targetId: targets.get(tabId!),
                      flatten: true,
                    })
                  ).sessionId,
                );
              },
              detach: async ({ tabId }) => {
                await send("Target.detachFromTarget", { sessionId: sessions.get(tabId!) });
                sessions.delete(tabId!);
              },
              sendCommand: async (target, method, params) => {
                calls.push(method);
                return send(method, params, target.sessionId ?? sessions.get(target.tabId!));
              },
              onEvent: {
                addListener: () => {},
                removeListener: () => {},
              } as unknown as CdpDebuggerApi["onEvent"],
              onDetach: {
                addListener: () => {},
                removeListener: () => {},
              } as unknown as CdpDebuggerApi["onDetach"],
            };
            const cdp = new ChromiumCdp(api);
            const evaluate = async <T>(expression: string, session = sessions.get(7)) => {
              const result = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
                "Runtime.evaluate",
                { expression, awaitPromise: true, returnByValue: true },
                session,
              );
              expect(result.exceptionDetails).toBeUndefined();
              return result.result.value;
            };
            const paint = () =>
              evaluate(
                "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))",
              );
            const pixels = (png: string) =>
              evaluate<{ width: number; height: number; corner: number[]; center: number[] }>(
                `(async()=>{const image=await createImageBitmap(await (await fetch('data:image/png;base64,${png}')).blob());const c=new OffscreenCanvas(image.width,image.height),x=c.getContext('2d');x.drawImage(image,0,0);return {width:image.width,height:image.height,corner:Array.from(x.getImageData(image.width-20,image.height-20,1,1).data),center:Array.from(x.getImageData(Math.floor(image.width/2),Math.floor(image.height/2),1,1).data)}})()`,
                controlSession,
              );
            const manager = new SessionManager({
              agentWindow: {
                create: async () => ({ windowId: 100, initialTabIds: [] }),
                remove: async () => {},
                ensureActiveTab: async () => 1,
              },
            });
            const ctx = await manager.start("agent");
            const tabsApi = {
              get: async (id: number) =>
                ({ id, windowId: 100, active: false, url }) as chrome.tabs.Tab,
              query: async () => [] as chrome.tabs.Tab[],
            };
            let windowCaptures = 0;
            const deps = {
              cdp,
              tabsApi,
              captureApi: {
                ...tabsApi,
                captureVisibleTab: async () => {
                  windowCaptures++;
                  throw new Error("Wrong backend");
                },
              },
              sendToTab: async () => {},
            };
            const params = { session_id: "agent", tab_id: 7 };
            try {
              await evaluate("document.body.style.background='rgb(200,0,0)'", controlSession);
              const controlBefore = await evaluate(
                "({hidden:document.hidden,focus:document.hasFocus()})",
                controlSession,
              );
              for (const id of [7, 8]) {
                ctx.agentCreatedTabs.add(id);
                await cdp.acquireBackgroundExecution("agent", id);
                await cdp.send(id, "Page.navigate", { url });
                await expect
                  .poll(() =>
                    evaluate(
                      "document.readyState === 'complete' && !!document.querySelector('canvas')",
                      sessions.get(id),
                    ),
                  )
                  .toBe(true);
              }
              await paint();
              const shot = await handleScreenshot(manager, params, deps);
              if ("code" in shot) throw new Error(JSON.stringify(shot));
              const first = await pixels(shot.image_base64);
              closeColor(first.corner, [0, 170, 40, 255]);
              const viewport = await evaluate<{ width: number; height: number; dpr: number }>(
                "({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})",
              );
              expect(Math.abs(shot.width - viewport.width * viewport.dpr)).toBeLessThanOrEqual(2);
              expect(Math.abs(shot.height - viewport.height * viewport.dpr)).toBeLessThanOrEqual(2);
              expect(shot).not.toHaveProperty("capture_id");
              const snapshot = await handleSnapshot(manager, params, deps);
              expect(snapshot).not.toHaveProperty("code");
              const button = [...ctx.refStore.entries()].find(
                ([, entry]) => entry.kind === "dom" && entry.name === "Paint blue",
              );
              expect(button).toBeDefined();
              const element = await handleScreenshot(manager, { ...params, ref: button![0] }, deps);
              if ("code" in element) throw new Error(JSON.stringify(element));
              expect(element.width).toBeLessThan(shot.width);
              expect(
                await handleClick(manager, { ...params, ref: button![0] }, deps),
              ).not.toHaveProperty("code");
              await paint();
              const blue = await handleScreenshot(manager, params, deps);
              if ("code" in blue) throw new Error(JSON.stringify(blue));
              closeColor((await pixels(blue.image_base64)).corner, [20, 40, 210, 255]);
              const other = await handleScreenshot(manager, { ...params, tab_id: 8 }, deps);
              if ("code" in other) throw new Error(JSON.stringify(other));
              closeColor((await pixels(other.image_base64)).corner, [0, 170, 40, 255]);
              expect(other.tab_id).toBe(8);
              await handleObserve(manager, params, deps);
              const canvas = [...ctx.refStore.entries()].find(
                ([, entry]) => entry.kind === "visual-region",
              );
              expect(canvas).toBeDefined();
              const canvasShot = await handleScreenshot(
                manager,
                { ...params, ref: canvas![0] },
                deps,
              );
              if ("code" in canvasShot) throw new Error(JSON.stringify(canvasShot));
              closeColor((await pixels(canvasShot.image_base64)).center, [230, 180, 10, 255]);
              expect(canvasShot.capture_id).toBeTruthy();
              expect(
                await handleClick(
                  manager,
                  {
                    ...params,
                    ref: canvas![0],
                    capture_id: canvasShot.capture_id,
                    image_x: Math.floor(canvasShot.width / 2),
                    image_y: Math.floor(canvasShot.height / 2),
                  },
                  deps,
                ),
              ).not.toHaveProperty("code");
              await paint();
              const paintedCanvas = await handleScreenshot(
                manager,
                { ...params, ref: canvas![0] },
                deps,
              );
              if ("code" in paintedCanvas) throw new Error(JSON.stringify(paintedCanvas));
              closeColor((await pixels(paintedCanvas.image_base64)).center, [180, 30, 90, 255]);
              await evaluate("window.scrollTo(0,1000)");
              await paint();
              const scrolled = await handleScreenshot(manager, params, deps);
              if ("code" in scrolled) throw new Error(JSON.stringify(scrolled));
              expect(scrolled.height).toBe(shot.height);
              expect(await evaluate("scrollY")).toBe(1000);
              expect(
                await evaluate(
                  "({hidden:document.hidden,focus:document.hasFocus()})",
                  controlSession,
                ),
              ).toEqual(controlBefore);
              expect(windowCaptures).toBe(0);
              expect(calls).not.toContain("Page.bringToFront");
            } finally {
              await cdp.detachAll();
              cdp.dispose();
            }
          },
        );
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }, 60_000);
  },
);
