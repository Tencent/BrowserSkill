import type { Rect } from "@browser-skill/vom";

export const SURFACE_CAPTURE_TTL_MS = 30_000;

export interface SurfaceCapture {
  id: string;
  sessionId: string;
  tabId: number;
  navigationIdentity: string;
  surface: {
    ref: string;
    frameId?: string;
    backendNodeId: number;
    observationGeneration: number;
  };
  topViewportRect: Rect;
  imageWidth: number;
  imageHeight: number;
  viewportSignature: string;
  frameProjectionSignature: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

export type SurfaceCaptureInput = Omit<
  SurfaceCapture,
  "id" | "createdAt" | "expiresAt" | "consumed"
>;

export type SurfaceCaptureConsumeResult =
  | { ok: true; capture: SurfaceCapture }
  | { ok: false; reason: "not_found" | "expired" | "consumed" };

export interface SurfaceCaptureStoreOptions {
  now?: () => number;
  ttlMs?: number;
  createId?: () => string;
}

function randomCaptureId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `sc_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Per-session, metadata-only store for short-lived screenshot coordinate transactions. */
export class SurfaceCaptureStore {
  private readonly captures = new Map<string, SurfaceCapture>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly createId: () => string;

  constructor(options: SurfaceCaptureStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? SURFACE_CAPTURE_TTL_MS;
    this.createId = options.createId ?? randomCaptureId;
  }

  create(input: SurfaceCaptureInput): SurfaceCapture {
    this.purgeExpired();
    const createdAt = this.now();
    const capture: SurfaceCapture = {
      ...input,
      id: this.createId(),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      consumed: false,
    };
    this.captures.set(capture.id, capture);
    return capture;
  }

  consume(id: string): SurfaceCaptureConsumeResult {
    const capture = this.captures.get(id);
    if (!capture) return { ok: false, reason: "not_found" };
    if (capture.expiresAt <= this.now()) {
      this.captures.delete(id);
      return { ok: false, reason: "expired" };
    }
    if (capture.consumed) return { ok: false, reason: "consumed" };
    capture.consumed = true;
    return { ok: true, capture };
  }

  clear(): void {
    this.captures.clear();
  }

  size(): number {
    this.purgeExpired();
    return this.captures.size;
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [id, capture] of this.captures) {
      if (capture.expiresAt <= now) this.captures.delete(id);
    }
  }
}
