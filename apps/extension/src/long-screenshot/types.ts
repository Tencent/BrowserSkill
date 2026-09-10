export const LONG_SCREENSHOT = "bsk/long-screenshot";
export const LONG_SCREENSHOT_PAGE = "bsk/long-screenshot-page";
export const LONG_SCREENSHOT_STATE = "longScreenshotState";

export type CapturePhase =
  | "preparing"
  | "capturing"
  | "saving"
  | "complete"
  | "cancelled"
  | "error";
export type CaptureError =
  | "unsupported"
  | "unavailable"
  | "busy"
  | "changed"
  | "tooLarge"
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
  width?: number;
  height?: number;
}

export const isCapturing = (state: CaptureState | null | undefined) =>
  state?.phase === "preparing" || state?.phase === "capturing" || state?.phase === "saving";

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
  | { action: "begin"; label: string; cancelLabel: string }
  | { action: "move"; y: number; capture: boolean }
  | { action: "inspect" }
  | { action: "finish" };

export type PageRequest = PageCommand & { type: typeof LONG_SCREENSHOT_PAGE; id: string };
export type PageReply = { ok: true; metrics: PageMetrics } | { ok: false; error: CaptureError };

export type CaptureRequest =
  | { type: typeof LONG_SCREENSHOT; action: "start" }
  | { type: typeof LONG_SCREENSHOT; action: "status" }
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
