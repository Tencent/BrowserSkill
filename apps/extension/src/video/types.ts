export const VIDEO_VERSION = 1;
export const VIDEO_CHUNK_BYTES = 256 * 1024;
export const VIDEO_MAX_BYTES = 256 * 1024 * 1024;
export const VIDEO_BUDGET_BYTES = 1024 * 1024 * 1024;
export const VIDEO_RETENTION_MS = 24 * 60 * 60_000;
export const VIDEO_MAX_DURATION_MS = 10 * 60_000;
export const VIDEO_MESSAGE = "bsk/video";
export const VIDEO_HOST_MESSAGE = "bsk/video-host";
export const VIDEO_HOST_EVENT = "bsk/video-host-event";

export const VIDEO_PRESETS = {
  standard: { maxDimension: 1280, fps: 15, bitrate: 2_000_000 },
  clear: { maxDimension: 1920, fps: 30, bitrate: 4_000_000 },
} as const;

export type VideoQuality = keyof typeof VIDEO_PRESETS;
export type VideoState = "starting" | "recording" | "finalizing" | "ready" | "failed";
export type VideoStopReason =
  | "user_stopped"
  | "duration_limit"
  | "size_limit"
  | "tab_closed"
  | "session_ended"
  | "disconnected"
  | "debugger_detached"
  | "capture_failed"
  | "encoding_failed"
  | "storage_failed"
  | "browser_restarted";

export interface VideoRecording {
  recording_id: string;
  session_id: string;
  tab_id: number;
  title: string;
  state: VideoState;
  quality: VideoQuality;
  created_at: number;
  started_at?: number;
  expires_at: number;
  max_duration_ms: number;
  duration_ms: number;
  byte_size: number;
  width: number;
  height: number;
  frames: number;
  dropped_frames: number;
  stop_reason?: VideoStopReason;
  completeness?: "complete" | "partial";
  error?: string;
  exported: boolean;
}

/** The capability and connection owner never enter UI snapshots or public events. */
export interface StoredVideo extends VideoRecording {
  owner: string;
  capability: string;
  request_id: string;
}

export interface VideoStartOptions {
  session_id: string;
  tab_id?: number;
  max_duration_ms?: number;
  quality?: VideoQuality;
  request_id: string;
}

export type VideoParams =
  | ({ action: "start" } & VideoStartOptions)
  | { action: "capabilities"; browser?: string }
  | { action: "list"; browser?: string }
  | {
      action: "status" | "stop" | "read" | "discard" | "exported";
      browser?: string;
      recording_id: string;
      capability: string;
      offset?: number;
    };

export interface VideoGrant {
  recording: VideoRecording;
  capability: string;
}

export interface VideoTask {
  session_id: string;
  tabs: { id: number; title: string; url: string; active: boolean }[];
}

export function publicVideo(value: StoredVideo): VideoRecording {
  const { owner: _owner, capability: _capability, request_id: _request, ...recording } = value;
  return recording;
}

export function isVideoId(id: unknown): id is string {
  return typeof id === "string" && /^vid_[a-f0-9]{32}$/.test(id);
}

export function completeStop(reason: VideoStopReason): boolean {
  return ["user_stopped", "duration_limit", "size_limit"].includes(reason);
}

export function videoFilename(recording: VideoRecording): string {
  const title = recording.title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .trim()
    .slice(0, 80);
  const date = new Date(recording.created_at).toISOString().replace(/[:.]/g, "-");
  return `${title || "Video"}-${date}.mp4`;
}

export function validateVideoStart(value: VideoStartOptions): string | undefined {
  if (!value || typeof value.session_id !== "string" || !value.session_id)
    return "session_id is required";
  if (typeof value.request_id !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(value.request_id))
    return "A stable request_id is required";
  if (value.tab_id !== undefined && (!Number.isSafeInteger(value.tab_id) || value.tab_id < 0))
    return "Invalid tab_id";
  const duration = value.max_duration_ms ?? 60_000;
  if (!Number.isSafeInteger(duration) || duration < 1000 || duration > VIDEO_MAX_DURATION_MS)
    return "max_duration_ms must be between 1000 and 600000";
  if (value.quality !== undefined && !Object.hasOwn(VIDEO_PRESETS, value.quality))
    return "quality must be standard or clear";
}
