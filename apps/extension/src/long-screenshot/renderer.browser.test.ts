// @vitest-environment node
// Pixel oracle for the real DOM preparation + stitching engine. Opt in with a
// standalone headless renderer; no display server or user browser is required.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fixture } from "./test-fixture";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

describe.skipIf(!process.env.BSK_LONG_SCREENSHOT_RENDERER)(
  "long screenshot renderer pixels",
  () => {
    it.each([
      { scale: 1, height: 2603, lazy: false },
      { scale: 1.25, height: 2603, lazy: false },
      { scale: 2, height: 2603, lazy: false },
      { scale: 1, height: 2190, lazy: false },
      { scale: 1, height: 488, lazy: false },
      { scale: 1, height: 2603, lazy: true },
    ])("captures exact pixels and previews at scale $scale, height $height, lazy $lazy", async ({
      scale,
      height,
      lazy,
    }) => {
      const totalRows = height + (lazy ? 400 : 0);
      const require = createRequire(import.meta.resolve("wxt"));
      const { build } = require("esbuild");
      const bundle = await build({
        stdin: {
          contents: `import {capturePage} from './capture'; import {createPageCapture} from './page'; import {saveScreenshot} from './storage';
        const abort = new AbortController(); const page = createPageCapture(()=>abort.abort());
        globalThis.shotState = {phase:'running'};
        globalThis.nextShot = null;
        globalThis.runCapture = () => {
          capturePage({signal:abort.signal,label:'Capturing',cancelLabel:'Cancel',progress:()=>{},
            page:command=>page.handle({type:'bsk/long-screenshot-page',id:'pixel-test',...command}),
            screenshot:()=>new Promise(resolve=>{globalThis.nextShot=async data=>{
              globalThis.nextShot=null; resolve(await createImageBitmap(await (await fetch(data)).blob()));
            };})
          }).then(async result=>{
            await saveScreenshot({id:'pixel-test',title:'Long screenshot test',createdAt:Date.now(),...result});
            const reader=new FileReader(); reader.onload=()=>{globalThis.shotState={phase:'complete',width:result.width,height:result.height,data:reader.result};};reader.readAsDataURL(result.blob);
          },error=>{globalThis.shotState={phase:'error',error:String(error)};});
        };`,
          resolveDir: path.resolve("src/long-screenshot"),
          loader: "ts",
        },
        bundle: true,
        format: "iife",
        write: false,
      });
      const server = createServer((req, res) => {
        const url = new URL(req.url || "/", "http://localhost");
        if (url.pathname === "/") {
          res.setHeader("Content-Type", "text/html");
          res.end(fixture(height, lazy));
          return;
        }
        const root = path.resolve("dist/chrome-mv3");
        const file = path.resolve(root, "." + url.pathname);
        if (!file.startsWith(root + path.sep)) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.setHeader(
          "Content-Type",
          file.endsWith(".js")
            ? "text/javascript"
            : file.endsWith(".css")
              ? "text/css"
              : file.endsWith(".png")
                ? "image/png"
                : "text/html",
        );
        void readFile(file).then(
          (data) => res.end(data),
          () => {
            res.writeHead(404);
            res.end();
          },
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const { withChrome } = await import(
          new URL(
            "../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
            import.meta.url,
          ).href
        );
        await withChrome(
          { executable: process.env.BSK_LONG_SCREENSHOT_RENDERER, deviceScale: scale, zoom: 1 },
          async (send: Send) => {
            const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
              url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
            });
            const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
              targetId,
              flatten: true,
            });
            await send("Page.enable", {}, sessionId);
            const evaluate = async <T>(expression: string): Promise<T> => {
              const reply = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
                "Runtime.evaluate",
                { expression, returnByValue: true, awaitPromise: true },
                sessionId,
              );
              if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
              return reply.result.value;
            };
            await send("Page.bringToFront", {}, sessionId);
            for (let i = 0; i < 100; i++) {
              if (
                await evaluate(
                  "document.readyState === 'complete' && !!document.querySelector('#pattern')",
                )
              )
                break;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            const viewportHeight = await evaluate<number>("document.documentElement.clientHeight");
            const original = await evaluate(
              "({x:scrollX,y:scrollY,sticky:document.querySelector('#sticky').getAttribute('style'),fixed:document.querySelector('#fixed').getAttribute('style')})",
            );
            await evaluate(bundle.outputFiles[0].text);
            await evaluate("runCapture()");
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline) {
              const status = await evaluate<{ phase: string; error?: string; needsShot: boolean }>(
                "({...shotState,data:undefined,needsShot:!!nextShot})",
              );
              if (status.phase === "error") throw new Error(status.error);
              if (status.phase === "complete") break;
              if (status.needsShot) {
                const shot = await send<{ data: string }>(
                  "Page.captureScreenshot",
                  { format: "png", fromSurface: true, captureBeyondViewport: false },
                  sessionId,
                );
                await evaluate(`nextShot(${JSON.stringify(`data:image/png;base64,${shot.data}`)})`);
              } else await new Promise((resolve) => setTimeout(resolve, 50));
            }
            const result = await evaluate<{
              phase: string;
              width: number;
              height: number;
              data: string;
            }>("shotState");
            expect(result.phase).toBe("complete");
            expect(result.height).toBe(
              Math.round(Math.max(totalRows + 31, viewportHeight) * scale),
            );
            expect(
              await evaluate(
                "({x:scrollX,y:scrollY,sticky:document.querySelector('#sticky').getAttribute('style'),fixed:document.querySelector('#fixed').getAttribute('style')})",
              ),
            ).toEqual(original);
            const badRows = await evaluate<number[]>(`(async()=>{
          const bitmap=await createImageBitmap(await (await fetch(shotState.data)).blob());
          const canvas=new OffscreenCanvas(bitmap.width,bitmap.height);const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);
          const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;const bad=[];
          for(let y=0;y<${totalRows};y++){
            const at=(Math.floor((y+31.5)*${scale})*canvas.width+Math.floor(100*${scale}))*4;
            if(data[at]!==y%256||data[at+1]!==Math.floor(y/256)||data[at+2]!==127){if(bad.length<16)bad.push(y);}
          }
          for(let y=canvas.height-Math.floor(80*${scale});y<canvas.height;y++){
            const at=(y*canvas.width+canvas.width-Math.floor(40*${scale}))*4;
            if(data[at]!==255||data[at+1]!==136||data[at+2]!==0){if(bad.length<16)bad.push(y);}
          }
          bitmap.close();return bad;
        })()`);

            if (process.env.BSK_LONG_SCREENSHOT_OUTPUT) {
              await mkdir(process.env.BSK_LONG_SCREENSHOT_OUTPUT, { recursive: true });
              await writeFile(
                path.join(
                  process.env.BSK_LONG_SCREENSHOT_OUTPUT,
                  `stitched-${scale}-${height}-${lazy}.png`,
                ),
                Buffer.from(result.data.split(",")[1], "base64"),
              );
            }
            expect(badRows).toEqual([]);
            await send(
              "Page.addScriptToEvaluateOnNewDocument",
              {
                source: `globalThis.previewErrors=[];addEventListener("error",e=>previewErrors.push(e.message));addEventListener("unhandledrejection",e=>previewErrors.push(String(e.reason)));globalThis.chrome={
          runtime:{id:'preview-test',getURL:p=>new URL(p,location.origin).href},
          i18n:{getUILanguage:()=> 'zh-CN'},
          storage:{local:{get:async()=>({}),set:async()=>{}},onChanged:{addListener(){},removeListener(){}}},
          downloads:{download:async args=>{globalThis.downloadArgs=args;return 1;}}
        };`,
              },
              sessionId,
            );
            await send(
              "Page.navigate",
              {
                url: `http://127.0.0.1:${(server.address() as { port: number }).port}/long-screenshot.html?id=pixel-test`,
              },
              sessionId,
            );
            let previewReady = false;
            for (let i = 0; i < 100; i++) {
              previewReady = await evaluate(
                "document.querySelector('.preview-image')?.complete && document.querySelector('.preview-image')?.naturalHeight > 0",
              );
              if (previewReady) break;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            expect(
              previewReady,
              await evaluate("document.body.innerText+JSON.stringify(previewErrors)"),
            ).toBe(true);
            expect(await evaluate("document.querySelector('.preview-image').naturalHeight")).toBe(
              result.height,
            );
            await evaluate("document.querySelector('button').click()");
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(await evaluate("globalThis.downloadArgs")).toMatchObject({
              saveAs: true,
              filename: expect.stringMatching(/Long screenshot test.*\.png$/),
            });
            if (process.env.BSK_LONG_SCREENSHOT_OUTPUT) {
              const shot = await send<{ data: string }>("Page.captureScreenshot", {}, sessionId);
              await writeFile(
                path.join(
                  process.env.BSK_LONG_SCREENSHOT_OUTPUT,
                  `preview-${scale}-${height}-${lazy}.png`,
                ),
                Buffer.from(shot.data, "base64"),
              );
            }
          },
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 60_000);
  },
);
