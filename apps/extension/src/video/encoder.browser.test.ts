// @vitest-environment node
// Opt in with BSK_VIDEO_CHROME after building. Uses the production offscreen
// document and encoder worker in an isolated extension and browser profile.
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  attachVideoBackground,
  type BrowserSend as Send,
  saveVideoEvidence,
} from "./browser-fixture";

const entry = `
import { BrowserVideoHost } from '@/video/host';
import { VideoArtifactStore } from '@/video/store';
import { VIDEO_RETENTION_MS } from '@/video/types';
const host = new BrowserVideoHost();
const store = new VideoArtifactStore();
chrome.runtime.onInstalled.addListener(() => {});
globalThis.runEncoder = async (crash = false, width = 320, height = 180, quality = 'standard') => {
  const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d');
  const image = async (color) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, width, height);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({type:'image/png'})).arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return btoa(binary);
  };
  const recording={recording_id:'vid_'+crypto.randomUUID().replaceAll('-',''),session_id:'test',tab_id:1,title:'Encoder regression',state:'starting',quality,created_at:Date.now(),expires_at:Date.now()+VIDEO_RETENTION_MS,max_duration_ms:4000,duration_ms:0,byte_size:0,width:0,height:0,frames:0,dropped_frames:0,exported:false,owner:'test',capability:'test-capability',request_id:'test-request'};
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
import { readVideoPixels, videoFrameTargets } from '@/video/playback-fixture';
globalThis.exportVideo=async(id)=>{
  const bytes=new Uint8Array(await (await new VideoArtifactStore().file(id)).arrayBuffer());
  let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(binary);
};
globalThis.inspectVideo=async(id)=>{
  const file=await new VideoArtifactStore().file(id);
  const video=document.createElement('video');video.muted=true;document.body.append(video);
  const url=URL.createObjectURL(file);video.src=url;
  await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(Error('MP4 playback failed'));});
  // Exercise a no-op seek at the initial position, repeated targets and two
  // requested times within one sparse frame in the real browser too.
  const targets=await videoFrameTargets(file,[0,0,.2,.2,video.duration-.2]);
  const samples=await readVideoPixels(video,targets);
  if(JSON.stringify(samples[0])!==JSON.stringify(samples[1])||JSON.stringify(samples[2])!==JSON.stringify(samples[3]))throw Error('Repeated frame samples disagree');
  const pixels=[samples[2],samples[4]];
  const result={duration:video.duration,width:video.videoWidth,height:video.videoHeight,pixels};
  URL.revokeObjectURL(url);video.remove();return result;
};
`;

describe.skipIf(!process.env.BSK_VIDEO_CHROME)("video encoder browser regression", () => {
  it("encodes offscreen, preserves static time and produces a seekable MP4", async () => {
    const extensionName = "Video encoding regression";
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
          name: extensionName,
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
          const background = await attachVideoBackground(send, extensionName);
          const origin = background.origin;
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
          const version = await send("Browser.getVersion");
          const inspect = async (id: string, name: string, recording: unknown) => {
            if (process.env.BSK_VIDEO_ARTIFACTS) {
              // Persist the file and initial metadata before playback; update
              // the JSON below only after sampling succeeds. Failed playback
              // must still leave the original MP4 and recording details.
              await saveVideoEvidence(name, { version, recording }, async () => {
                const data = await evaluate<string>(
                  attached.sessionId,
                  `exportVideo(${JSON.stringify(id)})`,
                );
                return Buffer.from(data, "base64");
              });
            }
            const playback = await evaluate<{
              duration: number;
              width: number;
              height: number;
              pixels: number[][];
            }>(attached.sessionId, `inspectVideo(${JSON.stringify(id)})`);
            await saveVideoEvidence(name, { version, recording, playback });
            return playback;
          };
          const result = await inspect(done.value.id, "encoder-standard", done.value.result);
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
          const salvaged = await inspect(
            recovered.value.id,
            "encoder-recovered",
            recovered.value.result,
          );
          expect(salvaged.duration).toBeGreaterThan(0);

          // Clear-quality frames can exceed level 4.2 despite a <=1920 longest edge.
          for (const [width, height] of [
            [1920, 1154],
            [1920, 1200],
            [1200, 1920],
            [1920, 1920],
          ]) {
            const recorded = await evaluate<{
              id: string;
              result: { state: string; completeness: string; error?: string };
            }>(background.sessionId, `runEncoder(false, ${width}, ${height}, 'clear')`);
            expect(recorded.result.error).toBeUndefined();
            expect(recorded.result).toMatchObject({ state: "ready", completeness: "complete" });
            const playback = await inspect(
              recorded.id,
              `encoder-${width}x${height}`,
              recorded.result,
            );
            expect(playback).toMatchObject({ width, height });
            expect(playback.duration).toBeGreaterThanOrEqual(2.3);
            expect(playback.pixels[0][0]).toBeGreaterThan(240);
            expect(playback.pixels[0][2]).toBeLessThan(15);
            expect(playback.pixels[1][0]).toBeLessThan(15);
            expect(playback.pixels[1][2]).toBeGreaterThan(240);
          }
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);
});
