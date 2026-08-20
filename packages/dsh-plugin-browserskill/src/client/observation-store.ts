/**
 * Client-side data layer for the observation overlay: initial state fetch,
 * SSE increment stream (with a state refetch on every (re)open — events that
 * fired while the stream was down are otherwise lost forever), on-demand
 * thumbnail blob loading through the session-authorized readAttachment path,
 * and the interrupt call. The last ready blob per session is held until its
 * replacement decodes so the overlay can swap frames in place. All I/O is
 * injected so tests never touch a network.
 */

import type { ObservationEvent, SessionObservation } from "../observation";

export interface EventSourceLike {
  onmessage: ((event: { data: string }) => void) | null;
  /** Fires on the initial connect AND on every automatic reconnect. */
  onopen?: (() => void) | null;
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

const STATE_URL = "/bsk-observation/state";
const EVENTS_URL = "/bsk-observation/events";
const INTERRUPT_URL = "/bsk-observation/interrupt";

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
  /** sessionId → last successfully decoded frame (held across the next load). */
  private readonly lastReady = new Map<string, { attachmentId: string; url: string }>();
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

  /** (Re)pull the full state: initial load and every SSE (re)open. */
  private refreshState(): void {
    void this.deps
      .fetchFn(STATE_URL)
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as {
          sessions?: SessionObservation[];
          available?: boolean;
        };
        const sessions = body.sessions ?? [];
        this.sessions = new Map(sessions.map((s) => [s.sessionId, s]));
        // Prune thumbnails of sessions that vanished while we were away.
        const alive = new Set(sessions.map((s) => s.sessionId));
        for (const sessionId of [...this.thumbBySession.keys()]) {
          if (!alive.has(sessionId)) this.dropThumb(sessionId);
        }
        for (const s of sessions) this.trackThumb(s.sessionId, s.thumbnailAttachmentId);
        if (typeof body.available === "boolean") this.available = body.available;
        this.publish();
      })
      .catch(() => {});
  }

  /** Initial fetch + SSE subscription. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.refreshState();
    const events = this.deps.eventSourceFactory(EVENTS_URL);
    events.onmessage = (message) => {
      let event: ObservationEvent;
      try {
        event = JSON.parse(message.data) as ObservationEvent;
      } catch {
        return;
      }
      this.apply(event);
    };
    events.onopen = () => {
      // Reconnects lose every event fired during the outage — resync.
      if (this.events === events) this.refreshState();
    };
    this.events = events;
    this.publish();
  }

  stop(): void {
    this.events?.close();
    this.events = undefined;
    this.started = false;
    for (const thumb of this.thumbs.values()) revoke(thumb.url);
    this.thumbs.clear();
    this.thumbBySession.clear();
    this.lastReady.clear();
    this.sessions.clear();
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

  /** Forget one session's tracked + held frames, revoking their blob URLs. */
  private dropThumb(sessionId: string): void {
    const attachmentId = this.thumbBySession.get(sessionId);
    const held = this.lastReady.get(sessionId);
    this.thumbBySession.delete(sessionId);
    this.lastReady.delete(sessionId);
    if (attachmentId !== undefined) {
      revoke(this.thumbs.get(attachmentId)?.url);
      this.thumbs.delete(attachmentId);
    }
    if (held !== undefined && held.attachmentId !== attachmentId) {
      revoke(held.url);
      this.thumbs.delete(held.attachmentId);
    }
  }

  /**
   * Track the frame a session currently advertises. The last *ready* blob is
   * kept until the replacement decodes — dropping it on the upsert is what
   * made the overlay flash a placeholder between breaths.
   */
  private trackThumb(sessionId: string, attachmentId: string | undefined): void {
    const previous = this.thumbBySession.get(sessionId);
    if (previous === attachmentId) return;
    if (attachmentId !== undefined) this.thumbBySession.set(sessionId, attachmentId);
    else this.thumbBySession.delete(sessionId);
    const heldId = this.lastReady.get(sessionId)?.attachmentId;
    if (previous !== undefined && previous !== heldId) {
      revoke(this.thumbs.get(previous)?.url);
      this.thumbs.delete(previous);
    }
  }

  private apply(event: ObservationEvent): void {
    if (event.type === "reset") {
      this.sessions.clear();
      for (const thumb of this.thumbs.values()) revoke(thumb.url);
      this.thumbs.clear();
      this.thumbBySession.clear();
      this.lastReady.clear();
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
  }

  /**
   * Ensure a thumbnail load is in flight for one attachment reference. New
   * frames replace the old URL only after they decode; failures keep the last
   * good frame (the caller renders `status: 'error'` as a small badge over
   * the old image).
   */
  ensureThumbnail(attachmentId: string | undefined): void {
    if (attachmentId === undefined || this.thumbs.has(attachmentId)) return;
    this.thumbs.set(attachmentId, { status: "loading" });
    this.publish();
    this.deps.loadImage(attachmentId).then(
      (url) => {
        if (!this.thumbs.has(attachmentId)) {
          // Replaced or removed while loading: never resurrect (or leak) it.
          revoke(url);
          return;
        }
        this.thumbs.set(attachmentId, { status: "ready", url });
        const sessionId = this.sessionOf(attachmentId);
        if (sessionId !== undefined) {
          const previous = this.lastReady.get(sessionId);
          if (previous !== undefined && previous.attachmentId !== attachmentId) {
            revoke(previous.url);
            this.thumbs.delete(previous.attachmentId);
          }
          this.lastReady.set(sessionId, { attachmentId, url });
        }
        this.publish();
      },
      () => {
        this.thumbs.set(attachmentId, { status: "error" });
        this.publish();
      },
    );
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
}
