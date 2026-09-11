// @vitest-environment node
// Build the extension first, then opt in with BSK_LONG_SCREENSHOT_CHROME.
// Runs the shipped popup, content script, worker, PNG storage and preview in an
// isolated browser. No daemon, CLI or user profile is involved; only the
// restricted-page check visits the Chrome Web Store.

import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

import { fixture } from "./test-fixture";

const extensionPath = process.env.BSK_LONG_SCREENSHOT_EXTENSION ?? path.resolve("dist/chrome-mv3");

async function withHarness(
  run: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>,
  scale = 1,
) {
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(fixture(req.url?.includes("large") ? 50_000 : 2603));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const { withChrome } = await import(
      new URL(
        "../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
        import.meta.url,
      ).href
    );
    await withChrome(
      {
        executable: process.env.BSK_LONG_SCREENSHOT_CHROME,
        deviceScale: scale,
        zoom: 1,
        extensionPath,
        headless: true,
      },
      (send: Send) => runHarness(send),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  async function runHarness(send: Send) {
    await run(await harness(send, `http://127.0.0.1:${port}`));
  }
}

async function harness(
  send: Send,
  baseUrl: string,
  existingPage?: { targetId: string; sessionId: string },
  knownOrigin?: string,
) {
  const targets = () =>
    send<{ targetInfos: { type: string; url: string; targetId: string }[] }>("Target.getTargets");
  const poll = async <T>(
    read: () => Promise<T | undefined | false>,
    timeout = 20_000,
  ): Promise<T> => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      let result: T | undefined | false;
      try {
        result = await read();
      } catch (error) {
        if (!String(error).includes("Cannot find default execution context")) throw error;
      }
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Browser condition timed out");
  };
  const origin =
    knownOrigin ??
    (
      await poll(async () =>
        (
          await targets()
        ).targetInfos.find(
          (target) =>
            target.type === "service_worker" &&
            target.url.startsWith("chrome-extension://") &&
            target.url.endsWith("/background.js"),
        ),
      )
    ).url
      .split("/")
      .slice(0, 3)
      .join("/");
  const create = async (url: string, background = false) => {
    const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
      url,
      background,
    });
    const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    return { targetId, sessionId };
  };
  const evaluate = async <T>(sessionId: string, expression: string): Promise<T> => {
    const result = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const popup = await create(`${origin}/popup.html`, true);
  await poll(() =>
    evaluate(popup.sessionId, "document.querySelector('[data-slot=popup-launcher]') !== null"),
  ).catch(async (error) => {
    throw new Error(
      `${error}: ${JSON.stringify(await evaluate(popup.sessionId, "({url:location.href,body:document.body?.innerText.slice(0,200)})"))}`,
    );
  });
  await evaluate(
    popup.sessionId,
    "document.querySelector('[data-slot=popup-connection-toggle][aria-checked=true]')?.click()",
  );
  await poll(() =>
    evaluate(
      popup.sessionId,
      "document.querySelector('[data-slot=popup-connection-toggle]')?.getAttribute('aria-checked') === 'false'",
    ),
  );
  const page = existingPage ?? (await create(baseUrl));
  await send("Page.bringToFront", {}, page.sessionId);
  await poll(() =>
    evaluate(
      page.sessionId,
      "document.querySelector('#pattern') !== null && document.readyState === 'complete'",
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  await send("Page.enable", {}, page.sessionId);
  await send("Page.captureScreenshot", { format: "png", fromSurface: true }, page.sessionId);
  const request = <T>(action: string, extra: object = {}) =>
    evaluate<T>(
      popup.sessionId,
      `chrome.runtime.sendMessage(${JSON.stringify({ type: "bsk/long-screenshot", action, ...extra })})`,
    );
  const status = async () => {
    const reply = await request<{
      state: {
        id: string;
        phase: string;
        mode?: string;
        error?: string;
        width?: number;
        height?: number;
      };
    }>("status");
    if (!reply)
      throw new Error(
        `Missing status: ${JSON.stringify(await evaluate(popup.sessionId, "chrome.storage.session.get('longScreenshotState')"))}`,
      );
    return reply.state;
  };
  const startFromPopup = async () => {
    await evaluate(popup.sessionId, `document.querySelector('[data-slot=popup-launcher]').click()`);
    await poll(() =>
      evaluate(
        popup.sessionId,
        `!!document.querySelector('[data-slot=popup-feature-long-screenshot]')`,
      ),
    );
    await evaluate(
      popup.sessionId,
      `document.querySelector('[data-slot=popup-feature-long-screenshot]').click()`,
    );
    await poll(() =>
      evaluate(
        popup.sessionId,
        `!!document.querySelector('[data-slot=popup-long-screenshot] button:not(:disabled)')`,
      ),
    );
    await evaluate(
      popup.sessionId,
      `document.querySelector('[data-slot=popup-long-screenshot] button').click()`,
    );
    return poll(status);
  };
  const finished = () =>
    poll(async () => {
      const state = await status();
      return state && ["complete", "cancelled", "error"].includes(state.phase) ? state : false;
    }, 120_000).catch(async (error) => {
      throw new Error(`${error}: ${JSON.stringify(await status())}`);
    });
  return {
    send,
    create,
    evaluate,
    page,
    popup,
    request,
    status,
    startFromPopup,
    finished,
    poll,
    targets,
    baseUrl,
    origin,
  };
}

describe.skipIf(!process.env.BSK_LONG_SCREENSHOT_CHROME)(
  "full-page screenshot in a real extension",
  () => {
    it.skipIf(!process.env.BSK_LONG_SCREENSHOT_URL)(
      "captures a reported website automatically",
      async () => {
        await withHarness(async (h) => {
          await h.send(
            "Page.navigate",
            { url: process.env.BSK_LONG_SCREENSHOT_URL },
            h.page.sessionId,
          );
          await h.poll(
            () => h.evaluate(h.page.sessionId, "document.readyState === 'complete'"),
            60_000,
          );
          const original = await h.evaluate(h.page.sessionId, "scrollY");
          await h.startFromPopup();
          const state = await h.finished();
          expect(state).toMatchObject({ phase: "complete", mode: "auto" });
          expect(state, JSON.stringify(state)).not.toHaveProperty("partial", true);
          expect(await h.evaluate(h.page.sessionId, "scrollY")).toBe(original);
          const height = await h.evaluate<number>(
            h.page.sessionId,
            "Math.round(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) * devicePixelRatio)",
          );
          expect(state.height).toBe(height);
          if (process.env.BSK_LONG_SCREENSHOT_OUTPUT) {
            const output = process.env.BSK_LONG_SCREENSHOT_OUTPUT;
            await mkdir(output, { recursive: true });
            await writeFile(
              path.join(output, "reported-site.json"),
              JSON.stringify({ url: process.env.BSK_LONG_SCREENSHOT_URL, state, height }, null, 2),
            );
            const target = await h.poll(async () =>
              (await h.targets()).targetInfos.find((t) =>
                t.url.includes(`/long-screenshot.html?id=${state.id}`),
              ),
            );
            const { sessionId } = await h.send<{ sessionId: string }>("Target.attachToTarget", {
              targetId: target.targetId,
              flatten: true,
            });
            await h.poll(() =>
              h.evaluate(sessionId, "document.querySelector('.preview-image')?.complete"),
            );
            const png = await h.send<{ data: string }>("Page.captureScreenshot", {}, sessionId);
            await writeFile(
              path.join(output, "reported-site-preview.png"),
              Buffer.from(png.data, "base64"),
            );
          }
        });
      },
      180_000,
    );

    it("recovers automatic capture after an extension reload without refreshing the page", async () => {
      await withHarness(async (h) => {
        const document = await h.evaluate(h.page.sessionId, "performance.timeOrigin");
        const oldWorker = (await h.targets()).targetInfos.find(
          (t) => t.type === "service_worker" && t.url.startsWith(h.origin),
        );
        // Reload the unpacked extension while the original webpage stays open.
        expect(await h.send("Extensions.loadUnpacked", { path: extensionPath })).toMatchObject({
          id: h.origin.split("://")[1],
        });
        await h.poll(
          async () =>
            !(await h.targets()).targetInfos.some((t) => t.targetId === oldWorker?.targetId),
        );
        const installed = await h.send<{ extensions: { id: string; enabled: boolean }[] }>(
          "Extensions.getExtensions",
        );
        expect(installed.extensions.find((e) => e.id === h.origin.split("://")[1])).toMatchObject({
          enabled: true,
        });
        const reloaded = await harness(h.send, h.baseUrl, h.page, h.origin);
        // Confirm this is a real missing receiver, not a page reloaded by the test.
        expect(await h.evaluate(h.page.sessionId, "performance.timeOrigin")).toBe(document);
        expect(
          await reloaded.evaluate(
            reloaded.popup.sessionId,
            `(async()=>{
          const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
          try { const reply=await chrome.tabs.sendMessage(tab.id,{type:'bsk/long-screenshot-page',id:'probe',action:'probe'}); return !!reply?.ok; }
          catch { return false; }
        })()`,
          ),
        ).toBe(false);
        await reloaded.startFromPopup();
        expect(
          await reloaded.poll(async () => {
            const state = await reloaded.status();
            return state.phase !== "preparing" ? state : false;
          }),
        ).toMatchObject({ mode: "auto" });
        expect(await reloaded.finished()).toMatchObject({
          phase: "complete",
          mode: "auto",
          height: 2634,
        });
        expect(await h.evaluate(h.page.sessionId, "performance.timeOrigin")).toBe(document);
        expect(
          await h.evaluate(h.page.sessionId, "document.querySelector('#sticky').style.position"),
        ).toBe("");
      });
    }, 60_000);

    it.each([
      1, 2,
    ])("captures exact rows at device scale %s and restores styles and scroll", async (scale) => {
      await withHarness(async (h) => {
        const original = await h.evaluate(
          h.page.sessionId,
          "({y:scrollY, sticky:document.querySelector('#sticky').getAttribute('style'), fixed:document.querySelector('#fixed').getAttribute('style')})",
        );
        await h.startFromPopup();
        const state = await h.finished();
        expect(state.phase, JSON.stringify(state)).toBe("complete");
        expect(state.height).toBe(2634 * scale);
        expect(
          await h.evaluate(
            h.page.sessionId,
            "({y:scrollY, sticky:document.querySelector('#sticky').getAttribute('style'), fixed:document.querySelector('#fixed').getAttribute('style')})",
          ),
        ).toEqual(original);
        const target = await h.poll(async () =>
          (await h.targets()).targetInfos.find((target) =>
            target.url.includes(`/long-screenshot.html?id=${state.id}`),
          ),
        );
        const { sessionId } = await h.send<{ sessionId: string }>("Target.attachToTarget", {
          targetId: target.targetId,
          flatten: true,
        });
        await h.poll(() =>
          h.evaluate(sessionId, "document.querySelector('.preview-image')?.complete"),
        );
        const pixels = await h.evaluate<{ badRows: number[]; width: number; height: number }>(
          sessionId,
          `(async()=>{
            const root=await (await navigator.storage.getDirectory()).getDirectoryHandle('long-screenshots');
            const directory=await root.getDirectoryHandle('${state.id}');
            const shot=JSON.parse(await (await (await directory.getFileHandle('index.json')).getFile()).text());
            const badRows=[];const canvas=new OffscreenCanvas(shot.width,512);const ctx=canvas.getContext('2d');
            for(let tile=0;tile<Math.ceil(shot.height/512);tile++){
              const bitmap=await createImageBitmap(await (await directory.getFileHandle(tile+'.png')).getFile());
              ctx.clearRect(0,0,shot.width,512);ctx.drawImage(bitmap,0,0);bitmap.close();
              const data=ctx.getImageData(0,0,shot.width,512).data;
              for(let row=0;row<512;row++){
                const y=Math.floor((tile*512+row)/${scale})-31;
                if(y<0||y>=2603)continue;
                const at=(row*shot.width+100*${scale})*4;
                if(data[at]!==y%256||data[at+1]!==Math.floor(y/256)||data[at+2]!==127){if(badRows.length<12)badRows.push(y);}
              }
            }return {badRows,width:shot.width,height:shot.height};})()`,
        );
        expect(pixels.badRows).toEqual([]);
        expect(pixels.height).toBe(2634 * scale);
        // Exercise the actual download button, replacing only the native Save As
        // dialog with a deterministic download into this isolated profile.
        await h.send("Browser.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: `/tmp/bsk-long-screenshot-download-${scale}`,
        });
        await h.evaluate(
          sessionId,
          `globalThis.downloadArgs=null; const download=chrome.downloads.download.bind(chrome.downloads); chrome.downloads.download=(args)=>{globalThis.downloadArgs=args;return download({...args,saveAs:false});}; document.querySelector('button').click()`,
        );
        await h.poll(() =>
          h.evaluate(sessionId, "globalThis.downloadArgs?.filename?.endsWith('.png')"),
        );
        const download = await h.poll(() =>
          h.evaluate<{ state: string; fileSize: number } | undefined>(
            sessionId,
            "chrome.downloads.search({}).then(items=>items.find(item=>item.state==='complete'))",
          ),
        );
        expect(download.fileSize).toBeGreaterThan(0);
        if (process.env.BSK_LONG_SCREENSHOT_OUTPUT) {
          await mkdir(process.env.BSK_LONG_SCREENSHOT_OUTPUT, { recursive: true });
          const png = await h.send<{ data: string }>("Page.captureScreenshot", {}, sessionId);
          await writeFile(
            path.join(process.env.BSK_LONG_SCREENSHOT_OUTPUT, `preview-${scale}.png`),
            Buffer.from(png.data, "base64"),
          );
        }
      }, scale);
    }, 120_000);

    it.each([
      "chrome://version/",
      "https://chromewebstore.google.com/",
    ])("captures restricted page %s after an explicit extension action", async (url) => {
      await withHarness(async (h) => {
        await h.send("Page.navigate", { url }, h.page.sessionId);
        await h.poll(() => h.evaluate(h.page.sessionId, "document.readyState==='complete'"));
        const tabs = await h.send<{
          targetInfos: { type: string; url: string; targetId: string }[];
        }>("Target.getTargets", { filter: [{ type: "tab" }, { exclude: true }] });
        const target = tabs.targetInfos.find((tab) => tab.url === url);
        expect(target).toBeDefined();
        await h.send("Extensions.triggerAction", {
          id: h.origin.split("://")[1],
          targetId: target!.targetId,
        });
        const mode = url.startsWith("chrome:") ? "visible" : "auto";
        expect(await h.request("start", { mode })).toMatchObject({ ok: true });
        if (mode === "auto") {
          expect(await h.finished()).toMatchObject({
            phase: "error",
            mode: "auto",
            error: "autoUnavailable",
          });
          expect(await h.request("start", { mode: "manual" })).toMatchObject({ ok: true });
          const first = await h.poll(async () => {
            const value = await h.status();
            return value.height ? value : false;
          });
          expect(first).toMatchObject({ mode: "manual" });
          await h.request("finish", { id: first.id });
        }
        const result = await h.finished();
        expect(result.phase, JSON.stringify(result)).toBe("complete");
        expect(result.height).toBeGreaterThan(0);
      });
    }, 60000);

    it("captures manual scrolling with a partial-width fixed footer and keeps the exact pixels", async () => {
      await withHarness(async (h) => {
        await h.evaluate(h.page.sessionId, "scrollTo(0,0)");
        await h.request("start", { mode: "manual" });
        const first = await h.poll(async () => {
          const value = await h.status();
          return value.height ? value : false;
        });
        const viewport = await h.evaluate<number>(h.page.sessionId, "innerHeight");
        for (const y of [180, 360, 540]) {
          await h.evaluate(h.page.sessionId, `scrollTo(0,${y})`);
          await h.poll(async () => {
            const value = await h.status();
            return (value.height ?? 0) >= viewport + y ? value : false;
          });
        }
        await h.request("finish", { id: first.id });
        const state = await h.finished();
        expect(state.height).toBe(viewport + 540);
        expect(state.phase).toBe("complete");
        const bad = await h.evaluate<number[]>(
          h.popup.sessionId,
          `(async()=>{
          const d=await (await (await navigator.storage.getDirectory()).getDirectoryHandle('long-screenshots')).getDirectoryHandle('${first.id}');
          const shot=JSON.parse(await (await (await d.getFileHandle('index.json')).getFile()).text());
          const c=new OffscreenCanvas(shot.width,512),ctx=c.getContext('2d'),bad=[];
          for(let index=0;index<Math.ceil(shot.height/512);index++){
            const b=await createImageBitmap(await (await d.getFileHandle(index+'.png')).getFile());ctx.clearRect(0,0,shot.width,512);ctx.drawImage(b,0,0);b.close();
            const pixels=ctx.getImageData(0,0,shot.width,512).data;
            for(let r=0;r<512 && index*512+r<shot.height;r++){
              const y=index*512+r-31;if(y<0)continue;const at=(r*shot.width+100)*4;
              if(pixels[at]!==y%256||pixels[at+1]!==Math.floor(y/256)||pixels[at+2]!==127){if(bad.length<12)bad.push(y);}
              const right=(r*shot.width+shot.width-40)*4,globalY=index*512+r;
              if(globalY>=40 && globalY<shot.height-80 && (pixels[right]!==y%256||pixels[right+1]!==Math.floor(y/256)||pixels[right+2]!==127)){if(bad.length<12)bad.push(globalY);}
              if(globalY>=shot.height-80 && (pixels[right]!==255||pixels[right+1]!==136||pixels[right+2]!==0)){if(bad.length<12)bad.push(globalY);}
            }
          }return bad;})()`,
        );
        expect(bad).toEqual([]);
      });
    }, 60000);

    it("cancels independently of popup lifetime and restores the page", async () => {
      await withHarness(async (h) => {
        const original = await h.evaluate<number>(h.page.sessionId, "scrollY");
        await h.startFromPopup();
        await h.send("Target.closeTarget", { targetId: h.popup.targetId });
        await h.send(
          "Input.dispatchKeyEvent",
          { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
          h.page.sessionId,
        );
        await h.poll(
          async () => (await h.evaluate<number>(h.page.sessionId, "scrollY")) === original,
        );
        expect(
          await h.evaluate(h.page.sessionId, "document.querySelector('#sticky').style.position"),
        ).toBe("");
      });
    }, 60_000);

    it("captures a 50,000-pixel page, pauses, resumes and permits an early finish", async () => {
      await withHarness(async (h) => {
        await h.send("Page.navigate", { url: `${h.baseUrl}/large` }, h.page.sessionId);
        await h.poll(() =>
          h.evaluate(
            h.page.sessionId,
            "document.querySelector('#pattern')?.dataset.height === '50000' && document.readyState === 'complete'",
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, 400));
        await h.startFromPopup();
        const active = await h.poll(async () => {
          const s = await h.status();
          return s.height && s.height > 1200 ? s : false;
        });
        await h.request("pause", { id: active.id });
        expect(await h.status()).toMatchObject({ phase: "paused" });
        await h.request("resume", { id: active.id });
        await h.poll(async () => {
          const s = await h.status();
          return (s.height ?? 0) > (active.height ?? 0) ? s : false;
        });
        await h.request("finish", { id: active.id });
        expect(await h.finished()).toMatchObject({ phase: "complete" });
        await h.send("Page.bringToFront", {}, h.page.sessionId);
        await h.send("Page.navigate", { url: h.baseUrl }, h.page.sessionId);
        await h.poll(() =>
          h.evaluate(
            h.page.sessionId,
            "document.querySelector('#pattern')?.dataset.height === '2603' && document.readyState === 'complete'",
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(await h.request("start")).toMatchObject({ ok: true });
        expect(await h.finished()).toMatchObject({ phase: "complete" });
      });
    }, 120_000);
  },
);
