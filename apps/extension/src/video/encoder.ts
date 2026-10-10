import {
  BlobSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type StreamTargetChunk,
} from "mediabunny";
import { VideoError } from "./errors";
import type { VideoSuspension } from "./host-protocol";
import { VideoArtifactStore, videoDirectory } from "./store";
import { VideoTimeline, videoDimensions } from "./timeline";
import {
  completeStop,
  type StoredVideo,
  VIDEO_MAX_BYTES,
  VIDEO_PRESETS,
  type VideoStopReason,
} from "./types";

interface SyncFile {
  write(data: Uint8Array<ArrayBuffer>, options: { at: number }): number;
  flush(): void;
  close(): void;
  truncate(size: number): void;
}

async function syncFile(handle: FileSystemFileHandle): Promise<SyncFile> {
  const file = await (
    handle as FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncFile> }
  ).createSyncAccessHandle();
  file.truncate(0);
  return file;
}

function fileTarget(file: SyncFile, limit: number, durable = true) {
  return new StreamTarget(
    new WritableStream<StreamTargetChunk>({
      write({ data, position }) {
        if (position + data.byteLength > limit) throw new Error("video_size_limit");
        if (file.write(data, { at: position }) !== data.byteLength)
          throw new Error("Video storage returned an incomplete write");
        if (durable) file.flush();
      },
    }),
    { chunked: false },
  );
}

async function decodeImage(data: string): Promise<ImageBitmap> {
  const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
  return createImageBitmap(new Blob([bytes]));
}

/** Find the last complete fragment without loading a recording into memory. */
export async function completeFragmentLength(file: Blob): Promise<number> {
  let offset = 0;
  let complete = 0;
  let initialized = false;
  let fragment = false;
  while (offset + 8 <= file.size) {
    const bytes = new Uint8Array(await file.slice(offset, offset + 16).arrayBuffer());
    const view = new DataView(bytes.buffer);
    let size = view.getUint32(0);
    const type = String.fromCharCode(...bytes.subarray(4, 8));
    if (size === 1) {
      if (bytes.length < 16) break;
      size = Number(view.getBigUint64(8));
    }
    if (
      !Number.isSafeInteger(size) ||
      size < (view.getUint32(0) === 1 ? 16 : 8) ||
      offset + size > file.size
    )
      break;
    if (type === "moov") initialized = true;
    if (type === "moof") fragment = initialized;
    if (type === "mdat" && fragment) {
      complete = offset + size;
      fragment = false;
    }
    offset += size;
  }
  return complete;
}

/** Remux complete packets into a seekable MP4; no second video encode. */
export async function finishVideo(recording: StoredVideo): Promise<StoredVideo> {
  const directory = await videoDirectory(recording.recording_id);
  const journal = await (await directory.getFileHandle("fragments.mp4")).getFile();
  const length = await completeFragmentLength(journal);
  if (!length) throw new Error("No complete video fragment was preserved");
  const input = new Input({ source: new BlobSource(journal.slice(0, length)), formats: [MP4] });
  let destination: SyncFile | undefined;
  try {
    const track = await input.getPrimaryVideoTrack();
    const config = await track?.getDecoderConfig();
    if (!track || !config || (await track.getCodec()) !== "avc")
      throw new Error("The recording has no playable H.264 track");
    destination = await syncFile(await directory.getFileHandle("video.mp4", { create: true }));
    const output = new Output({
      // The durable journal remains until this file and its metadata are committed.
      target: fileTarget(destination, VIDEO_MAX_BYTES, false),
      format: new Mp4OutputFormat({ fastStart: "reserve" }),
    });
    const source = new EncodedVideoPacketSource("avc");
    output.addVideoTrack(source, {
      maximumPacketCount:
        Math.ceil((recording.max_duration_ms / 1000) * VIDEO_PRESETS[recording.quality].fps) + 4,
    });
    await output.start();
    let frames = 0;
    let duration = 0;
    try {
      for await (const packet of new EncodedPacketSink(track).packets()) {
        await source.add(packet, frames === 0 ? { decoderConfig: config } : undefined);
        frames++;
        duration = Math.max(duration, packet.timestamp + packet.duration);
      }
      if (!frames || !Number.isFinite(duration) || duration <= 0)
        throw new Error("The recording contains no playable frames");
      source.close();
      await output.finalize();
    } catch (error) {
      await output.cancel().catch(() => {});
      throw error;
    }
    destination.flush();
    destination.close();
    destination = undefined;
    const file = await (await directory.getFileHandle("video.mp4")).getFile();
    const result: StoredVideo = {
      ...recording,
      state: "ready",
      frames,
      duration_ms: Math.round(duration * 1000),
      byte_size: file.size,
      completeness: completeStop(recording.stop_reason ?? "browser_restarted")
        ? "complete"
        : "partial",
    };
    await new VideoArtifactStore().put(result);
    // Commit metadata before discarding the recovery journal.
    await directory.removeEntry("fragments.mp4").catch(() => {});
    return result;
  } finally {
    destination?.close();
    input.dispose();
  }
}

export class VideoEncoderPipeline {
  private encoder!: VideoEncoder;
  private canvas!: OffscreenCanvas;
  private context!: OffscreenCanvasRenderingContext2D;
  private output!: Output;
  private source = new EncodedVideoPacketSource("avc");
  private file?: SyncFile;
  private readonly store = new VideoArtifactStore();
  private readonly timeline: VideoTimeline;
  private readonly durations = new Map<number, number>();
  private writes = Promise.resolve();
  private operations = Promise.resolve();
  private stopping?: Promise<StoredVideo>;
  private timer?: ReturnType<typeof setInterval>;
  private deadline?: ReturnType<typeof setTimeout>;
  private origin = 0;
  private failure?: Error;
  private waiting = false;
  private navigationPending = false;
  private suspensionVersion = 0;
  private started = false;
  private heartbeatPending = false;

  constructor(
    private recording: StoredVideo,
    private readonly finished: (recording: StoredVideo) => void,
  ) {
    this.timeline = new VideoTimeline(
      VIDEO_PRESETS[recording.quality].fps,
      recording.max_duration_ms,
    );
  }

  async start(image: string): Promise<StoredVideo> {
    const bitmap = await decodeImage(image);
    const preset = VIDEO_PRESETS[this.recording.quality];
    const size = videoDimensions(bitmap.width, bitmap.height, preset.maxDimension);
    try {
      if (typeof VideoEncoder === "undefined")
        throw new VideoError({
          code: "unsupported",
          message: "This browser does not support video encoding",
        });
      // Baseline AVC, level 4.2, AVCC packets for an MP4 container. Test the exact
      // dimensions rather than treating API presence as codec availability.
      const config: VideoEncoderConfig = {
        codec: "avc1.42002a",
        ...size,
        bitrate: preset.bitrate,
        framerate: preset.fps,
        latencyMode: "realtime",
        avc: { format: "avc" },
      };
      const support = await VideoEncoder.isConfigSupported(config);
      if (!support.supported)
        throw new VideoError({
          code: "unsupported",
          message: "This browser cannot encode H.264 at the requested quality",
        });
      this.canvas = new OffscreenCanvas(size.width, size.height);
      const context = this.canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("The browser could not prepare the video canvas");
      this.context = context;
      this.draw(bitmap);
      const directory = await videoDirectory(this.recording.recording_id, true);
      this.file = await syncFile(await directory.getFileHandle("fragments.mp4", { create: true }));
      this.output = new Output({
        target: fileTarget(this.file, VIDEO_MAX_BYTES - 1024 * 1024),
        format: new Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 1 }),
      });
      this.output.addVideoTrack(this.source);
      await this.output.start();
      this.encoder = new VideoEncoder({
        output: (chunk, metadata) => {
          const duration = this.durations.get(chunk.timestamp);
          this.durations.delete(chunk.timestamp);
          const packet = EncodedPacket.fromEncodedChunk(chunk).clone({
            duration: (duration ?? chunk.duration ?? 1) / 1_000_000,
          });
          this.writes = this.writes
            .then(async () => {
              if (!this.failure) await this.source.add(packet, metadata);
            })
            .catch((error) => this.fail(error));
        },
        error: (error) => this.fail(error),
      });
      this.encoder.configure(support.config ?? config);
      this.origin = performance.now();
      this.encode(1000 / preset.fps);
      await this.encoder.flush();
      await this.writes;
      if (this.failure) throw this.failure;
      this.recording = { ...this.recording, ...size, state: "recording", started_at: Date.now() };
      await this.store.put(this.recording);
      if (this.failure) throw this.failure;
      this.started = true;
      this.timer = setInterval(() => {
        if (this.heartbeatPending) return;
        this.heartbeatPending = true;
        void this.enqueue(async () => {
          this.encode(performance.now() - this.origin);
          await this.writes;
        })
          .catch((error) => this.fail(error))
          .finally(() => {
            this.heartbeatPending = false;
          });
      }, 1000);
      this.deadline = setTimeout(() => {
        void this.stop("duration_limit").catch(() => {});
      }, this.recording.max_duration_ms);
      return this.recording;
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      bitmap.close();
    }
  }

  private draw(bitmap: ImageBitmap): void {
    const scale = Math.min(this.canvas.width / bitmap.width, this.canvas.height / bitmap.height);
    this.context.fillStyle = "#000";
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.drawImage(
      bitmap,
      (this.canvas.width - bitmap.width * scale) / 2,
      (this.canvas.height - bitmap.height * scale) / 2,
      bitmap.width * scale,
      bitmap.height * scale,
    );
  }

  frame(image: string, elapsedMs: number): Promise<void> {
    const version = this.suspensionVersion;
    return this.enqueue(async () => {
      if (this.waiting) return;
      const bitmap = await decodeImage(image);
      try {
        this.encode(Math.min(elapsedMs, performance.now() - this.origin));
        this.draw(bitmap);
        if (version === this.suspensionVersion) this.navigationPending = false;
        await this.writes;
      } finally {
        bitmap.close();
      }
    });
  }

  suspend(mode: VideoSuspension, label: string): Promise<void> {
    this.suspensionVersion++;
    // A navigation remains incomplete until its first clean frame is installed.
    if (mode !== "clean") this.navigationPending = mode === "navigation";
    return this.enqueue(async () => {
      this.encode(performance.now() - this.origin);
      this.waiting = mode !== "clean";
      if (mode === "interactive") {
        this.context.fillStyle = "#202124";
        this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
        this.context.fillStyle = "#fff";
        this.context.font = `${Math.max(16, Math.round(this.canvas.width / 45))}px sans-serif`;
        this.context.textAlign = "center";
        this.context.fillText(
          label,
          this.canvas.width / 2,
          this.canvas.height / 2,
          this.canvas.width * 0.9,
        );
      }
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const result = this.operations.then(operation);
    this.operations = result.catch((error) => this.fail(error));
    return result;
  }

  private encode(elapsedMs: number, final = false): void {
    if (this.failure) return;
    if (!final && this.encoder.encodeQueueSize > 2) {
      this.recording.dropped_frames++;
      return;
    }
    const sample = this.timeline.advance(elapsedMs, final);
    if (!sample) return;
    const frame = new VideoFrame(this.canvas, sample);
    try {
      this.durations.set(sample.timestamp, sample.duration);
      this.encoder.encode(frame, { keyFrame: sample.keyFrame });
      this.recording.frames++;
    } finally {
      frame.close();
    }
  }

  private fail(error: unknown): void {
    this.failure ??= error instanceof Error ? error : new Error(String(error));
    // start() owns startup compensation. Finalizing concurrently with its
    // catch path could close the journal while the first packet is written.
    if (!this.started) return;
    const reason = this.failure.message === "video_size_limit" ? "size_limit" : "encoding_failed";
    // Do not await finalization from an encoder callback or its own writer chain.
    queueMicrotask(() => {
      void this.stop(reason).catch(() => {});
    });
  }

  stop(reason: VideoStopReason): Promise<StoredVideo> {
    this.stopping ??= this.finalize(reason).finally(() => this.finished(this.recording));
    return this.stopping;
  }

  private async finalize(reason: VideoStopReason): Promise<StoredVideo> {
    if (this.navigationPending && completeStop(reason)) reason = "capture_failed";
    clearInterval(this.timer);
    clearTimeout(this.deadline);
    this.recording = { ...this.recording, state: "finalizing", stop_reason: reason };
    try {
      await this.store.put(this.recording);
      await this.operations;
      this.encode(
        reason === "duration_limit"
          ? this.recording.max_duration_ms
          : performance.now() - this.origin,
        true,
      );
      if (this.encoder.state === "configured") await this.encoder.flush();
      await this.writes;
      if (!this.failure) {
        this.source.close();
        await this.output.finalize();
      }
    } catch (error) {
      this.failure ??= error instanceof Error ? error : new Error(String(error));
    } finally {
      await this.close().catch((error: unknown) => {
        this.failure ??= error instanceof Error ? error : new Error(String(error));
      });
    }
    try {
      if (this.failure && reason !== "size_limit") {
        this.recording.stop_reason = "encoding_failed";
        this.recording.error = this.failure.message;
      }
      this.recording = await finishVideo(this.recording);
    } catch (error) {
      this.recording = {
        ...this.recording,
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      await this.store.put(this.recording);
    }
    return this.recording;
  }

  private async close(): Promise<void> {
    clearInterval(this.timer);
    clearTimeout(this.deadline);
    if (this.encoder && this.encoder.state !== "closed") this.encoder.close();
    if (this.output && this.output.state !== "finalized")
      await this.output.cancel().catch(() => {});
    const file = this.file;
    this.file = undefined;
    file?.close();
  }
}
