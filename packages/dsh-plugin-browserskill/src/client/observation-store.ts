/**
 * Client-side data layer for the observation overlay: initial state fetch,
 * SSE increment stream, on-demand thumbnail blob loading through the
 * session-authorized readAttachment path, and the interrupt call. All I/O is
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
    init?: { method?: string; body?: string },
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
  readonly connected: boolean;
  readonly thumbnails: Readonly<Record<string, ThumbnailState>>;
  /** False when the host reports the browser/daemon as unreachable. */
  readonly available: boolean;
}

const STATE_URL = "/bsk-observation/state";
const EVENTS_URL = "/bsk-observation/events";
const INTERRUPT_URL = "/bsk-observation/interrupt";

export class ObservationClientStore {
  private sessions = new Map<string, SessionObservation>();
  private thumbs = new Map<string, ThumbnailState>();
  private listeners = new Set<() => void>();
  private events: EventSourceLike | undefined;
  private snapshot: OverlaySnapshot = {
    sessions: [],
    connected: false,
    thumbnails: {},
    available: true,
  };
  private available = true;
  private started = false;

  constructor(private readonly deps: ObservationClientDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): OverlaySnapshot => this.snapshot;

  private publish(): void {
    this.snapshot = {
      sessions: [...this.sessions.values()],
      connected: this.events !== undefined,
      thumbnails: Object.fromEntries(this.thumbs),
      available: this.available,
    };
    for (const listener of [...this.listeners]) listener();
  }

  /** Initial fetch + SSE subscription. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.deps
      .fetchFn(STATE_URL)
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as {
          sessions?: SessionObservation[];
          available?: boolean;
        };
        this.sessions = new Map((body.sessions ?? []).map((s) => [s.sessionId, s]));
        if (typeof body.available === "boolean") this.available = body.available;
        this.publish();
      })
      .catch(() => {});
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
    this.events = events;
    this.publish();
  }

  stop(): void {
    this.events?.close();
    this.events = undefined;
    this.started = false;
    for (const thumb of this.thumbs.values()) {
      if (thumb.url !== undefined && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(thumb.url);
      }
    }
    this.thumbs.clear();
    this.sessions.clear();
    this.publish();
  }

  private apply(event: ObservationEvent): void {
    if (event.type === "reset") {
      this.sessions.clear();
    } else if (event.type === "remove" && event.session !== undefined) {
      this.sessions.delete(event.session.sessionId);
    } else if (event.type === "upsert" && event.session !== undefined) {
      this.sessions.set(event.session.sessionId, event.session);
    } else if (event.type === "availability") {
      this.available = event.available;
    }
    this.publish();
  }

  /**
   * Ensure a thumbnail load is in flight for one attachment reference. New
   * frames replace the old URL; failures keep the last good frame (the caller
   * renders `status: 'error'` as a small badge over the old image).
   */
  ensureThumbnail(attachmentId: string | undefined): void {
    if (attachmentId === undefined || this.thumbs.has(attachmentId)) return;
    this.thumbs.set(attachmentId, { status: "loading" });
    this.publish();
    this.deps.loadImage(attachmentId).then(
      (url) => {
        this.thumbs.set(attachmentId, { status: "ready", url });
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
