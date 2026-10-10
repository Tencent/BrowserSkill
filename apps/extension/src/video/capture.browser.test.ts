// @vitest-environment node
// Opt in after cargo build + extension build. All browser, daemon, and output
// state belongs to temporary directories; no personal browser is contacted.
import { execFile, spawn } from "node:child_process";
import { type EventEmitter, once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { attachVideoBackground, type BrowserSend as Send } from "./browser-fixture";
import { createDshVideoFixture } from "./dsh-fixture";

const run = promisify(execFile);

function bluePdf(): Buffer {
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  const drawing = "0 0 1 rg 0 0 600 800 re f\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R >>",
    `<< /Length ${drawing.length} >>\nstream\n${drawing}endstream`,
  ];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

describe.skipIf(!process.env.BSK_VIDEO_CHROME || !process.env.BSK_VIDEO_BSK)(
  "video CLI/DSH browser integration",
  () => {
    it("records a fixed tab through navigation, exports after task teardown and previews a seekable MP4", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "bsk-video-flow-"));
      const executable = path.resolve(process.env.BSK_VIDEO_BSK!);
      const env = {
        ...process.env,
        BSK_HOME: path.join(directory, "state"),
        BSK_AUTO_START: "0",
        BSK_AUTO_UPDATE: "off",
      };
      const daemon = spawn(executable, ["daemon", "start", "--foreground", "--port", "0"], {
        env,
        stdio: "ignore",
      });
      const pageServer = createServer((request, response) => {
        if (request.url === "/error") {
          request.socket.destroy();
          return;
        }
        if (request.url === "/cancel" || request.url === "/hang") return;
        if (request.url === "/empty") {
          response.writeHead(204).end();
          return;
        }
        if (request.url === "/download") {
          response
            .writeHead(200, {
              "Content-Type": "application/octet-stream",
              "Content-Disposition": 'attachment; filename="video-test.txt"',
            })
            .end("test download");
          return;
        }
        if (request.url === "/pdf") {
          response.writeHead(200, { "Content-Type": "application/pdf" }).end(bluePdf());
          return;
        }
        if (request.url === "/prerender-start") {
          response.setHeader("Content-Type", "text/html");
          response.end(`<!doctype html><a href="/prerendered">Activate</a>
            <script type="speculationrules">{"prerender":[{"source":"list","urls":["/prerendered"]}]}</script>`);
          return;
        }

        response.setHeader("Content-Type", "text/html");
        response.end(
          `<!doctype html><title>Video regression</title><style>html,body{margin:0;background:${["/blue", "/late-overlay"].includes(request.url ?? "") ? "#0000ff" : "#ff0000"};height:100%;}</style>${request.url === "/blue" ? "<script>setTimeout(()=>{document.body.style.background='#00ff00'},800)</script>" : ""}`,
        );
      });
      pageServer.listen(0, "127.0.0.1");
      await once(pageServer as unknown as EventEmitter, "listening");
      const address = pageServer.address() as { port: number };
      const cli = async (...args: string[]) => {
        const result = await run(executable, ["--json", ...args], { env, timeout: 45_000 }).catch(
          (error) => {
            error.message += `\n${error.stdout}\n${error.stderr}`;
            throw error;
          },
        );
        return JSON.parse(result.stdout);
      };
      try {
        let port = 0;
        await expect
          .poll(
            async () => {
              try {
                port = JSON.parse(
                  await readFile(path.join(env.BSK_HOME, "daemon.json"), "utf8"),
                ).ws_port;
                return port;
              } catch {
                return 0;
              }
            },
            { timeout: 15_000 },
          )
          .toBeGreaterThan(0);
        const extension = path.join(directory, "extension");
        await cp(path.resolve("dist/chrome-mv3"), extension, { recursive: true });
        const manifestPath = path.join(extension, "manifest.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        manifest.name = "BrowserSkill video integration";
        await writeFile(manifestPath, JSON.stringify(manifest));
        const backgroundPath = path.join(extension, "background.js");
        const background = await readFile(backgroundPath, "utf8");
        expect(background).toContain("ws://127.0.0.1:52800");
        await writeFile(
          backgroundPath,
          background.replaceAll("ws://127.0.0.1:52800", `ws://127.0.0.1:${port}`),
        );
        // Only the fixture delays production content startup. onCompleted can
        // resume capture before its listener exists, and the video query arrives
        // after the ordinary overlay state. No production test hook is needed.
        const contentPath = path.join(extension, "content-scripts/content.js");
        const content = await readFile(contentPath, "utf8");
        await writeFile(
          contentPath,
          `(() => {
          const start = () => { ${content}\n };
          const route=location.pathname;
          if (!['/late-overlay','/query-retry','/query-recover','/prerendered'].includes(route)) { start(); return; }
          document.documentElement.dataset.videoPrerendered=String(document.prerendering);
          let attempts=0;
          const send = chrome.runtime.sendMessage.bind(chrome.runtime);
          chrome.runtime.sendMessage = (...args) => {
            if (args[0]?.type !== 'bsk/video-overlay' || args[0]?.action !== 'query') return send(...args);
            document.documentElement.dataset.videoQueryAttempts=String(++attempts);
            const failures=route==='/query-recover'?3:route==='/prerendered'?0:1;
            if(attempts<=failures)return Promise.reject(new Error('Transient video discovery failure'));
            if(route!=='/late-overlay')return send(...args);
            document.documentElement.dataset.videoQuery = 'pending';
            return new Promise(resolve => setTimeout(resolve, 1500)).then(() => send(...args)).then(result => {
              document.documentElement.dataset.videoQuery = 'ready';
              return result;
            });
          };
          if(route==='/late-overlay')setTimeout(start, 800);else start();
        })();`,
        );
        const { withChrome } = await import(
          new URL(
            "../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
            import.meta.url,
          ).href
        );
        const attachedPages: { parent: string; session: string; prerender: boolean }[] = [];
        await withChrome(
          {
            executable: process.env.BSK_VIDEO_CHROME,
            extensionPath: extension,
            deviceScale: 1,
            zoom: 1,
            // Prerender admission otherwise depends on the host's network-quality estimate.
            extraArgs: ["--force-effective-connection-type=4G"],
            onEvent: (event: {
              method: string;
              sessionId: string;
              params: { sessionId: string; targetInfo: { type: string; subtype?: string } };
            }) => {
              if (
                event.method === "Target.attachedToTarget" &&
                event.params.targetInfo.type === "page"
              )
                attachedPages.push({
                  parent: event.sessionId,
                  session: event.params.sessionId,
                  prerender: event.params.targetInfo.subtype === "prerender",
                });
            },
          },
          async (send: Send) => {
            await expect
              .poll(async () => (await cli("browsers")).length, { timeout: 15_000 })
              .toBe(1);
            const task = await cli("session", "start");
            const session = task.session_id;
            await cli("navigate", "--session", session, `http://127.0.0.1:${address.port}/red`);
            const started = await cli("video", "start", "--session", session, "--duration", "30s");
            const id = started.recording.recording_id;
            expect(started.recording.state).toBe("recording");
            await new Promise((resolve) => setTimeout(resolve, 1100));
            await cli("navigate", "--session", session, `http://127.0.0.1:${address.port}/blue`);
            const workerSession = await attachVideoBackground(send, manifest.name);
            const origin = workerSession.origin;
            const evaluate = async <T>(sessionId: string, expression: string): Promise<T> => {
              const result = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
                "Runtime.evaluate",
                { expression, returnByValue: true, awaitPromise: true },
                sessionId,
              );
              if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
              return result.result.value;
            };
            await expect
              .poll(
                () =>
                  evaluate(
                    workerSession.sessionId,
                    `chrome.tabs.sendMessage(${started.recording.tab_id},{type:'bsk-help-request',requestId:'video-help-test',prompt:'Confirm this step',selectors:[],timeoutMs:10000}).then(()=>true,()=>false)`,
                  ),
                { timeout: 10_000 },
              )
              .toBe(true);
            await new Promise((resolve) => setTimeout(resolve, 1200));
            await evaluate(
              workerSession.sessionId,
              `chrome.tabs.sendMessage(${started.recording.tab_id},{type:'bsk-help-cancel',requestId:'video-help-test'})`,
            );
            await new Promise((resolve) => setTimeout(resolve, 1100));
            // Opening another active tab must not retarget the recording.
            await evaluate(
              workerSession.sessionId,
              `chrome.tabs.create({url:'http://127.0.0.1:${address.port}/red',active:true})`,
            );
            await new Promise((resolve) => setTimeout(resolve, 1400));
            const stopped = await cli("video", "stop", "--recording", id);
            expect(stopped.recording.state).toBe("ready");
            expect(stopped.recording.completeness).toBe("complete");
            expect(stopped.recording.tab_id).toBe(started.recording.tab_id);
            await cli("session", "stop", session);
            expect((await cli("video", "stop", "--recording", id)).recording).toEqual(
              stopped.recording,
            );
            const output = path.join(directory, "result.mp4");
            await cli("video", "save", "--recording", id, "--out", output);
            expect((await stat(output)).size).toBe(stopped.recording.byte_size);
            await expect(
              cli("video", "save", "--recording", id, "--out", output),
            ).rejects.toThrow();
            const page = await send<{ targetId: string }>("Target.createTarget", {
              url: `${origin}/video.html?id=${id}`,
            });
            const preview = await send<{ sessionId: string }>("Target.attachToTarget", {
              targetId: page.targetId,
              flatten: true,
            });
            await expect
              .poll(
                () => evaluate(preview.sessionId, "document.querySelector('video')?.readyState>=2"),
                { timeout: 10_000 },
              )
              .toBe(true);
            const pixels = await evaluate<number[][]>(
              preview.sessionId,
              `(async()=>{const v=document.querySelector('video'),c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;const ctx=c.getContext('2d'),pixels=[];for(const time of [.2,v.duration-.3]){v.currentTime=time;await new Promise(r=>v.onseeked=r);ctx.drawImage(v,0,0);pixels.push(Array.from(ctx.getImageData(c.width/2,c.height/2,1,1).data));}return pixels})()`,
            );
            expect(pixels[0][0]).toBeGreaterThan(240);
            expect(pixels[1][1]).toBeGreaterThan(240);
            expect(pixels[1][0]).toBeLessThan(15);
            const screenshot = async (sessionId: string, name: string) => {
              if (!process.env.BSK_VIDEO_ARTIFACTS) return;
              await mkdir(process.env.BSK_VIDEO_ARTIFACTS, { recursive: true });
              const capture = await send<{ data: string }>(
                "Page.captureScreenshot",
                { format: "png" },
                sessionId,
              );
              await writeFile(
                path.join(process.env.BSK_VIDEO_ARTIFACTS, name),
                Buffer.from(capture.data, "base64"),
              );
            };
            await screenshot(preview.sessionId, "preview.png");
            // Exercise the real popup entry and its recording card.
            const popup = await send<{ targetId: string }>("Target.createTarget", {
              url: `${origin}/popup.html`,
            });
            const popupSession = await send<{ sessionId: string }>("Target.attachToTarget", {
              targetId: popup.targetId,
              flatten: true,
            });
            await expect
              .poll(
                () =>
                  evaluate(
                    popupSession.sessionId,
                    "!!document.querySelector('[data-slot=popup-launcher]')",
                  ),
                { timeout: 10_000 },
              )
              .toBe(true);
            await evaluate(
              popupSession.sessionId,
              "document.querySelector('[data-slot=popup-launcher]').click();true",
            );
            await expect
              .poll(
                () =>
                  evaluate(
                    popupSession.sessionId,
                    "!!document.querySelector('[data-slot=popup-feature-video]')",
                  ),
                { timeout: 3000 },
              )
              .toBe(true);
            await evaluate(
              popupSession.sessionId,
              "document.querySelector('[data-slot=popup-feature-video]').click();true",
            );
            await expect
              .poll(
                () =>
                  evaluate(
                    popupSession.sessionId,
                    "!!document.querySelector('[data-slot=video-panel]')",
                  ),
                { timeout: 3000 },
              )
              .toBe(true);

            await send(
              "Emulation.setDeviceMetricsOverride",
              { width: 340, height: 800, deviceScaleFactor: 1, mobile: false },
              popupSession.sessionId,
            );
            await expect
              .poll(
                () =>
                  evaluate(
                    popupSession.sessionId,
                    "document.querySelector('[data-slot=video-panel]').getBoundingClientRect().top>document.querySelector('header').getBoundingClientRect().bottom",
                  ),
                { timeout: 3000 },
              )
              .toBe(true);
            await screenshot(popupSession.sessionId, "popup.png");
            const secondTask = await cli("session", "start");
            await cli(
              "navigate",
              "--session",
              secondTask.session_id,
              `http://127.0.0.1:${address.port}/red`,
            );
            const capped = await cli(
              "video",
              "start",
              "--session",
              secondTask.session_id,
              "--duration",
              "1500ms",
            );
            await expect
              .poll(
                async () =>
                  (await cli("video", "status", "--recording", capped.recording.recording_id))
                    .recording.state,
                { timeout: 10_000 },
              )
              .toBe("ready");
            const capResult = await cli(
              "video",
              "stop",
              "--recording",
              capped.recording.recording_id,
            );
            expect(capResult.recording.stop_reason).toBe("duration_limit");
            expect(capResult.recording.duration_ms).toBe(1500);

            const partial = await cli(
              "video",
              "start",
              "--session",
              secondTask.session_id,
              "--duration",
              "30s",
            );
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await cli("session", "stop", secondTask.session_id);
            const partialStatus = await cli(
              "video",
              "status",
              "--recording",
              partial.recording.recording_id,
            );
            expect(partialStatus.recording.completeness).toBe("partial");
            expect(partialStatus.recording.stop_reason).toBe("session_ended");
            const partialPath = path.join(directory, "partial.mp4");
            await expect(
              cli(
                "video",
                "save",
                "--recording",
                partial.recording.recording_id,
                "--out",
                partialPath,
              ),
            ).rejects.toMatchObject({ code: 1 });
            expect((await stat(partialPath)).size).toBe(partialStatus.recording.byte_size);

            // Real top-level outcomes without a new content-script handshake.
            await send("Browser.setDownloadBehavior", {
              behavior: "allow",
              downloadPath: path.join(directory, "downloads"),
            });
            for (const route of [
              "blue",
              "late-overlay",
              "empty",
              "download",
              "cancel",
              "error",
              "pdf",
              "hang",
            ]) {
              const task = await cli("session", "start");
              await cli(
                "navigate",
                "--session",
                task.session_id,
                `http://127.0.0.1:${address.port}/red`,
              );
              const recording = (
                await cli(
                  "video",
                  "start",
                  "--session",
                  task.session_id,
                  "--duration",
                  route === "hang" ? "1500ms" : "15s",
                )
              ).recording;
              await new Promise((resolve) => setTimeout(resolve, 300));
              await evaluate(
                workerSession.sessionId,
                `chrome.tabs.update(${recording.tab_id},{url:'http://127.0.0.1:${address.port}/${route}'})`,
              );
              if (route === "cancel") {
                await new Promise((resolve) => setTimeout(resolve, 200));
                await evaluate(
                  workerSession.sessionId,
                  `chrome.debugger.sendCommand({tabId:${recording.tab_id}},'Page.stopLoading')`,
                );
              }
              await new Promise((resolve) => setTimeout(resolve, route === "hang" ? 2000 : 1500));
              if (route === "late-overlay") {
                await expect
                  .poll(
                    async () => {
                      const response = await evaluate<{ result: { value: string } }>(
                        workerSession.sessionId,
                        `chrome.debugger.sendCommand({tabId:${recording.tab_id}},'Runtime.evaluate',{expression:"document.documentElement.dataset.videoQuery",returnByValue:true})`,
                      );
                      return response.result.value;
                    },
                    { timeout: 10_000 },
                  )
                  .toBe("ready");
                await new Promise((resolve) => setTimeout(resolve, 1000));
              }
              if (["empty", "download", "cancel", "error"].includes(route)) {
                // The original document remains; changing it proves capture resumed.
                await evaluate(
                  workerSession.sessionId,
                  `chrome.debugger.sendCommand({tabId:${recording.tab_id}},'Runtime.evaluate',{expression:"document.body.style.background='#0000ff'"})`,
                );
                await new Promise((resolve) => setTimeout(resolve, 1200));
              }
              const stopped = await cli(
                "video",
                "stop",
                "--recording",
                recording.recording_id,
              ).catch((error) => {
                if (!["pdf", "error", "hang"].includes(route)) {
                  error.message += `\nRoute: ${route}`;
                  throw error;
                }
                return JSON.parse(error.stdout);
              });
              const result = stopped.recording;
              expect(result, route).toBeDefined();
              if (route === "hang" || result.completeness === "partial") {
                expect(["pdf", "error", "hang"], route).toContain(route);
                expect(result, route).toMatchObject({ state: "ready", completeness: "partial" });
                expect(
                  route === "pdf" ? ["capture_failed", "debugger_detached"] : ["capture_failed"],
                  route,
                ).toContain(result.stop_reason);
              } else {
                expect(result, route).toMatchObject({ state: "ready", completeness: "complete" });
                await send(
                  "Page.navigate",
                  { url: `${origin}/video.html?id=${recording.recording_id}` },
                  preview.sessionId,
                );
                await send("Page.bringToFront", {}, preview.sessionId);
                await expect
                  .poll(
                    () =>
                      evaluate(preview.sessionId, "document.querySelector('video')?.readyState>=1"),
                    { timeout: 10000 },
                  )
                  .toBe(true);
                const pixels = await evaluate<number[][]>(
                  preview.sessionId,
                  `(async()=>{
                  const v=document.querySelector('video'),c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;
                  const ctx=c.getContext('2d'),pixels=[];
                  for(let time=.1;time<v.duration-.1;time+=.1){v.currentTime=time;await new Promise(r=>v.onseeked=r);ctx.drawImage(v,0,0);pixels.push(Array.from(ctx.getImageData(c.width/2,c.height/2,1,1).data));}
                  return pixels;
                })()`,
                );
                // Navigation must never paint the neutral user-confirmation slate.
                if (!["error", "pdf"].includes(route))
                  expect(
                    pixels.some(
                      ([r, g, b]) =>
                        Math.abs(r - 32) < 4 && Math.abs(g - 33) < 4 && Math.abs(b - 36) < 4,
                    ),
                    route,
                  ).toBe(false);
                if (["empty", "download", "cancel", "error"].includes(route))
                  expect(pixels.at(-1)![2], route).toBeGreaterThan(240);
                if (route === "blue") expect(pixels.at(-1)![1], route).toBeGreaterThan(240);
                if (route === "late-overlay") {
                  expect(pixels.at(-1)![2], route).toBeGreaterThan(240);
                  // Sample faster than the 15 fps capture rate, including the
                  // initial frames. Uniform page colors make any control pill
                  // or orange breathing border visible as a pixel deviation.
                  const deviation = await evaluate<number>(
                    preview.sessionId,
                    `(async()=>{
                    const v=document.querySelector('video'),c=document.createElement('canvas');
                    c.width=160;c.height=Math.round(160*v.videoHeight/v.videoWidth);
                    const ctx=c.getContext('2d');let deviation=0;
                    for(let time=.01;time<v.duration-.01;time+=1/30){
                      v.currentTime=time;await new Promise(r=>v.onseeked=r);ctx.drawImage(v,0,0,c.width,c.height);
                      const data=ctx.getImageData(0,0,c.width,c.height).data;
                      const center=4*(Math.floor(c.height/2)*c.width+Math.floor(c.width/2));
                      for(let y=2;y<c.height-2;y++)for(let x=2;x<c.width-2;x++){
                        const border=x<4||x>=c.width-4||y<4||y>=c.height-4;
                        const pill=y>c.height*.75&&x>c.width*.25&&x<c.width*.75;
                        if(!border&&!pill)continue;
                        for(let channel=0;channel<3;channel++)deviation=Math.max(deviation,Math.abs(data[4*(y*c.width+x)+channel]-data[center+channel]));
                      }
                    }
                    return deviation;
                  })()`,
                  );
                  expect(deviation, "control overlay pixels in the recording").toBeLessThan(20);
                }
                if (route === "pdf") {
                  // If Chrome permits PDF capture, require the fixture's blue page,
                  // not merely a complete status with an unchanged/neutral frame.
                  expect(pixels.at(-1)![2], route).toBeGreaterThan(240);
                  expect(pixels.at(-1)![0], route).toBeLessThan(15);
                }
              }
              if (route === "hang")
                await evaluate(
                  workerSession.sessionId,
                  `chrome.debugger.sendCommand({tabId:${recording.tab_id}},'Page.stopLoading')`,
                ).catch(() => {});
              await cli("session", "stop", task.session_id);
            }

            // Ordinary, non-recorded tabs must recover their real UI after
            // transient/exhausted discovery, without any video-state push.
            const pageScript = async <T>(tabId: number, source: string): Promise<T> => {
              const results = await evaluate<{ result: T }[]>(
                workerSession.sessionId,
                `chrome.scripting.executeScript({target:{tabId:${tabId}},func:()=>{${source}}})`,
              );
              return results[0].result;
            };
            const shadowScript = `const root=chrome.dom.openOrClosedShadowRoot(document.querySelector('browser-skill-overlay'));`;
            const checkInteractiveOverlays = async (tabId: number) => {
              await evaluate(
                workerSession.sessionId,
                `void chrome.tabs.sendMessage(${tabId},{type:'borrow-request',requestId:'recovery-borrow',isActiveTab:true,tabTitle:'Recovery test',timeoutMs:10000}).catch(()=>{});true`,
              );
              await expect
                .poll(() =>
                  pageScript(
                    tabId,
                    `${shadowScript}return !!root?.querySelector('[data-slot=borrow-confirmation-modal]');`,
                  ),
                )
                .toBe(true);
              await pageScript(
                tabId,
                `${shadowScript}root.querySelector('[data-slot=borrow-confirmation-deny-button]').click();`,
              );
              await evaluate(
                workerSession.sessionId,
                `chrome.tabs.sendMessage(${tabId},{type:'bsk-help-request',requestId:'recovery-help',prompt:'Confirm this step',selectors:[],timeoutMs:10000})`,
              );
              await expect
                .poll(() =>
                  pageScript(
                    tabId,
                    `${shadowScript}return !!root?.querySelector('[data-slot=help-request-banner]');`,
                  ),
                )
                .toBe(true);
              await evaluate(
                workerSession.sessionId,
                `chrome.tabs.sendMessage(${tabId},{type:'bsk-help-cancel',requestId:'recovery-help'})`,
              );
            };
            for (const [route, attempts] of [
              ["query-retry", 2],
              ["query-recover", 3],
            ] as const) {
              const tab = await evaluate<{ id: number }>(
                workerSession.sessionId,
                `chrome.tabs.create({url:'http://127.0.0.1:${address.port}/${route}',active:true})`,
              );
              await expect
                .poll(
                  () =>
                    pageScript(
                      tab.id,
                      "return Number(document.documentElement.dataset.videoQueryAttempts);",
                    ),
                  { timeout: 10_000 },
                )
                .toBe(attempts);
              await checkInteractiveOverlays(tab.id);
              await evaluate(workerSession.sessionId, `chrome.tabs.remove(${tab.id})`);
            }

            // Exercise actual Speculation Rules activation; pageshow.persisted
            // is not involved, and the prerendered main frame has a nonzero ID.
            const prerenderTab = await evaluate<{ id: number }>(
              workerSession.sessionId,
              "chrome.tabs.create({url:'about:blank#video-prerender',active:true})",
            );
            const targets = await send<{ targetInfos: { targetId: string; url: string }[] }>(
              "Target.getTargets",
              { filter: [{ type: "tab", exclude: false }] },
            );
            const prerenderTarget = targets.targetInfos.find((target) =>
              target.url.endsWith("#video-prerender"),
            )!;
            const prerenderSession = await send<{ sessionId: string }>("Target.attachToTarget", {
              targetId: prerenderTarget.targetId,
              flatten: true,
            });
            // A legacy page-target session disables prerender. Attach through
            // the tab target so this fixture permits document replacement.
            await send(
              "Target.setAutoAttach",
              { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
              prerenderSession.sessionId,
            );
            const prerenderPage = attachedPages.find(
              (page) => page.parent === prerenderSession.sessionId,
            )!;
            await send("Page.setPrerenderingAllowed", { isAllowed: true }, prerenderPage.session);
            await evaluate(
              workerSession.sessionId,
              `chrome.tabs.update(${prerenderTab.id},{url:'http://127.0.0.1:${address.port}/prerender-start'})`,
            );
            type PrerenderFrame = { frameId: number; frameType: string; documentId: string };
            const prerenderFrame = () =>
              evaluate<PrerenderFrame | undefined>(
                workerSession.sessionId,
                `chrome.webNavigation.getAllFrames({tabId:${prerenderTab.id}}).then(frames=>frames.find(frame=>frame.documentLifecycle==='prerender'&&frame.url.endsWith('/prerendered')))`,
              );
            await expect
              .poll(prerenderFrame, { timeout: 15_000 })
              .toMatchObject({ frameType: "outermost_frame" });
            const prerender = (await prerenderFrame())!;
            expect(prerender.frameType).toBe("outermost_frame");
            expect(prerender.frameId).toBeGreaterThan(0);
            const pendingPage = attachedPages.find(
              (page) => page.parent === prerenderSession.sessionId && page.prerender,
            )!;
            await expect
              .poll(() =>
                evaluate(
                  pendingPage.session,
                  "({prerendering:document.prerendering,injected:document.documentElement.dataset.videoPrerendered,queries:Number(document.documentElement.dataset.videoQueryAttempts||0)})",
                ),
              )
              .toEqual({ prerendering: true, injected: "true", queries: 0 });
            await pageScript(prerenderTab.id, "document.querySelector('a').click();");
            await expect
              .poll(
                () =>
                  pageScript<number>(
                    prerenderTab.id,
                    "return performance.getEntriesByType('navigation')[0].activationStart;",
                  ),
                { timeout: 10_000 },
              )
              .toBeGreaterThan(0);
            await expect
              .poll(
                () =>
                  pageScript<number>(
                    prerenderTab.id,
                    "return Number(document.documentElement.dataset.videoQueryAttempts);",
                  ),
                { timeout: 10_000 },
              )
              .toBeGreaterThan(0);
            await checkInteractiveOverlays(prerenderTab.id);
            await send("Target.detachFromTarget", { sessionId: prerenderSession.sessionId });
            await evaluate(workerSession.sessionId, `chrome.tabs.remove(${prerenderTab.id})`);

            // The packaged DSH tool surface records before the first task
            // navigation and exports after its owned session is gone.
            const dsh = await createDshVideoFixture(executable, env, path.join(directory, "dsh"));
            try {
              const task = await dsh.call<{ sessionId: string }>("browser_session", {
                action: "start",
              });
              const started = await dsh.call<{
                recording: { recording_id: string; state: string };
              }>("browser_inspect", {
                action: "video",
                videoAction: "start",
                session: task.sessionId,
                durationMs: 30000,
              });
              expect(started.recording.state).toBe("recording");
              const recordingId = started.recording.recording_id;
              await dsh.call("browser_page", {
                action: "navigate",
                session: task.sessionId,
                url: `http://127.0.0.1:${address.port}/red`,
              });
              await new Promise((resolve) => setTimeout(resolve, 1200));
              const finished = await dsh.call<{
                recording: { state: string; completeness: string; byte_size: number };
              }>("browser_inspect", { action: "video", videoAction: "stop", recordingId });
              expect(finished.recording.state).toBe("ready");
              expect(finished.recording.completeness).toBe("complete");
              await dsh.call("browser_session", { action: "stop", session: task.sessionId });
              const output = path.join(directory, "dsh.mp4");
              await dsh.call("browser_inspect", {
                action: "video",
                videoAction: "save",
                recordingId,
                output,
              });
              expect((await stat(output)).size).toBe(finished.recording.byte_size);
              await expect(
                dsh.call("browser_inspect", {
                  action: "video",
                  videoAction: "save",
                  recordingId,
                  output,
                }),
              ).rejects.toThrow(/Output exists/);
              const list = await dsh.call<{ recordings: { recording_id: string }[] }>(
                "browser_inspect",
                { action: "video", videoAction: "list" },
              );
              expect(list.recordings.map((value) => value.recording_id)).toEqual([recordingId]);
              await send(
                "Page.navigate",
                { url: `${origin}/video.html?id=${recordingId}` },
                preview.sessionId,
              );
              await send("Page.bringToFront", {}, preview.sessionId);
              await expect
                .poll(
                  () =>
                    evaluate(
                      preview.sessionId,
                      `({search:location.search,loaded:document.querySelector('video')?.readyState>=1,error:document.querySelector('[role=alert]')?.textContent??'',video:!!document.querySelector('video'),body:document.body.innerText.slice(0,400)})`,
                    ),
                  { timeout: 10000 },
                )
                .toMatchObject({
                  search: `?id=${recordingId}`,
                  loaded: true,
                  error: "",
                  video: true,
                });
              // The preview intentionally preloads only metadata. Seek to
              // request and verify a decoded frame from the completed task.
              const pixel = await evaluate<number[]>(
                preview.sessionId,
                `(async()=>{const v=document.querySelector('video'),c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;v.currentTime=v.duration-.2;await new Promise(r=>v.onseeked=r);const ctx=c.getContext('2d');ctx.drawImage(v,0,0);return Array.from(ctx.getImageData(c.width/2,c.height/2,1,1).data)})()`,
              );
              expect(pixel[0]).toBeGreaterThan(240);
              expect(pixel[1]).toBeLessThan(15);
            } finally {
              await dsh.dispose();
            }
          },
        );
      } finally {
        pageServer.closeAllConnections();
        await new Promise<void>((resolve) => pageServer.close(() => resolve()));
        if (daemon.exitCode === null && daemon.signalCode === null) {
          const exited = once(daemon as unknown as EventEmitter, "exit");
          daemon.kill();
          await exited;
        }
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }, 180_000);
  },
);
