// @vitest-environment node
// Build the extension first, then opt in with BSK_LONG_SCREENSHOT_CHROME.
// Runs the shipped popup, content script, worker, PNG storage and preview in an
// isolated browser. No daemon, CLI, user profile or external website is involved.

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
        extensionPath: path.resolve("dist/chrome-mv3"),
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

async function harness(send: Send, baseUrl: string) {
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
  const worker = await poll(async () =>
    (await targets()).targetInfos.find(
      (target) =>
        target.type === "service_worker" &&
        target.url.startsWith("chrome-extension://") &&
        target.url.endsWith("/background.js"),
    ),
  );
  const origin =
    new URL(worker.url).origin === "null"
      ? worker.url.split("/").slice(0, 3).join("/")
      : new URL(worker.url).origin;
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
  const page = await create(baseUrl);
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
      state: { id: string; phase: string; error?: string; width?: number; height?: number };
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
    }, 20_000).catch(async (error) => {
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
  };
}

describe.skipIf(!process.env.BSK_LONG_SCREENSHOT_CHROME)(
  "full-page screenshot in a real extension",
  () => {
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
        const image=document.querySelector('.preview-image'); await image.decode();
        const c=new OffscreenCanvas(image.naturalWidth,image.naturalHeight);const ctx=c.getContext('2d');ctx.drawImage(image,0,0);
        const data=ctx.getImageData(0,0,c.width,c.height).data;const badRows=[];
        for(let y=0;y<2603;y++){ const at=((y+31)*${scale}*c.width+100*${scale})*4;
          if(data[at]!==y%256||data[at+1]!==Math.floor(y/256)||data[at+2]!==127){if(badRows.length<12)badRows.push(y);}
        }return {badRows,width:c.width,height:c.height};})()`,
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

    it("rejects an oversized page and permits a fresh capture afterwards", async () => {
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
        expect(await h.finished()).toMatchObject({ phase: "error", error: "tooLarge" });
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
