/**
 * ObservationService: per-owned-session live observation state for the PiP
 * overlay — current action, page url, and a breathing thumbnail carried by
 * attachment reference. Strict ownership boundary applies throughout: only
 * sessions in the plugin's SessionRegistry (owned by construction) ever get
 * an observation entry, and interrupt/kill paths can only reach children this
 * plugin spawned.
 *
 * Observation traffic isolation: thumbnail captures run through the runner
 * directly (never through the tool-level instrumentation), emit no action
 * events, and never move the registry's current pointer.
 */

import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { KeyedExecutor } from "./queue";
import type { BskRunner } from "./runner";
import type { SessionRegistry } from "./sessions";

/** One owned session's live observation record (wire-stable shape). */
export interface SessionObservation {
  sessionId: string;
  /** Last settled page URL, when any navigation completed. */
  url?: string;
  /** Current action ('idle' when nothing is in flight). */
  action: string;
  /** Epoch ms when the current action started (elapsed time is client-side). */
  since: number;
  /** Latest thumbnail, by attachment-store reference (never bytes on the wire). */
  thumbnailAttachmentId?: string;
  /** Summary of the most recent failed action (drives the red status dot). */
  lastError?: string;
  /**
   * The daemon reports this session as gone (e.g. daemon restart): the strip
   * greys it out until it is stopped/removed. No more frames are requested.
   */
  dead?: boolean;
}

/** Incremental event carried to subscribers (SSE on the wire). */
export type ObservationEvent =
  | { type: "upsert" | "remove" | "reset"; session?: SessionObservation }
  | { type: "availability"; available: boolean };

export interface ObservationOptions {
  enabled: boolean;
  /** Fast cadence while a session is active or recently was. */
  thumbnailIntervalMs: number;
  /** Slow cadence for idle sessions; also the "recently active" window. */
  idleIntervalMs: number;
}

/** Structural view of the optional attachment seam (absent in headless compositions). */
interface AttachmentLike {
  saveImage(input: {
    data: Uint8Array;
    mediaType: string;
    name?: string;
  }): Promise<ImageAttachmentRefLike>;
  readImage(
    ref: ImageAttachmentRefLike,
  ): Promise<{ data: Uint8Array; attachment: ImageAttachmentRefLike }>;
}

/** The attachment reference fields the store verifies reads against. */
export interface ImageAttachmentRefLike {
  attachmentId: unknown;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
}

/** Injectable clock/scheduler bits for tests. */
export interface ObservationScheduler {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
}

const DEFAULT_SCHEDULER: ObservationScheduler = {
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    // Never hold the event loop open for a frame refresh.
    if (typeof timer === "object" && typeof timer.unref === "function") timer.unref();
    return timer;
  },
  clearTimeout: (h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]),
  now: () => Date.now(),
};

/** Max consecutive capture failures before a session drops to the idle cadence. */
const FAILURE_BACKOFF_THRESHOLD = 3;

export class ObservationService {
  private readonly observations = new Map<string, SessionObservation>();
  private readonly listeners = new Set<(event: ObservationEvent) => void>();
  private readonly captureTimers = new Map<string, unknown>();
  private readonly captureInFlight = new Set<string>();
  private readonly captureFailures = new Map<string, number>();
  private readonly lastActivity = new Map<string, number>();
  /** attachmentId → full reference (the store requires it for verified reads). */
  private readonly thumbRefs = new Map<string, ImageAttachmentRefLike>();
  /** Consecutive capture failures across ALL sessions (daemon-level signal). */
  private globalFailures = 0;
  private available = true;
  private disposed = false;

  constructor(
    private readonly deps: {
      ctx: Context;
      runner: BskRunner;
      registry: SessionRegistry;
      queue: KeyedExecutor;
      options: ObservationOptions;
      scheduler?: ObservationScheduler;
    },
  ) {}

  private get scheduler(): ObservationScheduler {
    return this.deps.scheduler ?? DEFAULT_SCHEDULER;
  }

  /** All current entries (client initial/resync snapshot). */
  getState(): SessionObservation[] {
    return [...this.observations.values()].map((entry) => ({ ...entry }));
  }

  /** Whether the browser side looks reachable (drives the "browser unavailable" state). */
  isAvailable(): boolean {
    return this.available;
  }

  private setAvailable(available: boolean): void {
    if (this.available === available) return;
    this.available = available;
    this.emit({ type: "availability", available });
  }

  /** Subscribe to incremental changes; returns an unsubscribe function. */
  subscribe(listener: (event: ObservationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ObservationEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A faulty subscriber must not starve the others.
      }
    }
  }

  private put(entry: SessionObservation): void {
    this.observations.set(entry.sessionId, entry);
    this.emit({ type: "upsert", session: { ...entry } });
  }

  /** Register a fresh owned session (called from browser_session_start). */
  addSession(sessionId: string, url?: string): void {
    if (!this.deps.options.enabled || this.disposed) return;
    this.put({
      sessionId,
      ...(url !== undefined ? { url } : {}),
      action: "idle",
      since: this.scheduler.now(),
    });
    this.lastActivity.set(sessionId, this.scheduler.now());
    this.scheduleCapture(sessionId, 0);
  }

  /** Drop a session (called from browser_session_stop). */
  removeSession(sessionId: string): void {
    this.cancelCapture(sessionId);
    this.captureFailures.delete(sessionId);
    this.lastActivity.delete(sessionId);
    if (this.observations.delete(sessionId)) {
      this.emit({
        type: "remove",
        session: { sessionId, action: "idle", since: this.scheduler.now() },
      });
    }
  }

  /** Mark an action starting on a session (tool entry instrumentation). */
  beginAction(sessionId: string, action: string): void {
    if (!this.deps.options.enabled || this.disposed) return;
    const entry = this.observations.get(sessionId);
    if (entry === undefined || entry.dead === true) return;
    const now = this.scheduler.now();
    this.lastActivity.set(sessionId, now);
    // A fresh action clears the previous error marker (red dot means "last action failed").
    const next: SessionObservation = { ...entry, action, since: now };
    delete next.lastError;
    this.put(next);
  }

  /**
   * Mark the current action settling (tool exit instrumentation). Triggers an
   * immediate thumbnail refresh — action-driven first, timer as fallback.
   */
  endAction(sessionId: string, error?: string): void {
    if (!this.deps.options.enabled || this.disposed) return;
    const entry = this.observations.get(sessionId);
    if (entry === undefined || entry.dead === true) return;
    const now = this.scheduler.now();
    this.lastActivity.set(sessionId, now);
    const next: SessionObservation = { ...entry, action: "idle", since: now };
    if (error !== undefined) next.lastError = error;
    else delete next.lastError;
    this.put(next);
    this.scheduleCapture(sessionId, 0);
  }

  /** Record the settled page URL (navigate success / start with url). */
  setUrl(sessionId: string, url: string): void {
    if (!this.deps.options.enabled || this.disposed) return;
    const entry = this.observations.get(sessionId);
    if (entry === undefined) return;
    this.put({ ...entry, url });
  }

  /**
   * Interrupt the in-flight call of one session (default: the registry's
   * current). Kills exactly the bsk children this plugin spawned for that
   * session — same user-visible semantics as the chat Stop button (the in-flight
   * tool call fails; the agent flow may continue).
   * @returns whether an in-flight call was actually interrupted.
   */
  interrupt(sessionId?: string): boolean {
    const target = sessionId ?? this.deps.registry.current();
    if (target === undefined || !this.deps.registry.isOwned(target)) return false;
    return this.deps.runner.killFor(target) > 0;
  }

  /**
   * Read one captured thumbnail back through the store's verified path.
   * Powers the plugin's own HTTP thumbnail route — frames are plugin-owned
   * runtime data, never referenced by any session log, so the
   * session-authorized client RPC cannot serve them.
   */
  async readThumbnail(
    attachmentId: string,
  ): Promise<{ data: Uint8Array; mediaType: string } | undefined> {
    const ref = this.thumbRefs.get(attachmentId);
    if (ref === undefined) return undefined;
    const attachments = this.deps.ctx.get("attachments") as AttachmentLike | undefined;
    if (attachments === undefined) return undefined;
    try {
      const stored = await attachments.readImage(ref);
      return { data: stored.data, mediaType: ref.mediaType };
    } catch {
      return undefined;
    }
  }

  /** Tear down all state and timers (plugin dispose). */
  dispose(): void {
    this.disposed = true;
    for (const sessionId of [...this.captureTimers.keys()]) this.cancelCapture(sessionId);
    this.captureTimers.clear();
    this.captureInFlight.clear();
    this.captureFailures.clear();
    this.lastActivity.clear();
    this.thumbRefs.clear();
    this.observations.clear();
    this.emit({ type: "reset" });
    this.listeners.clear();
  }

  // ------------------------------------------------------------------
  // Thumbnail loop
  // ------------------------------------------------------------------

  private cancelCapture(sessionId: string): void {
    const timer = this.captureTimers.get(sessionId);
    if (timer !== undefined) {
      this.scheduler.clearTimeout(timer);
      this.captureTimers.delete(sessionId);
    }
  }

  /** Schedule the next capture for a session; `delayMs` 0 means "as soon as the event loop allows". */
  private scheduleCapture(sessionId: string, delayMs?: number): void {
    if (!this.deps.options.enabled || this.disposed) return;
    const entry = this.observations.get(sessionId);
    if (entry === undefined || entry.dead === true) return;
    this.cancelCapture(sessionId);
    const now = this.scheduler.now();
    const lastSeen = this.lastActivity.get(sessionId) ?? 0;
    const failures = this.captureFailures.get(sessionId) ?? 0;
    const { thumbnailIntervalMs, idleIntervalMs } = this.deps.options;
    const cadence =
      now - lastSeen < idleIntervalMs && failures < FAILURE_BACKOFF_THRESHOLD
        ? thumbnailIntervalMs
        : idleIntervalMs;
    const delay = delayMs ?? cadence;
    const timer = this.scheduler.setTimeout(() => {
      this.captureTimers.delete(sessionId);
      void this.capture(sessionId);
    }, delay);
    this.captureTimers.set(sessionId, timer);
  }

  /**
   * Capture one frame: `bsk screenshot --json` through the runner, bytes into
   * the attachment store, reference onto the observation. Runs OUTSIDE the
   * tool instrumentation on purpose — no action events, no registry writes.
   * Failures keep the previous frame and back off silently.
   */
  private async capture(sessionId: string): Promise<void> {
    if (this.disposed) return;
    const current = this.observations.get(sessionId);
    if (current === undefined || current.dead === true) return;
    if (this.captureInFlight.has(sessionId)) return;
    const attachments = this.deps.ctx.get("attachments") as AttachmentLike | undefined;
    if (attachments === undefined) {
      // No attachment store (headless composition): thumbnails stay absent.
      return;
    }
    this.captureInFlight.add(sessionId);
    try {
      const outPath = join(tmpdir(), `bsk-obs-${sessionId}-${this.scheduler.now()}.png`);
      const result = await this.deps.queue.run(sessionId, () =>
        this.deps.runner.run(["screenshot", "--session", sessionId, "--out", outPath], {
          timeoutMs: 15_000,
          tag: `observation:${sessionId}`,
        }),
      );
      if (result.code !== 0) {
        let code: string | undefined;
        try {
          code = (JSON.parse(result.stdout) as { code?: string }).code;
        } catch {
          code = undefined;
        }
        if (code === "session_not_found") {
          this.markDead(sessionId);
          return;
        }
        throw new Error(`screenshot exited ${result.code}`);
      }
      const reply = JSON.parse(result.stdout) as { path?: string };
      const data = await readFile(reply.path ?? outPath);
      const ref = await attachments.saveImage({
        data,
        mediaType: "image/png",
        name: `observation-${sessionId}.png`,
      });
      const entry = this.observations.get(sessionId);
      if (entry === undefined) return;
      this.captureFailures.delete(sessionId);
      this.globalFailures = 0;
      this.setAvailable(true);
      this.thumbRefs.set(String(ref.attachmentId), ref);
      this.put({ ...entry, thumbnailAttachmentId: String(ref.attachmentId) });
    } catch {
      // Silent by design: keep the previous frame, count toward backoff.
      this.captureFailures.set(sessionId, (this.captureFailures.get(sessionId) ?? 0) + 1);
      this.globalFailures += 1;
      if (this.globalFailures >= FAILURE_BACKOFF_THRESHOLD) this.setAvailable(false);
    } finally {
      this.captureInFlight.delete(sessionId);
      if (!this.disposed && this.observations.has(sessionId)) this.scheduleCapture(sessionId);
    }
  }
  /** Mark a session dead: grey it out, stop asking for frames, keep the entry for the strip. */
  private markDead(sessionId: string): void {
    const entry = this.observations.get(sessionId);
    if (entry === undefined || entry.dead === true) return;
    this.cancelCapture(sessionId);
    this.put({ ...entry, dead: true, action: "idle" });
  }
}

/** Map a bsk command label onto its observation action verb. */
export function actionForLabel(label: string): string {
  switch (label) {
    case "session start":
      return "starting";
    case "session stop":
      return "stopping";
    case "navigate":
      return "navigating";
    case "snapshot":
      return "snapshotting";
    case "observe":
      return "observing";
    case "click":
      return "clicking";
    case "fill":
      return "filling";
    case "press":
      return "pressing";
    case "screenshot":
      return "capturing";
    case "emulate":
      return "emulating";
    default:
      return label;
  }
}
