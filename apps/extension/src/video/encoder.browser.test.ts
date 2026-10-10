// @vitest-environment node
// Opt in with BSK_VIDEO_CHROME after building. Uses the production offscreen
// document and encoder worker in an isolated extension and browser profile.
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

const entry = `
import { BrowserVideoHost } from '@/video/host';
import { VideoArtifactStore } from '@/video/store';
import { VIDEO_RETENTION_MS } from '@/video/types';
const host = new BrowserVideoHost();
const store = new VideoArtifactStore();
chrome.runtime.onInstalled.addListener(() => {});
globalThis.runEncoder = async (crash = false) => {
  const canvas=new OffscreenCanvas(320,180),ctx=canvas.getContext('2d');
  const image=async(color)=>{ctx.fillStyle=color;ctx.fillRect(0,0,320,180);const bytes=new Uint8Array(await (await canvas.convertToBlob({type:'image/png'})).arrayBuffer());return btoa(String.fromCharCode(...bytes));};
  const recording={recording_id:'vid_'+crypto.randomUUID().replaceAll('-',''),session_id:'test',tab_id:1,title:'Encoder regression',state:'starting',quality:'standard',created_at:Date.now(),expires_at:Date.now()+VIDEO_RETENTION_MS,max_duration_ms:4000,duration_ms:0,byte_size:0,width:0,height:0,frames:0,dropped_frames:0,exported:false,owner:'test',capability:'test-capability',request_id:'test-request'};
  await store.put(recording);
  await host.request({action:'start',recording,image:await image('#ff0000')});
  await new Promise(resolve=>setTimeout(resolve,1200));
  await host.request({action:'frame',recording_id:recording.recording_id,image:await image('#0000ff'),elapsed_ms:1200});
  await new Promise(resolve=>setTimeout(resolve,1200));
  if(crash) await chrome.offscreen.closeDocument();
  const result=await host.request(crash ? {action:'recover',recording_id:recording.recording_id} : {action:'stop',recording_id:recording.recording_id,reason:'user_stopped'});
  return {result,id:recording.recording_id};
};
`;

const player = `
import { VideoArtifactStore } from '@/video/store';
globalThis.inspectVideo=async(id)=>{
  const file=await new VideoArtifactStore().file(id);
  const video=document.createElement('video');video.muted=true;document.body.append(video);
  const url=URL.createObjectURL(file);video.src=url;
  await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(Error('MP4 playback failed'));});
  const pixels=[];
  const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const ctx=canvas.getContext('2d');
  for(const time of [.2,video.duration-.2]){
    video.currentTime=time;await new Promise(resolve=>video.onseeked=resolve);
    ctx.drawImage(video,0,0);pixels.push(Array.from(ctx.getImageData(160,90,1,1).data));
  }
  const result={duration:video.duration,width:video.videoWidth,height:video.videoHeight,pixels};
  URL.revokeObjectURL(url);video.remove();return result;
};
`;

describe.skipIf(!process.env.BSK_VIDEO_CHROME)("video encoder browser regression", () => {
  it("encodes offscreen, preserves static time and produces a seekable MP4", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bsk-video-extension-"));
    try {
      await cp(path.resolve("dist/chrome-mv3"), directory, { recursive: true });
      const require = createRequire(import.meta.url);
      const { build } = await import(
        require.resolve("vite", { paths: [require.resolve("vitest")] })
      );
      for (const [name, source] of [
        ["background", entry],
        ["player", player],
      ]) {
        const input = path.join(directory, `${name}-entry.js`);
        await writeFile(input, source);
        await build({
          configFile: false,
          logLevel: "error",
          resolve: { alias: { "@": path.resolve("src") } },
          build: {
            outDir: directory,
            emptyOutDir: false,
            lib: {
              entry: input,
              formats: ["iife"],
              name: "VideoRegression",
              fileName: () => `${name}.js`,
            },
          },
        });
      }
      await writeFile(
        path.join(directory, "player.html"),
        '<!doctype html><script src="player.js"></script>',
      );
      await writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify({
          manifest_version: 3,
          name: "Video encoding regression",
          version: "1.0",
          background: { service_worker: "background.js" },
          permissions: ["offscreen", "storage"],
        }),
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
          extensionPath: directory,
          deviceScale: 1,
          zoom: 1,
        },
        async (send: Send) => {
          let target: { targetId: string; url: string } | undefined;
          await expect
            .poll(
              async () => {
                const result = await send<{
                  targetInfos: { targetId: string; url: string; type: string }[];
                }>("Target.getTargets");
                target = result.targetInfos.find(
                  (value) =>
                    value.type === "service_worker" && value.url.endsWith("/background.js"),
                );
                return !!target;
              },
              { timeout: 15_000 },
            )
            .toBe(true);
          const origin = target!.url.slice(0, -"/background.js".length);
          const background = await send<{ sessionId: string }>("Target.attachToTarget", {
            targetId: target!.targetId,
            flatten: true,
          });
          const evaluate = async <T>(session: string, expression: string) => {
            const result = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
              "Runtime.evaluate",
              { expression, returnByValue: true, awaitPromise: true },
              session,
            );
            if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
            return result.result.value;
          };
          await expect
            .poll(() => evaluate(background.sessionId, "typeof runEncoder==='function'"), {
              timeout: 10_000,
            })
            .toBe(true);
          await evaluate(
            background.sessionId,
            "runEncoder().then(value=>globalThis.done={value},error=>globalThis.done={error:String(error)});true",
          );
          await expect
            .poll(() => evaluate(background.sessionId, "!!globalThis.done"), { timeout: 45_000 })
            .toBe(true);
          const done = await evaluate<{
            error?: string;
            value: {
              id: string;
              result: { state: string; duration_ms: number; byte_size: number; error?: string };
            };
          }>(background.sessionId, "globalThis.done");
          expect(done.error).toBeUndefined();
          expect(done.value.result.error).toBeUndefined();
          expect(done.value.result.state).toBe("ready");
          expect(done.value.result.duration_ms).toBeGreaterThanOrEqual(2300);
          expect(done.value.result.duration_ms).toBeLessThan(3500);
          expect(done.value.result.byte_size).toBeGreaterThan(1000);
          const page = await send<{ targetId: string }>("Target.createTarget", {
            url: `${origin}/player.html`,
          });
          const attached = await send<{ sessionId: string }>("Target.attachToTarget", {
            targetId: page.targetId,
            flatten: true,
          });
          await expect
            .poll(() => evaluate(attached.sessionId, "typeof inspectVideo==='function'"), {
              timeout: 10_000,
            })
            .toBe(true);
          const result = await evaluate<{
            duration: number;
            width: number;
            height: number;
            pixels: number[][];
          }>(attached.sessionId, `inspectVideo(${JSON.stringify(done.value.id)})`);
          expect(result.width).toBe(320);
          expect(result.height).toBe(180);
          expect(result.duration).toBeGreaterThanOrEqual(2.3);
          expect(result.pixels[0][0]).toBeGreaterThan(240);
          expect(result.pixels[0][2]).toBeLessThan(15);
          expect(result.pixels[1][0]).toBeLessThan(15);
          expect(result.pixels[1][2]).toBeGreaterThan(240);
          await evaluate(
            background.sessionId,
            "runEncoder(true).then(value=>globalThis.recovered={value},error=>globalThis.recovered={error:String(error)});true",
          );
          await expect
            .poll(() => evaluate(background.sessionId, "!!globalThis.recovered"), {
              timeout: 45_000,
            })
            .toBe(true);
          const recovered = await evaluate<{
            error?: string;
            value: {
              id: string;
              result: {
                state: string;
                completeness: string;
                stop_reason: string;
                byte_size: number;
              };
            };
          }>(background.sessionId, "globalThis.recovered");
          expect(recovered.error).toBeUndefined();
          expect(recovered.value.result).toMatchObject({
            state: "ready",
            completeness: "partial",
            stop_reason: "browser_restarted",
          });
          expect(recovered.value.result.byte_size).toBeGreaterThan(0);
          const salvaged = await evaluate<{ duration: number }>(
            attached.sessionId,
            `inspectVideo(${JSON.stringify(recovered.value.id)})`,
          );
          expect(salvaged.duration).toBeGreaterThan(0);
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);
});
