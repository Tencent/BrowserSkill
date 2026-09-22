// @vitest-environment node
// Opt in with BSK_BACKGROUND_CHROME after building the extension. Runs the real
// Agent handler, driver, page script, tiler and PNG exporter in an isolated
// extension; no daemon or user profile. The harness supplies only session setup.
// BSK_OVERLAY_SCROLLBAR=1 runs headed and requires visible native overlay pixels
// in the uncaptured page as a positive control (use macOS overlay scrollbars).
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fixture } from "@/long-screenshot/test-fixture";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

// Bundle current production modules, not a second implementation of capture.
const entry = `
import { ChromiumCdp } from '@/browser-driver/chromium-cdp';
import { SessionManager } from '@/session-manager/manager';
import { ScreenshotExports } from '@/long-screenshot/exports';
import { handleFullPageScreenshot } from '@/tools/screenshot-full-page';
globalThis.run = async (url, overlay) => {
  const cdp = new ChromiumCdp(chrome.debugger);
  const currentWindow = await chrome.windows.getCurrent();
  const [control] = await chrome.tabs.query({windowId:currentWindow.id,active:true});
  const manager = new SessionManager({agentWindow:{create:async()=>currentWindow.id,remove:async()=>{},ensureActiveTab:async()=>control.id}});
  const ctx = await manager.start('regression');
  const exports = new ScreenshotExports(id=>manager.has(id));
  const activated=[], focused=[], calls=[], trace=[];
  const message=chrome.tabs.sendMessage.bind(chrome.tabs);
  chrome.tabs.sendMessage=async(...args)=>{const reply=await message(...args);if(args[1].type==='bsk/long-screenshot-page')trace.push({command:args[1],reply});return reply;};
  const onActive=info=>activated.push(info.tabId), onFocus=id=>focused.push(id);
  chrome.tabs.onActivated.addListener(onActive);
  chrome.windows.onFocusChanged.addListener(onFocus);
  const send=cdp.send.bind(cdp);
  cdp.send=(id,method,params)=>{calls.push(method);return send(id,method,params)};
  const created=[];
  const evaluate=async(id,expression)=>(await cdp.send(id,'Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
  const state=id=>evaluate(id,"({y:scrollY,root:document.documentElement.getAttribute('style'),width:document.documentElement.clientWidth,height:document.documentElement.clientHeight,sticky:document.querySelector('#sticky').getAttribute('style'),fixed:document.querySelector('#fixed').getAttribute('style')})");
  try {
    const results=[];
    for (const variant of ['rows','other']) {
      const tab=await chrome.tabs.create({windowId:currentWindow.id,url:'about:blank',active:false});created.push(tab.id);
      ctx.agentCreatedTabs.add(tab.id);
      await cdp.acquireBackgroundExecution(ctx.sessionId,tab.id);
      await chrome.tabs.update(tab.id,{url:url+'/'+variant});
      for(let i=0;i<200;i++){
        if(await evaluate(tab.id,"document.readyState==='complete' && !!document.querySelector('#pattern')"))break;
        await new Promise(r=>setTimeout(r,50));
      }
      await evaluate(tab.id, "scrollTo({top:"+(variant==='rows'?333:900)+",behavior:'instant'})");
      const original=await state(tab.id);
      let overlayPixels=0;
      if(overlay && variant==='other') {
        const geometry=await evaluate(tab.id,'({width:innerWidth,height:innerHeight})');
        if(geometry.width!==original.width||geometry.height!==original.height)throw new Error('Overlay regression requires zero scrollbar gutter');
        const raw=await cdp.send(tab.id,'Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});
        const image=await createImageBitmap(await (await fetch('data:image/png;base64,'+raw.data)).blob());
        const surface=new OffscreenCanvas(image.width,image.height),ctx=surface.getContext('2d');ctx.drawImage(image,0,0);image.close();
        const scale=surface.width/geometry.width;
        for(let y=50;y<geometry.height-100;y++) {
          const pixel=ctx.getImageData(surface.width-Math.ceil(3*scale),Math.floor(y*scale),1,1).data;
          if([20,190,60].some((v,i)=>Math.abs(pixel[i]-v)>3))overlayPixels++;
        }
        if(!overlayPixels)throw new Error('Overlay regression requires visible scrollbar pixels before capture');
      }
      const dpr=await evaluate(tab.id,'devicePixelRatio');
      const result=await handleFullPageScreenshot(manager,{session_id:ctx.sessionId,tab_id:tab.id},{cdp,tabsApi:chrome.tabs,exports});
      if(result.code)throw new Error(JSON.stringify({result,variant,trace,calls}));
      const parts=[];let offset=0;
      for(;;){const chunk=await exports.read({session_id:ctx.sessionId,capture_id:result.capture_id,offset});
        if(chunk.code)throw new Error(JSON.stringify(chunk));
        parts.push(Uint8Array.from(atob(chunk.data_base64),c=>c.charCodeAt(0)));offset=chunk.next_offset;if(chunk.eof)break;
      }
      const bitmap=await createImageBitmap(new Blob(parts,{type:'image/png'}));
      const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),x=canvas.getContext('2d');x.drawImage(bitmap,0,0);bitmap.close();
      const bad=[];
      // Sample each CSS row's center. Fractional-DPR antialiasing is checked with
      // a 3/255 color-conversion tolerance, as in the viewport regression.
      // Avoid wrap boundaries where fractional-DPR interpolation is intentional.
      for(let y=2;y<2600;y++){
        if(y%256<2||y%256>253)continue;
        const pixel=Array.from(x.getImageData(Math.floor(100*dpr),Math.floor((31+y+.5)*dpr),1,1).data);
        const expected=variant==='other'?[20,190,60]:[y%256,Math.floor(y/256),127];
        if(expected.some((v,i)=>Math.abs(pixel[i]-v)>3)&&bad.length<10)bad.push({y,pixel,expected});
      }
      const edgeBad=[];
      for(let y=50;y<2500;y++) {
        if(y%256<2||y%256>253)continue;
        const pixel=Array.from(x.getImageData(canvas.width-Math.ceil(3*dpr),Math.floor((31+y+.5)*dpr),1,1).data);
        const expected=variant==='other'?[20,190,60]:[y%256,Math.floor(y/256),127];
        if(expected.some((v,i)=>Math.abs(pixel[i]-v)>3)&&edgeBad.length<10)edgeBad.push({y,pixel,expected});
      }
      const footer=Array.from(x.getImageData(Math.floor(canvas.width-40*dpr),Math.floor(canvas.height-40*dpr),1,1).data);
      results.push({result,dpr,bad,edgeBad,overlayPixels,footer,original,restored:await state(tab.id),active:(await chrome.tabs.get(tab.id)).active});
      await exports.release({session_id:ctx.sessionId,capture_id:result.capture_id});
    }
    return {results,activated,focused,calls,control:control.id,selected:(await chrome.tabs.query({windowId:currentWindow.id,active:true}))[0].id};
  } finally {
    chrome.tabs.onActivated.removeListener(onActive);chrome.windows.onFocusChanged.removeListener(onFocus);
    await exports.dispose();await cdp.detachAll();cdp.dispose();
    for(const id of created)await chrome.tabs.remove(id);
  }
};`;

describe.skipIf(!process.env.BSK_BACKGROUND_CHROME)(
  "background full-page browser regression",
  () => {
    it.each([
      { scale: 1, zoom: 1 },
      { scale: 2, zoom: 1.25 },
    ])("stitches target pixels and restores the page at $scale/$zoom", async ({ scale, zoom }) => {
      const directory = await mkdtemp(path.join(tmpdir(), "bsk-full-page-extension-"));
      const server = createServer((req, res) => {
        res.setHeader("Content-Type", "text/html");
        const page = fixture();
        res.end(
          req.url === "/other" ? page.replace(/rgb\(\d+,\d+,127\)/g, "rgb(20,190,60)") : page,
        );
      });
      try {
        const require = createRequire(import.meta.url);
        const { build } = await import(
          require.resolve("vite", { paths: [require.resolve("vitest")] })
        );
        await writeFile(path.join(directory, "entry.js"), entry);
        await build({
          configFile: false,
          logLevel: "error",
          resolve: {
            alias: {
              "@": path.resolve("src"),
              "@browser-skill/i18n": path.resolve("../../packages/i18n/src/index.ts"),
            },
          },
          build: {
            outDir: directory,
            emptyOutDir: false,
            lib: {
              entry: path.join(directory, "entry.js"),
              formats: ["iife"],
              name: "Regression",
              fileName: () => "regression.js",
            },
          },
        });
        await cp(
          path.resolve("dist/chrome-mv3/content-scripts"),
          path.join(directory, "content-scripts"),
          { recursive: true },
        );
        await writeFile(
          path.join(directory, "manifest.json"),
          JSON.stringify({
            manifest_version: 3,
            background: { service_worker: "worker.js" },
            name: "Background full-page regression",
            version: "1.0",
            permissions: ["debugger", "tabs", "scripting", "webNavigation", "storage"],
            host_permissions: ["http://127.0.0.1/*"],
            content_scripts: [
              {
                matches: ["http://127.0.0.1/*"],
                js: ["content-scripts/long-screenshot-page.js"],
                run_at: "document_end",
              },
            ],
          }),
        );
        await writeFile(
          path.join(directory, "worker.js"),
          "chrome.runtime.onInstalled.addListener(() => {});",
        );
        await writeFile(
          path.join(directory, "regression.html"),
          '<!doctype html><script src="regression.js"></script>',
        );
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const { withChrome } = await import(
          new URL(
            "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
            import.meta.url,
          ).href
        );
        await withChrome(
          {
            executable: process.env.BSK_BACKGROUND_CHROME,
            deviceScale: scale,
            zoom,
            extensionPath: directory,
            softwareRendering: true,
            headless: !process.env.BSK_OVERLAY_SCROLLBAR,
          },
          async (send: Send) => {
            let origin = "";
            await expect
              .poll(
                async () => {
                  const { targetInfos } = await send<{
                    targetInfos: { type: string; url: string }[];
                  }>("Target.getTargets");
                  const worker = targetInfos.find(
                    (target) =>
                      target.type === "service_worker" && target.url.endsWith("/worker.js"),
                  );
                  origin = worker?.url.slice(0, -"/worker.js".length) ?? "";
                  return !!origin;
                },
                { timeout: 10_000 },
              )
              .toBe(true);
            const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
              url: `${origin}/regression.html`,
              background: true,
            });
            const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
              targetId,
              flatten: true,
            });
            const evaluate = async <T>(expression: string) => {
              const reply = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
                "Runtime.evaluate",
                { expression, returnByValue: true, awaitPromise: true },
                sessionId,
              );
              if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
              return reply.result.value;
            };
            await expect.poll(() => evaluate("typeof run==='function'")).toBe(true);
            await evaluate(
              `run(${JSON.stringify(url)},${!!process.env.BSK_OVERLAY_SCROLLBAR}).then(value=>globalThis.done={value},error=>globalThis.done={error:String(error)});true`,
            );
            await expect.poll(() => evaluate("!!globalThis.done"), { timeout: 100_000 }).toBe(true);
            const done = await evaluate<{
              error?: string;
              value: {
                results: {
                  result: { height: number };
                  dpr: number;
                  bad: unknown[];
                  edgeBad: unknown[];
                  overlayPixels: number;
                  footer: number[];
                  original: unknown;
                  restored: unknown;
                  active: boolean;
                }[];
                activated: number[];
                focused: number[];
                calls: string[];
                control: number;
                selected: number;
              };
            }>("globalThis.done");
            expect(done.error).toBeUndefined();
            for (const item of done.value.results) {
              expect(item.bad).toEqual([]);
              expect(item.edgeBad).toEqual([]);
              [255, 136, 0, 255].forEach((value, index) =>
                expect(
                  Math.abs(item.footer[index] - value),
                  JSON.stringify(item),
                ).toBeLessThanOrEqual(3),
              );
              expect(Math.abs(item.result.height - 2634 * item.dpr)).toBeLessThanOrEqual(1);
              expect(item.restored).toEqual(item.original);
              expect(item.active).toBe(false);
            }
            if (process.env.BSK_OVERLAY_SCROLLBAR)
              expect(done.value.results[1].overlayPixels).toBeGreaterThan(0);
            expect(done.value.selected).toBe(done.value.control);
            expect(done.value.activated).toEqual([]);
            expect(done.value.focused).toEqual([]);
            expect(done.value.calls).not.toContain("Page.bringToFront");
          },
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
