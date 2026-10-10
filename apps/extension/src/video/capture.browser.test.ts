// @vitest-environment node
// Opt in after cargo build + extension build. All browser, daemon, and output
// state belongs to temporary directories; no personal browser is contacted.
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
const run = promisify(execFile);

describe.skipIf(!process.env.BSK_VIDEO_CHROME || !process.env.BSK_VIDEO_BSK)(
  "video CLI/browser integration",
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
        response.setHeader("Content-Type", "text/html");
        response.end(
          `<!doctype html><title>Video regression</title><style>html,body{margin:0;background:${request.url === "/blue" ? "#0000ff" : "#ff0000"};height:100%;}</style>${request.url === "/blue" ? "<script>setTimeout(()=>{document.body.style.background='#00ff00'},800)</script>" : ""}`,
        );
      });
      pageServer.listen(0, "127.0.0.1");
      await once(pageServer, "listening");
      const address = pageServer.address() as { port: number };
      const cli = async (...args: string[]) => {
        const result = await run(executable, ["--json", ...args], { env, timeout: 45_000 });
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
        const backgroundPath = path.join(extension, "background.js");
        const background = await readFile(backgroundPath, "utf8");
        expect(background).toContain("ws://127.0.0.1:52800");
        await writeFile(
          backgroundPath,
          background.replaceAll("ws://127.0.0.1:52800", `ws://127.0.0.1:${port}`),
        );
        const { withChrome } = await import(
          new URL(
            "../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
            import.meta.url,
          ).href
        );
        await withChrome(
          {
            executable: process.env.BSK_VIDEO_CHROME,
            extensionPath: extension,
            deviceScale: 1,
            zoom: 1,
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
            const targets = await send<{
              targetInfos: { type: string; url: string; targetId: string }[];
            }>("Target.getTargets");
            const worker = targets.targetInfos.find(
              (target) => target.type === "service_worker" && target.url.endsWith("/background.js"),
            )!;
            const origin = worker.url.slice(0, -"/background.js".length);
            const workerSession = await send<{ sessionId: string }>("Target.attachToTarget", {
              targetId: worker.targetId,
              flatten: true,
            });
            const evaluate = async <T>(sessionId: string, expression: string): Promise<T> => {
              const result = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
                "Runtime.evaluate",
                { expression, returnByValue: true, awaitPromise: true },
                sessionId,
              );
              if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
              return result.result.value;
            };
            await evaluate(
              workerSession.sessionId,
              `chrome.tabs.sendMessage(${started.recording.tab_id},{type:'bsk-help-request',requestId:'video-help-test',prompt:'Confirm this step',selectors:[],timeoutMs:10000})`,
            );
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
          },
        );
      } finally {
        pageServer.closeAllConnections();
        await new Promise<void>((resolve) => pageServer.close(() => resolve()));
        if (daemon.exitCode === null && daemon.signalCode === null) {
          const exited = once(daemon, "exit");
          daemon.kill();
          await exited;
        }
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }, 120_000);
  },
);
