import type { StoredVideo, VideoStopReason } from "./types";

export type VideoHostCommand =
  | { action: "start"; recording: StoredVideo; image: string }
  | { action: "frame"; recording_id: string; image: string; elapsed_ms: number }
  | { action: "suspend"; recording_id: string; waiting: boolean; label: string }
  | { action: "stop"; recording_id: string; reason: VideoStopReason }
  | { action: "recover"; recording_id: string; reason?: VideoStopReason }
  | { action: "download_url"; recording_id: string }
  | { action: "revoke_url"; url: string }
  | { action: "idle" };

export interface VideoHostReply {
  id: string;
  result?: unknown;
  error?: string;
}

export interface VideoHost {
  request<T = unknown>(command: VideoHostCommand): Promise<T>;
  closeWhenIdle(): Promise<void>;
}
