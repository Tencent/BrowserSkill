export const LONG_SCREENSHOT = "bsk/long-screenshot";
export const LONG_SCREENSHOT_PAGE = "bsk/long-screenshot-page";
export const LONG_SCREENSHOT_STATE = "longScreenshotState";

export type CapturePhase =
  | "preparing"
  | "capturing"
  | "paused"
  | "saving"
  | "complete"
  | "cancelled"
  | "error";
export type CaptureError =
  | "unsupported"
  | "unavailable"
  | "autoUnavailable"
  | "busy"
  | "changed"
  | "tooLarge"
  | "storageFull"
  | "alignment"
  | "timeout"
  | "captureFailed"
  | "saveFailed"
  | "interrupted";

export interface CaptureState {
  id: string;
  tabId: number;
  title: string;
  phase: CapturePhase;
  progress: number;
  frames: number;
  error?: CaptureError;
  mode?: CaptureMode;
  notice?: CaptureError;
  partial?: boolean;
  width?: number;
  height?: number;
}

export const isCapturing = (state: CaptureState | null | undefined) =>
  state?.phase === "preparing" ||
  state?.phase === "capturing" ||
  state?.phase === "paused" ||
  state?.phase === "saving";

export interface PageMetrics {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  innerWidth: number;
  innerHeight: number;
  dpr: number;
  bottomOverlayHeight?: number;
}

export type PageCommand =
  | { action: "probe" }
  | { action: "begin"; label: string; cancelLabel: string }
  | { action: "move"; y: number; capture: boolean; final?: boolean }
  | { action: "inspect" }
  | { action: "pause"; paused: boolean }
  | { action: "finish" };

export type PageRequest = PageCommand & { type: typeof LONG_SCREENSHOT_PAGE; id: string };
export type PageReply = { ok: true; metrics: PageMetrics } | { ok: false; error: CaptureError };

export type CaptureMode = "auto" | "manual" | "visible";

export type CaptureRequest =
  | { type: typeof LONG_SCREENSHOT; action: "start"; mode?: CaptureMode }
  | { type: typeof LONG_SCREENSHOT; action: "status" }
  | { type: typeof LONG_SCREENSHOT; action: "pause" | "resume" | "finish"; id: string }
  | { type: typeof LONG_SCREENSHOT; action: "cancel"; id: string }
  | { type: typeof LONG_SCREENSHOT; action: "preview"; id: string };

export type CaptureReply =
  | { ok: true; state: CaptureState | null }
  | { ok: false; error: CaptureError };

export class ScreenshotError extends Error {
  constructor(public readonly code: CaptureError) {
    super(code);
  }
}
