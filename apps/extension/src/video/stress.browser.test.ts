// @vitest-environment node
// Opt-in capacity benchmark; kept out of routine CI because capture takes ten minutes.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { attachVideoBackground, type BrowserSend } from "./browser-fixture";

const worker = `
import { VideoEncoderPipeline, finishVideo } from '@/video/encoder';
import { VideoArtifactStore, videoDirectory } from '@/video/store';
import { VIDEO_RETENTION_MS, VIDEO_MAX_BYTES } from '@/video/types';
import { BlobSource, EncodedPacket, EncodedPacketSink, EncodedVideoPacketSource, Input, MP4, Mp4OutputFormat, Output, StreamTarget } from 'mediabunny';
const store = new VideoArtifactStore();
const recording = () => ({recording_id:'vid_'+crypto.randomUUID().replaceAll('-',''),session_id:'benchmark',tab_id:1,title:'Capacity benchmark',state:'starting',quality:'clear',created_at:Date.now(),expires_at:Date.now()+VIDEO_RETENTION_MS,max_duration_ms:600000,duration_ms:0,byte_size:0,width:1920,height:1080,frames:0,dropped_frames:0,exported:false,owner:'benchmark',capability:'benchmark',request_id:'benchmark'});
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function run() {
  const canvas = new OffscreenCanvas(1920,1080), ctx = canvas.getContext('2d');
  const images = [];
  let seed = 1;
  for(let n=0;n<16;n++) {
    const pixels = ctx.createImageData(1920,1080);
    for(let i=0;i<pixels.data.length;i+=4) {
      seed = (Math.imul(seed,1664525)+1013904223)>>>0;
      pixels.data[i]=seed&255; pixels.data[i+1]=(seed>>>8)&255; pixels.data[i+2]=(seed>>>16)&255; pixels.data[i+3]=255;
    }
    ctx.putImageData(pixels,0,0);
    if(DURATION_PATTERN) { ctx.fillStyle="#f0f0f0"; ctx.fillRect(0,0,1920,1080); ctx.fillStyle="#1565c0"; for(let x=0;x<1920;x+=160)ctx.fillRect(x+n*4,160,80,700); }
    if(n===0) { ctx.fillStyle='#ff0000'; ctx.fillRect(0,0,1920,1080); }
    const bytes = new Uint8Array(await (await canvas.convertToBlob({type:'image/jpeg',quality:.45})).arrayBuffer());
    let binary=''; for(let i=0;i<bytes.length;i+=8192) binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    images.push(btoa(binary));
  }
  const value = recording();
  await store.put(value);
  let finished = false, stopStarted;
  let resolveDone;
  const done = new Promise(r => resolveDone=r);
  const pipeline = new VideoEncoderPipeline(value, () => {});
  const stop = pipeline.stop.bind(pipeline);
  pipeline.stop = reason => {
    stopStarted ??= performance.now();
    return stop(reason).then(result => {
      if(!finished) {
        finished = true;
        resolveDone({recording:result,finalization_ms:performance.now()-stopStarted});
      }
      return result;
    });
  };
  await pipeline.start(images[0]);
  const origin=performance.now(); let frames=0;
  while(!finished && performance.now()-origin<610000) {
    await pipeline.frame(images[frames%images.length],performance.now()-origin);
    frames++;
    if(frames%900===0) self.postMessage({progress_ms:performance.now()-origin,submitted_frames:frames});
    await sleep(Math.max(0, origin+frames*1000/30-performance.now()));
  }
  const realtime = await done;
  self.postMessage({realtime});
  // Independently stress the largest packet table and near-maximum file size.
  // Repeat a real AVC keyframe with a standards-compliant filler NAL; no re-encode.
  const input = new Input({ source:new BlobSource(await store.file(value.recording_id)), formats:[MP4] });
  const track=await input.getPrimaryVideoTrack(), config=await track.getDecoderConfig();
  const packet=await new EncodedPacketSink(track).getFirstPacket();
  const count=18000, packetSize=Math.floor((VIDEO_MAX_BYTES-2*1024*1024)/count);
  if(packet.data.length+6>packetSize) throw Error('Benchmark keyframe exceeds padded sample size');
  const data=new Uint8Array(packetSize); data.set(packet.data);
  const filler=packetSize-packet.data.length-4;
  new DataView(data.buffer).setUint32(packet.data.length,filler);
  data[packet.data.length+4]=12; data.fill(255,packet.data.length+5,packetSize-1); data[packetSize-1]=128;
  const capacity={...recording(),stop_reason:'user_stopped'};
  await store.put(capacity);
  const directory=await videoDirectory(capacity.recording_id,true);
  const journal=await (await directory.getFileHandle('fragments.mp4',{create:true})).createSyncAccessHandle();
  const output=new Output({format:new Mp4OutputFormat({fastStart:'fragmented',minimumFragmentDuration:1}),target:new StreamTarget(new WritableStream({write({data,position}) {journal.write(data,{at:position});}}))});
  const source=new EncodedVideoPacketSource('avc');output.addVideoTrack(source);await output.start();
  for(let n=0;n<count;n++) await source.add(new EncodedPacket(data,'key',n/30,1/30),n===0?{decoderConfig:config}:undefined);
  source.close();await output.finalize();journal.flush();journal.close();input.dispose();
  const began=performance.now();const result=await finishVideo(capacity);
  return {realtime,capacity:{recording:result,finalization_ms:performance.now()-began},submitted_frames:frames};
}
run().then(result=>self.postMessage({done:result}), error=>self.postMessage({error:String(error),stack:error.stack}));
`;

it.skipIf(!process.env.BSK_VIDEO_CHROME || !process.env.BSK_VIDEO_STRESS)(
  "measures clear-quality capture and the maximum MP4 remux workload",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bsk-video-capacity-"));
    try {
      const require = createRequire(import.meta.url);
      const { build } = await import(
        require.resolve("vite", { paths: [require.resolve("vitest")] })
      );
      const entry = path.join(directory, "stress-entry.js");
      await writeFile(
        entry,
        worker.replace("DURATION_PATTERN", String(process.env.BSK_VIDEO_STRESS === "duration")),
      );
      await build({
        configFile: false,
        logLevel: "error",
        resolve: {
          alias: {
            "@": path.resolve("src"),
            mediabunny: path.resolve("node_modules/mediabunny/dist/modules/src/index.js"),
          },
        },
        build: {
          outDir: directory,
          emptyOutDir: false,
          lib: { entry, formats: ["es"], fileName: () => "stress.js" },
        },
      });
      await writeFile(
        path.join(directory, "background.js"),
        "chrome.runtime.onInstalled.addListener(()=>{});",
      );
      await writeFile(
        path.join(directory, "player.js"),
        "globalThis.progress=[];const worker=new Worker('stress.js',{type:'module'});worker.onmessage=({data})=>{globalThis.progress.push(data);if(data.done||data.error)globalThis.done=data;};worker.onerror=e=>globalThis.done={error:e.message};",
      );
      await writeFile(
        path.join(directory, "player.html"),
        '<!doctype html><script src="player.js"></script>',
      );
      const name = "Video capacity benchmark";
      await writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify({
          manifest_version: 3,
          name,
          version: "1.0",
          background: { service_worker: "background.js" },
          permissions: ["storage"],
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
        async (send: BrowserSend) => {
          const background = await attachVideoBackground(send, name);
          const page = await send<{ targetId: string }>("Target.createTarget", {
            url: `${background.origin}/player.html`,
          });
          const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
            targetId: page.targetId,
            flatten: true,
          });
          const version = await send("Browser.getVersion");
          let result:
            | {
                error?: string;
                done?: {
                  realtime: {
                    recording: {
                      width: number;
                      height: number;
                      state: string;
                      duration_ms: number;
                      stop_reason: string;
                      completeness: string;
                    };
                    finalization_ms: number;
                  };
                  capacity: {
                    recording: {
                      frames: number;
                      byte_size: number;
                      duration_ms: number;
                      state: string;
                      recording_id: string;
                    };
                    finalization_ms: number;
                  };
                };
              }
            | undefined;
          await expect
            .poll(
              async () => {
                const reply = await send<{ result: { value: typeof result } }>(
                  "Runtime.evaluate",
                  { expression: "globalThis.done", returnByValue: true },
                  sessionId,
                );
                result = reply.result.value;
                return !!result;
              },
              { timeout: 680000, interval: 1000 },
            )
            .toBe(true);
          console.log(JSON.stringify({ version, ...result }));
          if (process.env.BSK_VIDEO_BENCHMARK_OUT)
            await writeFile(
              process.env.BSK_VIDEO_BENCHMARK_OUT,
              JSON.stringify({ version, ...result }, null, 2),
            );
          expect(result?.error).toBeUndefined();
          expect(result?.done?.realtime.recording).toMatchObject({
            width: 1920,
            height: 1080,
            state: "ready",
          });
          expect(result?.done?.realtime.recording.completeness).toBe("complete");
          expect(result?.done?.realtime.recording.stop_reason).toBe(
            process.env.BSK_VIDEO_STRESS === "duration" ? "duration_limit" : "size_limit",
          );
          if (process.env.BSK_VIDEO_STRESS === "duration")
            expect(result?.done?.realtime.recording.duration_ms).toBe(600000);
          expect(result?.done?.capacity.recording).toMatchObject({
            frames: 18000,
            duration_ms: 600000,
            state: "ready",
          });
          expect(result!.done!.capacity.recording.byte_size).toBeGreaterThan(250 * 1024 * 1024);
          expect(result!.done!.realtime.finalization_ms).toBeLessThan(29000);
          expect(result!.done!.capacity.finalization_ms).toBeLessThan(29000);
          await send("Page.bringToFront", {}, sessionId);
          const playback = await send<{
            result: { value: { width: number; height: number; duration: number; red: number } };
            exceptionDetails?: unknown;
          }>(
            "Runtime.evaluate",
            {
              expression: `(async()=>{
              const root=await navigator.storage.getDirectory(),videos=await root.getDirectoryHandle('videos'),dir=await videos.getDirectoryHandle('${result!.done!.capacity.recording.recording_id}');
              const file=await (await dir.getFileHandle('video.mp4')).getFile(),v=document.createElement('video');v.muted=true;document.body.append(v);v.src=URL.createObjectURL(file);
              await new Promise((resolve,reject)=>{v.onloadedmetadata=resolve;v.onerror=()=>reject(Error('capacity MP4 failed to load'));});
              v.currentTime=599.9;await new Promise((resolve,reject)=>{v.onseeked=resolve;v.onerror=()=>reject(Error('capacity MP4 failed to seek'));});
              const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;const ctx=c.getContext('2d');ctx.drawImage(v,0,0);
              return {width:v.videoWidth,height:v.videoHeight,duration:v.duration,red:ctx.getImageData(c.width/2,c.height/2,1,1).data[0]};
            })()`,
              returnByValue: true,
              awaitPromise: true,
            },
            sessionId,
          );
          expect(playback.exceptionDetails).toBeUndefined();
          expect(playback.result.value).toMatchObject({ width: 1920, height: 1080, duration: 600 });
          expect(playback.result.value.red).toBeGreaterThan(240);
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  720000,
);
