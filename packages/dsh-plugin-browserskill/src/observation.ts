/**
 * ObservationService: per-owned-session live observation state for the PiP
 * overlay — current action, page url, and a breathing thumbnail identified by
 * an ephemeral frame id. Frames live in a per-session 2-slot ring in process
 * memory (never the durable attachment store). Strict ownership boundary
 * applies throughout: only sessions in the plugin's SessionRegistry (owned by
 * construction) ever get an observation entry, and interrupt/kill paths can
 * only reach children this plugin spawned.
 *
 * Observation traffic isolation: thumbnail captures run through the runner
 * directly (never through the tool-level instrumentation), emit no action
 * events, and never move the registry's current pointer.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { sniffImageMediaType } from "./image";
import type { KeyedExecutor } from "./queue";
import { BskError, type BskRunner, parseBskJson, runWithSessionBusyRetry } from "./runner";
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
  /** Latest thumbnail id (ephemeral, plugin-owned; never bytes on the wire). */
  thumbnailAttachmentId?: string;
  /** Summary of the most recent failed action (drives the red status dot). */
  lastError?: string;
  /**
   * The daemon reports this session as gone (e.g. daemon restart): the strip
   * greys it out until it is stopped/removed. No more frames are requested.
   */
  dead?: boolean;
  /**
   * The DSH conversations this session belongs to (the starting agent's
   * session plus its seed-lineage ancestors), recorded at start. Scoped
   * surfaces (the better-sidebar tab) filter by it; absent means untracked
   * ownership — visible only in the global (unscoped) view.
   */
  dshSessionIds?: string[];
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
/** Current + previous frame, so an in-flight HTTP fetch of the old id still lands. */
const FRAME_RING_SIZE = 2;

export class ObservationService {
  private readonly scratchNamespace = randomUUID();
  private readonly observations = new Map<string, SessionObservation>();
  private readonly listeners = new Set<(event: ObservationEvent) => void>();
  private readonly captureTimers = new Map<string, unknown>();
  private readonly captureInFlight = new Set<string>();
  /** Captures intentionally cancelled to make way for foreground work. */
  private readonly capturePreempted = new Set<string>();
  /** Number of queued/running model-facing calls that currently outrank thumbnails. */
  private readonly foregroundDepth = new Map<string, number>();
  private readonly captureFailures = new Map<string, number>();
  private readonly lastActivity = new Map<string, number>();
  /** Ephemeral frame id → PNG bytes. Only the live ring members are present. */
  private readonly frames = new Map<string, { data: Uint8Array; mediaType: string }>();
  /** sessionId → oldest-first frame ids, length ≤ FRAME_RING_SIZE. */
  private readonly rings = new Map<string, string[]>();
  /** sessionId → sha256 of the current frame (skip republish when unchanged). */
  private readonly hashes = new Map<string, string>();
  /** sessionId → last issued sequence number. */
  private readonly seqs = new Map<string, number>();
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

  /** Register a fresh owned session (called from browser_session action=start). */
  addSession(sessionId: string, url?: string): void {
    if (!this.deps.options.enabled || this.disposed) return;
    const dshSessionIds = this.deps.registry.dshOwnersOf(sessionId);
    this.put({
      sessionId,
      ...(url !== undefined ? { url } : {}),
      action: "idle",
      since: this.scheduler.now(),
      ...(dshSessionIds.length > 0 ? { dshSessionIds } : {}),
    });
    this.lastActivity.set(sessionId, this.scheduler.now());
    this.scheduleCapture(sessionId, 0);
  }

  /** Drop a session (called from browser_session action=stop). */
  removeSession(sessionId: string): void {
    this.cancelCapture(sessionId);
    this.foregroundDepth.delete(sessionId);
    this.capturePreempted.delete(sessionId);
    this.captureFailures.delete(sessionId);
    this.lastActivity.delete(sessionId);
    this.dropSessionFrames(sessionId);
    if (this.observations.delete(sessionId)) {
      this.emit({
        type: "remove",
        session: { sessionId, action: "idle", since: this.scheduler.now() },
      });
    }
  }

  /**
   * Give model-facing work priority over the best-effort thumbnail lane.
   * The first lease cancels a pending timer and gracefully interrupts an
   * active bsk screenshot; the last release schedules one fresh frame.
   */
  acquireForeground(sessionId: string): () => void {
    if (!this.deps.options.enabled || this.disposed || !this.observations.has(sessionId)) {
      return () => {};
    }
    const depth = this.foregroundDepth.get(sessionId) ?? 0;
    this.foregroundDepth.set(sessionId, depth + 1);
    if (depth === 0) {
      this.cancelCapture(sessionId);
      if (this.deps.runner.killFor(`observation:${sessionId}`) > 0) {
        this.capturePreempted.add(sessionId);
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.foregroundDepth.get(sessionId) ?? 1) - 1;
      if (remaining > 0) {
        this.foregroundDepth.set(sessionId, remaining);
        return;
      }
      this.foregroundDepth.delete(sessionId);
      if (!this.disposed && this.observations.has(sessionId)) this.scheduleCapture(sessionId, 0);
    };
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
    if (!this.foregroundDepth.has(sessionId)) this.scheduleCapture(sessionId, 0);
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
   * Stop one owned session and close its Agent Window (the overlay's stop
   * button — same end state as `browser_session` action=stop). Never waits behind a
   * hung in-flight command: tool children are killed first so the session's
   * keyed queue drains immediately, and no further captures queue up. A
   * session the daemon already forgot stops idempotently — the goal state
   * (entry gone) is identical.
   * @returns false only for a foreign session; bsk failures reject so callers
   * can preserve the structured error instead of silently leaving a ghost.
   */
  async stopSession(sessionId: string, signal?: AbortSignal): Promise<boolean> {
    if (!this.deps.registry.isOwned(sessionId)) return false;
    const releaseForeground = this.acquireForeground(sessionId);
    let actionError: string | undefined;
    this.beginAction(sessionId, "stopping");
    try {
      this.deps.runner.killFor(sessionId);
      const result = await this.deps.queue.run(
        sessionId,
        () =>
          runWithSessionBusyRetry(
            () =>
              this.deps.runner.run(["session", "stop", sessionId], {
                signal,
                timeoutMs: 30_000,
                tag: sessionId,
              }),
            signal,
          ),
        signal,
      );
      if (result.aborted) throw abortError();
      try {
        parseBskJson(result, "session stop");
      } catch (error) {
        if (!isSessionNotFoundError(error)) throw error;
      }
      this.deps.registry.remove(sessionId);
      this.removeSession(sessionId);
      return true;
    } catch (error) {
      actionError = error instanceof Error ? error.message.split("\n")[0] : String(error);
      throw error;
    } finally {
      this.endAction(sessionId, actionError);
      releaseForeground();
    }
  }

  /**
   * Read one captured thumbnail from the in-process ring. Powers the plugin's
   * own HTTP thumbnail route — frames are plugin-owned runtime data, never
   * referenced by any session log, so the session-authorized client RPC
   * cannot serve them.
   */
  async readThumbnail(
    attachmentId: string,
  ): Promise<{ data: Uint8Array; mediaType: string } | undefined> {
    const frame = this.frames.get(attachmentId);
    if (frame === undefined) return undefined;
    return { data: frame.data, mediaType: frame.mediaType };
  }

  /** Tear down all state and timers (plugin dispose). */
  dispose(): void {
    this.disposed = true;
    for (const sessionId of [...this.captureTimers.keys()]) this.cancelCapture(sessionId);
    this.captureTimers.clear();
    this.captureInFlight.clear();
    this.capturePreempted.clear();
    this.foregroundDepth.clear();
    this.captureFailures.clear();
    this.lastActivity.clear();
    this.frames.clear();
    this.rings.clear();
    this.hashes.clear();
    this.seqs.clear();
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
    if (this.foregroundDepth.has(sessionId)) return;
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
   * the in-process ring, id onto the observation. Runs OUTSIDE the tool
   * instrumentation on purpose — no action events, no registry writes.
   * Failures keep the previous frame and back off silently.
   */
  private async capture(sessionId: string): Promise<void> {
    if (this.disposed) return;
    const current = this.observations.get(sessionId);
    if (current === undefined || current.dead === true) return;
    if (this.captureInFlight.has(sessionId)) return;
    this.captureInFlight.add(sessionId);
    // Stable within this service, isolated from captures owned by other instances.
    const sessionKey = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
    const outPath = join(tmpdir(), `bsk-obs-${this.scratchNamespace}-${sessionKey}.png`);
    let writtenPath = outPath;
    try {
      const result = await this.deps.queue.run(sessionId, () => {
        // A foreground lease may have arrived while this capture was queued.
        if (this.foregroundDepth.has(sessionId)) return Promise.resolve(undefined);
        return this.deps.runner.run(["screenshot", "--session", sessionId, "--out", outPath], {
          timeoutMs: 15_000,
          tag: `observation:${sessionId}`,
        });
      });
      if (result === undefined) return;
      if (result.code !== 0) {
        let code: string | undefined;
        try {
          code = (JSON.parse(result.stdout) as { code?: string }).code;
        } catch {
          code = undefined;
        }
        if (isSessionNotFoundCode(code)) {
          // Observation entries are owned sessions. If the daemon has already
          // forgotten one (external close / restart), reconcile both stores so
          // the PiP cannot retain a ghost strip or keep retrying screenshots.
          this.deps.registry.remove(sessionId);
          this.removeSession(sessionId);
          return;
        }
        throw new Error(`screenshot exited ${result.code}`);
      }
      const reply = JSON.parse(result.stdout) as { path?: string };
      writtenPath = reply.path ?? outPath;
      const data = await readFile(writtenPath);
      const entry = this.observations.get(sessionId);
      if (entry === undefined) return;
      this.captureFailures.delete(sessionId);
      this.globalFailures = 0;
      this.setAvailable(true);
      this.publishFrame(sessionId, entry, data);
    } catch {
      // Foreground preemption is healthy scheduling, not browser/daemon
      // unavailability; do not let normal tool traffic trip capture backoff.
      if (!this.capturePreempted.delete(sessionId)) {
        // Silent by design: keep the previous frame, count toward backoff.
        this.captureFailures.set(sessionId, (this.captureFailures.get(sessionId) ?? 0) + 1);
        this.globalFailures += 1;
        if (this.globalFailures >= FAILURE_BACKOFF_THRESHOLD) this.setAvailable(false);
      }
    } finally {
      await unlink(writtenPath).catch(() => {});
      this.capturePreempted.delete(sessionId);
      this.captureInFlight.delete(sessionId);
      if (!this.disposed && this.observations.has(sessionId)) this.scheduleCapture(sessionId);
    }
  }

  /** Insert a new frame, or no-op when the PNG bytes match the current one. */
  private publishFrame(sessionId: string, entry: SessionObservation, data: Uint8Array): void {
    const hash = createHash("sha256").update(data).digest("hex");
    if (this.hashes.get(sessionId) === hash) return;
    const seq = (this.seqs.get(sessionId) ?? 0) + 1;
    this.seqs.set(sessionId, seq);
    const id = `obs-${sessionId}-${seq}`;
    this.frames.set(id, { data, mediaType: sniffImageMediaType(data) ?? "image/png" });
    this.hashes.set(sessionId, hash);
    const ring = this.rings.get(sessionId) ?? [];
    ring.push(id);
    while (ring.length > FRAME_RING_SIZE) {
      const evicted = ring.shift();
      if (evicted !== undefined) this.frames.delete(evicted);
    }
    this.rings.set(sessionId, ring);
    this.put({ ...entry, thumbnailAttachmentId: id });
  }

  private dropSessionFrames(sessionId: string): void {
    for (const id of this.rings.get(sessionId) ?? []) this.frames.delete(id);
    this.rings.delete(sessionId);
    this.hashes.delete(sessionId);
    this.seqs.delete(sessionId);
  }
}

function isSessionNotFoundCode(code: string | undefined): boolean {
  return code === "not_found" || code === "session_not_found";
}

function isSessionNotFoundError(error: unknown): boolean {
  return error instanceof BskError && isSessionNotFoundCode(error.code);
}

function abortError(): Error {
  const error = new Error("tool call aborted");
  error.name = "AbortError";
  return error;
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
    case "hover":
      return "hovering";
    case "fill":
      return "filling";
    case "select":
      return "selecting";
    case "press":
      return "pressing";
    case "screenshot":
      return "capturing";
    case "emulate":
      return "emulating";
    case "tab list":
      return "listing tabs";
    case "tab create":
      return "creating tab";
    case "tab close":
      return "closing tab";
    case "tab select":
      return "selecting tab";
    case "tab borrow":
      return "borrowing tab";
    case "tab return":
      return "returning tab";
    case "navigate-back":
      return "navigating back";
    case "navigate-forward":
      return "navigating forward";
    case "reload":
      return "reloading";
    case "wait-for-navigation":
      return "waiting for navigation";
    case "request-help":
      return "waiting for user";
    case "get-html":
      return "reading HTML";
    case "console":
      return "reading console";
    case "network":
      return "reading network";
    case "window resize":
      return "resizing window";
    default:
      return label;
  }
}
