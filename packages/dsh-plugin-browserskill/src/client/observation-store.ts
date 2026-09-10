/**
 * Client-side data layer for the observation overlay: an ordered SSE snapshot
 * and increment stream (each reconnect starts with a fresh snapshot), on-demand
 * thumbnail blob loading through the host's ephemeral-frame route,
 * and the interrupt call. The last ready blob per session is held until its
 * replacement loads so the overlay can swap frames in place. All I/O is
 * injected so tests never touch a network.
 */

import type { ObservationEvent, SessionObservation } from "../observation";

export interface EventSourceLike {
  onmessage: ((event: { data: string }) => void) | null;
  close(): void;
}

export interface ObservationClientDeps {
  fetchFn: (
    url: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> },
  ) => Promise<{
    ok: boolean;
    json(): Promise<unknown>;
  }>;
  eventSourceFactory: (url: string) => EventSourceLike;
  /** Resolve one attachment id to a displayable blob URL. */
  loadImage: (attachmentId: string) => Promise<string>;
}

export interface ThumbnailState {
  status: "loading" | "ready" | "error";
  url?: string;
}

export interface OverlaySnapshot {
  readonly sessions: readonly SessionObservation[];
  /** Whether the SSE increment stream is currently subscribed. */
  readonly subscribed: boolean;
  readonly thumbnails: Readonly<Record<string, ThumbnailState>>;
  /**
   * sessionId → the frame the overlay should paint. While a newer attachment
   * is still loading (or failed), this keeps the last good URL so the card
   * never drops to a placeholder between breaths.
   */
  readonly displayFrames: Readonly<Record<string, ThumbnailState>>;
  /** False when the host reports the browser/daemon as unreachable. */
  readonly available: boolean;
}

const EVENTS_URL = "/bsk-observation/events";
const INTERRUPT_URL = "/bsk-observation/interrupt";
const STOP_URL = "/bsk-observation/stop";
const THUMBNAIL_RETRY_DELAYS_MS = [1000, 3000];

function revoke(url: string | undefined): void {
  if (url !== undefined && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(url);
  }
}

export class ObservationClientStore {
  private sessions = new Map<string, SessionObservation>();
  private thumbs = new Map<string, ThumbnailState>();
  /** sessionId → the attachment id currently advertised for it. */
  private readonly thumbBySession = new Map<string, string>();
  /** sessionId → last successfully loaded frame (held across the next load). */
  private readonly lastReady = new Map<string, { attachmentId: string; url: string }>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryCounts = new Map<string, number>();
  private listeners = new Set<() => void>();
  private events: EventSourceLike | undefined;
  private snapshot: OverlaySnapshot = {
    sessions: [],
    subscribed: false,
    thumbnails: {},
    displayFrames: {},
    available: true,
  };
  private available = true;
  private started = false;
  /** Refcount of mounted consumers (overlay card, sidebar tab, sidebar fiber). */
  private consumers = 0;
  private thumbnailConsumers = 0;

  constructor(private readonly deps: ObservationClientDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): OverlaySnapshot => this.snapshot;

  private publish(): void {
    this.snapshot = {
      sessions: [...this.sessions.values()],
      subscribed: this.events !== undefined,
      thumbnails: Object.fromEntries(this.thumbs),
      displayFrames: this.buildDisplayFrames(),
      available: this.available,
    };
    for (const listener of [...this.listeners]) listener();
  }

  /** Frame the overlay should paint for one session (last good while next loads). */
  private frameFor(sessionId: string): ThumbnailState | undefined {
    const attachmentId = this.thumbBySession.get(sessionId);
    const current = attachmentId !== undefined ? this.thumbs.get(attachmentId) : undefined;
    if (current?.status === "ready" && current.url !== undefined) return current;
    const held = this.lastReady.get(sessionId);
    if (held !== undefined) {
      return {
        status: current?.status === "error" ? "error" : "ready",
        url: held.url,
      };
    }
    return current;
  }

  private buildDisplayFrames(): Record<string, ThumbnailState> {
    const frames: Record<string, ThumbnailState> = {};
    for (const sessionId of this.sessions.keys()) {
      const frame = this.frameFor(sessionId);
      if (frame !== undefined) frames[sessionId] = frame;
    }
    return frames;
  }

  private sessionOf(attachmentId: string): string | undefined {
    for (const [sessionId, id] of this.thumbBySession) {
      if (id === attachmentId) return sessionId;
    }
    return undefined;
  }

  private connectEvents(): void {
    const previous = this.events;
    this.events = undefined;
    previous?.close();
    const events = this.deps.eventSourceFactory(
      `${EVENTS_URL}?thumbnails=${this.thumbnailConsumers > 0 ? "1" : "0"}`,
    );
    this.events = events;
    events.onmessage = (message) => {
      if (!this.started || this.events !== events) return;
      let event: ObservationEvent;
      try {
        event = JSON.parse(message.data) as ObservationEvent;
      } catch {
        return;
      }
      this.apply(event);
    };
  }

  /** Every initial connection and reconnect starts with the server's snapshot. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.connectEvents();
    this.publish();
  }

  stop(): void {
    const previous = this.events;
    this.events = undefined;
    this.started = false;
    previous?.close();
    this.clearThumbnails();
    this.sessions.clear();
    this.available = true;
    this.publish();
  }

  /**
   * Hold the feed for one consumer's lifetime: the stream starts with the
   * first holder and stops with the last release. Several carriers can share
   * the store (the floating card, the better-sidebar tab, and the sidebar
   * integration fiber) without one unmount killing the others' updates.
   */
  acquire(): void {
    this.consumers += 1;
    if (this.consumers === 1) this.start();
  }

  release(): void {
    if (this.consumers === 0) return;
    this.consumers -= 1;
    if (this.consumers === 0) this.stop();
  }

  /** Only visible image surfaces request screenshots; metadata watchers do not. */
  watchThumbnails(): () => void {
    this.thumbnailConsumers += 1;
    if (this.thumbnailConsumers === 1 && this.started) this.connectEvents();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.thumbnailConsumers -= 1;
      if (this.thumbnailConsumers === 0 && this.started) this.connectEvents();
    };
  }

  private forgetThumbnail(attachmentId: string): void {
    clearTimeout(this.retryTimers.get(attachmentId));
    this.retryTimers.delete(attachmentId);
    this.retryCounts.delete(attachmentId);
    revoke(this.thumbs.get(attachmentId)?.url);
    this.thumbs.delete(attachmentId);
  }

  private clearThumbnails(): void {
    for (const attachmentId of this.thumbs.keys()) this.forgetThumbnail(attachmentId);
    this.thumbBySession.clear();
    this.lastReady.clear();
  }

  /** Forget one session's tracked + held frames, revoking their blob URLs. */
  private dropThumb(sessionId: string): void {
    const attachmentId = this.thumbBySession.get(sessionId);
    const held = this.lastReady.get(sessionId);
    this.thumbBySession.delete(sessionId);
    this.lastReady.delete(sessionId);
    if (attachmentId !== undefined) {
      this.forgetThumbnail(attachmentId);
    }
    if (held !== undefined && held.attachmentId !== attachmentId) {
      this.forgetThumbnail(held.attachmentId);
    }
  }

  /**
   * Track the frame a session currently advertises. The last *ready* blob is
   * kept until the replacement loads — dropping it on the upsert is what
   * made the overlay flash a placeholder between breaths.
   */
  private trackThumb(sessionId: string, attachmentId: string | undefined): void {
    if (attachmentId === undefined) {
      this.dropThumb(sessionId);
      return;
    }
    const previous = this.thumbBySession.get(sessionId);
    if (previous === attachmentId) return;
    this.thumbBySession.set(sessionId, attachmentId);
    const heldId = this.lastReady.get(sessionId)?.attachmentId;
    if (previous !== undefined && previous !== heldId) {
      this.forgetThumbnail(previous);
    }
  }

  private apply(event: ObservationEvent): void {
    if (event.type === "snapshot") {
      this.sessions = new Map(event.sessions.map((session) => [session.sessionId, session]));
      for (const sessionId of this.thumbBySession.keys()) {
        if (!this.sessions.has(sessionId)) this.dropThumb(sessionId);
      }
      for (const session of event.sessions) {
        this.trackThumb(session.sessionId, session.thumbnailAttachmentId);
      }
      this.available = event.available;
    } else if (event.type === "reset") {
      this.sessions.clear();
      this.clearThumbnails();
    } else if (event.type === "remove" && event.session !== undefined) {
      this.sessions.delete(event.session.sessionId);
      this.dropThumb(event.session.sessionId);
    } else if (event.type === "upsert" && event.session !== undefined) {
      this.sessions.set(event.session.sessionId, event.session);
      this.trackThumb(event.session.sessionId, event.session.thumbnailAttachmentId);
    } else if (event.type === "availability") {
      this.available = event.available;
    }
    this.publish();
    if (event.type === "snapshot") {
      for (const session of event.sessions) this.retryThumbnail(session.thumbnailAttachmentId);
    }
  }

  /**
   * Ensure a thumbnail load is in flight for one attachment reference. New
   * frames replace the old URL only after they load; failures keep the last
   * good frame (the caller renders `status: 'error'` as a small badge over
   * the old image).
   */
  ensureThumbnail(attachmentId: string | undefined): void {
    if (
      !this.started ||
      attachmentId === undefined ||
      this.sessionOf(attachmentId) === undefined ||
      this.thumbs.has(attachmentId)
    )
      return;
    const loading: ThumbnailState = { status: "loading" };
    this.thumbs.set(attachmentId, loading);
    this.publish();
    this.deps.loadImage(attachmentId).then(
      (url) => {
        if (this.thumbs.get(attachmentId) !== loading) {
          // Replaced or removed while loading: never resurrect (or leak) it.
          revoke(url);
          return;
        }
        this.retryCounts.delete(attachmentId);
        this.thumbs.set(attachmentId, { status: "ready", url });
        const sessionId = this.sessionOf(attachmentId);
        if (sessionId !== undefined) {
          const previous = this.lastReady.get(sessionId);
          if (previous !== undefined && previous.attachmentId !== attachmentId) {
            this.forgetThumbnail(previous.attachmentId);
          }
          this.lastReady.set(sessionId, { attachmentId, url });
        }
        this.publish();
      },
      () => {
        if (this.thumbs.get(attachmentId) !== loading) return;
        const failed: ThumbnailState = { status: "error" };
        this.thumbs.set(attachmentId, failed);
        const attempts = this.retryCounts.get(attachmentId) ?? 0;
        const delay = THUMBNAIL_RETRY_DELAYS_MS[attempts];
        if (delay !== undefined) {
          this.retryCounts.set(attachmentId, attempts + 1);
          this.retryTimers.set(
            attachmentId,
            setTimeout(() => {
              this.retryTimers.delete(attachmentId);
              if (this.thumbs.get(attachmentId) !== failed) return;
              this.thumbs.delete(attachmentId);
              this.ensureThumbnail(attachmentId);
            }, delay),
          );
        }
        this.publish();
      },
    );
  }

  /** Explicit retry (also used on a fresh connection after an outage). */
  retryThumbnail(attachmentId: string | undefined): void {
    if (attachmentId === undefined || this.thumbs.get(attachmentId)?.status !== "error") return;
    this.forgetThumbnail(attachmentId);
    this.ensureThumbnail(attachmentId);
  }

  /** Interrupt the current or named session's in-flight call. */
  async interrupt(sessionId?: string): Promise<boolean> {
    try {
      const res = await this.deps.fetchFn(INTERRUPT_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sessionId === undefined ? {} : { sessionId }),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { interrupted?: boolean };
      return body.interrupted === true;
    } catch {
      return false;
    }
  }

  /**
   * Stop one session and close its Agent Window. The session's removal
   * arrives through the SSE remove event — no local state is touched here.
   */
  async stopSession(sessionId: string): Promise<boolean> {
    try {
      const res = await this.deps.fetchFn(STOP_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { stopped?: boolean };
      return body.stopped === true;
    } catch {
      return false;
    }
  }
}
