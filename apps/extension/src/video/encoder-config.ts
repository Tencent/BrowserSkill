import { videoDimensions } from "./timeline";
import { VIDEO_PRESETS, type VideoQuality } from "./types";

const LEVEL_4_2_MAX_MACROBLOCKS = 8704;

export function videoEncoderConfig(
  width: number,
  height: number,
  quality: VideoQuality,
): VideoEncoderConfig {
  const preset = VIDEO_PRESETS[quality];
  const size = videoDimensions(width, height, preset.maxDimension);
  // AVC levels limit the number of 16x16 macroblocks, including edge padding.
  // Keep level 4.2 for existing sizes; level 5.0 covers 1920x1920 at 30 fps.
  const macroblocks = Math.ceil(size.width / 16) * Math.ceil(size.height / 16);
  return {
    codec: macroblocks <= LEVEL_4_2_MAX_MACROBLOCKS ? "avc1.42002a" : "avc1.420032",
    ...size,
    bitrate: preset.bitrate,
    framerate: preset.fps,
    latencyMode: "realtime",
    avc: { format: "avc" },
  };
}
