import {
  type ScreencastFrame,
  type ScreencastLease,
  screencasts,
} from "@/browser-driver/screencast-coordinator";
import { isAgentControlledTab, type SessionManager } from "@/session-manager/manager";
import { hasActiveRecording } from "@/tools/record";
import {
  type CdpRunner,
  type ChromeTabsApi,
  enforceAgentWindow,
  enforceCdpAccessibleTarget,
  isRpcError,
  lookupSession,
  resolveTargetTab,
} from "@/tools/shared";
import { captureReply } from "./capture-deadline";
import type { VideoHost } from "./host-protocol";
import { VideoArtifactStore } from "./store";
import { FrameClock } from "./timeline";
import {
  publicVideo,
  type StoredVideo,
  VIDEO_CHUNK_BYTES,
  VIDEO_PRESETS,
  VIDEO_RETENTION_MS,
  VIDEO_VERSION,
  type VideoGrant,
  type VideoParams,
  type VideoStartOptions,
  type VideoStopReason,
  type VideoTask,
  validateVideoStart,
} from "./types";

interface ActiveVideo {
  value: StoredVideo;
  lease?: ScreencastLease;
  starting?: Promise<VideoGrant>;
  stopping?: Promise<StoredVideo>;
  releasing?: Promise<void>;
  stopReason?: VideoStopReason;
  suspended: boolean;
  documentId?: string;
  epoch: number;
  pending?: ScreencastFrame;
  pumping: boolean;
  clock: FrameClock;
  origin: number;
  cleanAfter?: number;
  capture: AbortController;
}

export interface VideoManagerDeps {
  sessions: SessionManager;
  cdp: CdpRunner;
  tabs: ChromeTabsApi;
  host: VideoHost;
  owner(): string;
  store?: VideoArtifactStore;
  overlay(tabId: number, recordingId: string | null): Promise<{ interactive?: boolean }>;
  changed?(): void;
}

/** Owns capture and authorization; the worker alone owns encoding and file writes. */
export class VideoManager {
  private readonly store: VideoArtifactStore;
  private active?: ActiveVideo;
  private starting = false;
  private startingSession?: string;
  private readonly actionStarts = new Set<string>();
  private readonly ready: Promise<void>;

  constructor(private readonly deps: VideoManagerDeps) {
    this.store = deps.store ?? new VideoArtifactStore();
    this.ready = this.recover();
    // Other extension features remain usable if video storage cannot open.
    // Video callers still observe the original rejection through `ready`.
    void this.ready.catch((error) => console.warn("Video recovery unavailable", error));
  }

  private async recover(): Promise<void> {
    await this.store.prepare();
    for (const value of await this.store.list()) {
      if (!["ready", "failed"].includes(value.state)) {
        try {
          await this.deps.host.request({ action: "recover", recording_id: value.recording_id });
        } catch (error) {
          await this.store.put({
            ...value,
            state: "failed",
            stop_reason: "browser_restarted",
            completeness: "partial",
            error: String(error),
          });
        }
      }
    }
    this.deps.changed?.();
    await this.deps.host.closeWhenIdle();
  }

  isRecording(sessionId?: string): boolean {
    return (
      (!!this.active && (!sessionId || this.active.value.session_id === sessionId)) ||
      (!!this.startingSession && (!sessionId || this.startingSession === sessionId))
    );
  }

  reserveActionRecording(sessionId: string): (() => void) | undefined {
    if (this.isRecording(sessionId)) return;
    this.actionStarts.add(sessionId);
    return () => {
      this.actionStarts.delete(sessionId);
    };
  }

  private progress(value: StoredVideo): StoredVideo {
    if (value.state !== "recording" || value.recording_id !== this.active?.value.recording_id)
      return value;
    return {
      ...value,
      duration_ms: Math.max(
        0,
        Math.min(value.max_duration_ms, Date.now() - (value.started_at ?? Date.now())),
      ),
    };
  }

  async tasks(): Promise<VideoTask[]> {
    return Promise.all(
      this.deps.sessions.list().map(async (session) => ({
        session_id: session.sessionId,
        tabs: (await this.deps.tabs.query({ windowId: session.agentWindowId }))
          .filter((tab) => tab.id !== undefined && isAgentControlledTab(session, tab.id))
          .map((tab) => ({
            id: tab.id!,
            title: tab.title ?? "",
            url: tab.url ?? "",
            active: tab.active,
          })),
      })),
    );
  }

  async list(owner?: string): Promise<StoredVideo[]> {
    await this.ready;
    await this.store.prepare(this.active?.value.recording_id);
    return (await this.store.list())
      .filter((value) => owner === undefined || value.owner === owner)
      .map((value) => this.progress(value))
      .sort((a, b) => b.created_at - a.created_at);
  }

  async get(id: string, auth?: { owner: string; capability: string }): Promise<StoredVideo> {
    await this.ready;
    const value = await this.store.get(id);
    if (
      !value ||
      value.expires_at <= Date.now() ||
      (auth && (value.owner !== auth.owner || value.capability !== auth.capability))
    )
      throw new Error("Recording unavailable or access denied");
    return this.progress(value);
  }

  async start(options: VideoStartOptions, signal?: AbortSignal): Promise<VideoGrant> {
    const invalid = validateVideoStart(options);
    if (invalid) throw new Error(invalid);
    const owner = this.deps.owner();
    await this.ready;
    const existing = (await this.store.list()).find(
      (value) =>
        value.owner === owner &&
        value.request_id === options.request_id &&
        value.expires_at > Date.now(),
    );
    if (existing) {
      if (this.active?.value.recording_id === existing.recording_id && this.active.starting)
        return this.active.starting;
      return { recording: publicVideo(existing), capability: existing.capability };
    }
    if (this.starting || this.active)
      throw new Error("A video is already recording or being finalized");
    this.starting = true;
    this.startingSession = options.session_id;
    try {
      const context = lookupSession(this.deps.sessions, options, "video");
      if (isRpcError(context)) throw new Error(context.message);
      if (this.actionStarts.has(context.sessionId) || hasActiveRecording(context.sessionId))
        throw new Error("Stop action recording before starting a video");
      const target = await resolveTargetTab(
        this.deps.sessions,
        context,
        options.tab_id,
        this.deps.tabs,
      );
      if (isRpcError(target)) throw new Error(target.message);
      const denied =
        enforceAgentWindow(context, target, "video") ?? enforceCdpAccessibleTarget(target, "video");
      if (denied) throw new Error(denied.message);
      if (!isAgentControlledTab(context, target.tabId))
        throw new Error("Video requires a task-created or borrowed tab");
      await this.store.reserve();
      const tab = await this.deps.tabs.get(target.tabId);
      const value: StoredVideo = {
        recording_id: `vid_${crypto.randomUUID().replaceAll("-", "")}`,
        capability: crypto.randomUUID() + crypto.randomUUID(),
        owner,
        request_id: options.request_id,
        session_id: context.sessionId,
        tab_id: target.tabId,
        title: tab.title ?? "Video",
        state: "starting",
        quality: options.quality ?? "standard",
        created_at: Date.now(),
        expires_at: Date.now() + VIDEO_RETENTION_MS,
        max_duration_ms: options.max_duration_ms ?? 60_000,
        duration_ms: 0,
        byte_size: 0,
        width: 0,
        height: 0,
        frames: 0,
        dropped_frames: 0,
        exported: false,
      };
      const active: ActiveVideo = {
        value,
        suspended: true,
        epoch: 0,
        pumping: false,
        clock: new FrameClock(),
        origin: performance.now(),
        capture: new AbortController(),
      };
      this.active = active;
      active.starting = this.begin(active, signal);
      return await active.starting;
    } finally {
      this.starting = false;
      this.startingSession = undefined;
      this.deps.changed?.();
    }
  }

  private async begin(active: ActiveVideo, callerSignal?: AbortSignal): Promise<VideoGrant> {
    const { cdp, host } = this.deps;
    const { tab_id: tab, session_id: session } = active.value;
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, active.capture.signal])
      : active.capture.signal;
    const check = () => {
      if (
        signal?.aborted ||
        active.stopReason ||
        this.active !== active ||
        active.releasing ||
        !this.deps.sessions.has(session) ||
        this.deps.owner() !== active.value.owner
      )
        throw new Error("Video start cancelled");
    };
    try {
      await this.store.put(active.value);
      check();
      const overlay = await captureReply(this.deps.overlay(tab, active.value.recording_id), signal);
      if (overlay.interactive)
        throw new Error("Finish the current browser confirmation before starting a video");
      check();
      await captureReply(cdp.send(tab, "Page.enable"), signal);
      cdp.trackSessionTab?.(session, tab);
      if (cdp.acquireBackgroundExecution)
        await captureReply(cdp.acquireBackgroundExecution(session, tab), signal);
      const first = await captureReply(
        cdp.send<{ data: string }>(tab, "Page.captureScreenshot", {
          format: "jpeg",
          quality: 80,
        }),
        signal,
      );
      check();
      active.value = await host.request<StoredVideo>({
        action: "start",
        recording: active.value,
        image: first.data,
      });
      active.origin = performance.now();
      check();
      active.suspended = false;
      const size = VIDEO_PRESETS[active.value.quality].maxDimension;
      const lease = await screencasts(cdp).acquire(
        tab,
        {
          format: "jpeg",
          quality: 80,
          maxWidth: size,
          maxHeight: size,
          frame: (frame) => this.receive(active, frame),
        },
        signal,
      );
      // A short duration cap can finish while CDP is still starting. Cleanup
      // may already have run without this lease; do not leave a late stream on.
      if (active.releasing || this.active !== active) {
        await lease.release().catch(() => {});
        throw new Error("Video stopped during capture startup; check recent recordings");
      }
      active.lease = lease;
      check();
      this.deps.changed?.();
      return { recording: publicVideo(active.value), capability: active.value.capability };
    } catch (error) {
      const stopped = await host
        .request<StoredVideo | undefined>({
          action: "stop",
          recording_id: active.value.recording_id,
          reason: active.stopReason ?? "capture_failed",
        })
        .catch(() => undefined);
      try {
        if (!stopped || !["ready", "failed"].includes(stopped.state))
          await this.store.put({
            ...active.value,
            state: "failed",
            completeness: "partial",
            stop_reason: active.stopReason ?? "capture_failed",
            error: error instanceof Error ? error.message : String(error),
          });
      } finally {
        await this.release(active);
      }
      throw error;
    }
  }

  private receive(active: ActiveVideo, frame: ScreencastFrame): void {
    if (this.active !== active || active.suspended || active.stopReason) return;
    if (active.cleanAfter !== undefined && (frame.metadata.timestamp ?? 0) < active.cleanAfter)
      return;
    // Retain at most one frame in flight and one latest frame. CDP ACK never
    // waits for the encoder, so another screencast consumer cannot be starved.
    active.pending = frame;
    if (active.pumping) return;
    active.pumping = true;
    void (async () => {
      while (active.pending && !active.suspended && !active.stopReason) {
        const next = active.pending;
        active.pending = undefined;
        await this.deps.host.request({
          action: "frame",
          recording_id: active.value.recording_id,
          image: next.data,
          elapsed_ms: active.clock.elapsed(
            next.metadata.timestamp,
            performance.now() - active.origin,
          ),
        });
      }
    })()
      .catch(() => this.stop(active.value.recording_id, "capture_failed").catch(() => {}))
      .finally(() => {
        active.pumping = false;
      });
  }

  async stop(id: string, reason: VideoStopReason = "user_stopped"): Promise<StoredVideo> {
    const active = this.active;
    if (!active || active.value.recording_id !== id) return this.get(id);
    active.stopReason ??= reason;
    active.capture.abort(new Error("Video capture cancelled"));
    active.pending = undefined;
    active.stopping ??= (async () => {
      await active.starting?.catch(() => {});
      try {
        return await this.deps.host.request<StoredVideo>({
          action: "stop",
          recording_id: id,
          reason: active.stopReason!,
        });
      } finally {
        await this.release(active);
      }
    })();
    return active.stopping;
  }

  async stopSession(id: string, reason: VideoStopReason = "session_ended"): Promise<void> {
    if (this.active?.value.session_id === id)
      await this.stop(this.active.value.recording_id, reason);
  }

  async stopTab(tab: number, reason: VideoStopReason): Promise<void> {
    if (this.active?.value.tab_id === tab) await this.stop(this.active.value.recording_id, reason);
  }

  async disconnect(): Promise<void> {
    if (this.active) await this.stop(this.active.value.recording_id, "disconnected");
  }

  sync(): void {
    const value = this.active?.value;
    const session = value && this.deps.sessions.get(value.session_id);
    if (value && (!session || !isAgentControlledTab(session, value.tab_id)))
      void this.stop(value.recording_id, "session_ended").catch(() => {});
  }

  async finished(id: string): Promise<void> {
    const active = this.active;
    if (active?.value.recording_id === id) await this.release(active);
    this.deps.changed?.();
  }

  private release(active: ActiveVideo): Promise<void> {
    active.releasing ??= this.cleanup(active);
    return active.releasing;
  }

  private async cleanup(active: ActiveVideo): Promise<void> {
    active.capture.abort(new Error("Video capture cancelled"));
    active.suspended = true;
    active.pending = undefined;
    await active.lease?.release().catch(() => {});
    active.lease = undefined;
    await this.deps.overlay(active.value.tab_id, null).catch(() => {});
    if (this.active === active) this.active = undefined;
    this.deps.changed?.();
    await this.deps.host.closeWhenIdle().catch(() => {});
  }

  /** Block intake synchronously before an overlay can paint or navigation commits. */
  async suspend(tab: number, waiting: boolean, documentId?: string): Promise<string | null> {
    const active = this.active;
    if (!active || active.value.tab_id !== tab || active.stopReason) return null;
    if (documentId && !waiting && active.documentId && active.documentId !== documentId)
      return null;
    if (documentId) active.documentId = documentId;
    const epoch = ++active.epoch;
    active.suspended = true;
    active.pending = undefined;
    if (active.value.state === "starting") {
      // The first screenshot must also be clean. A confirmation or navigation
      // racing startup cancels it; acknowledge only after startup compensation
      // removes the overlay lease and closes the encoder.
      active.stopReason ??= "capture_failed";
      active.capture.abort(new Error("Video capture cancelled"));
      await active.starting?.catch(() => {});
      return null;
    }
    if (active.value.state === "recording") {
      await this.deps.host.request({
        action: "suspend",
        recording_id: active.value.recording_id,
        waiting,
        label: "Waiting for user",
      });
      if (!waiting && epoch === active.epoch) {
        // A fresh screenshot replaces any buffered screencast frame from before
        // the overlay was removed. Content confirms two clean animation frames.
        const first = await captureReply(
          this.deps.cdp.send<{ data: string }>(tab, "Page.captureScreenshot", {
            format: "jpeg",
            quality: 80,
          }),
          active.capture.signal,
        );
        if (epoch === active.epoch) {
          await this.deps.host.request({
            action: "frame",
            recording_id: active.value.recording_id,
            image: first.data,
            elapsed_ms: active.clock.elapsed(undefined, performance.now() - active.origin),
          });
          active.cleanAfter = Date.now() / 1000;
          active.suspended = false;
        }
      }
    }
    return active.value.recording_id;
  }

  overlayId(tab: number): string | null {
    return this.active?.value.tab_id === tab ? this.active.value.recording_id : null;
  }

  async discard(id: string): Promise<void> {
    const value = await this.get(id);
    if (!["ready", "failed"].includes(value.state))
      throw new Error("Stop the recording before deleting it");
    await this.store.remove(id);
    this.deps.changed?.();
  }

  async exported(id: string): Promise<void> {
    const value = await this.get(id);
    if (value.state !== "ready") throw new Error("Video is not ready to save");
    await this.store.put({ ...value, exported: true });
    this.deps.changed?.();
  }

  async rpc(params: VideoParams, signal?: AbortSignal): Promise<unknown> {
    const owner = this.deps.owner();
    if (params.action === "capabilities")
      return { version: VIDEO_VERSION, format: "mp4", audio: false, max_duration_ms: 600_000 };
    if (params.action === "start") return this.start(params, signal);
    if (params.action === "list")
      return {
        recordings: (await this.list(owner)).map((value) => ({
          recording: publicVideo(value),
          capability: value.capability,
        })),
      };
    const value = await this.get(params.recording_id, { owner, capability: params.capability });
    if (params.action === "status") return { recording: publicVideo(value) };
    if (params.action === "stop")
      return { recording: publicVideo(await this.stop(value.recording_id)) };
    if (params.action === "discard") {
      await this.discard(value.recording_id);
      return { discarded: true };
    }
    if (params.action === "exported") {
      await this.exported(value.recording_id);
      return { exported: true };
    }
    if (params.action !== "read") throw new Error("Unsupported video action");
    if (value.state !== "ready") throw new Error("Video is not ready to save");
    const offset = params.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.byte_size)
      throw new Error("Invalid video offset");
    const file = await this.store.file(value.recording_id);
    if (file.size !== value.byte_size) throw new Error("Video artifact size changed");
    const bytes = new Uint8Array(
      await file.slice(offset, offset + VIDEO_CHUNK_BYTES).arrayBuffer(),
    );
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return {
      recording_id: value.recording_id,
      offset,
      byte_size: file.size,
      data_base64: btoa(binary),
      next_offset: offset + bytes.length,
    };
  }
}
