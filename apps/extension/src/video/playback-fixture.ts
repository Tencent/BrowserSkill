import { BlobSource, BufferSource, EncodedPacketSink, Input, MP4 } from "mediabunny";

export interface VideoFrameTarget {
  time: number;
  timestamp: number;
  duration: number;
}

/** Resolve the actual MP4 frame covering each requested time, including long static frames. */
export async function videoFrameTargets(file: Blob | Uint8Array, times: number[]) {
  const input = new Input({
    source: file instanceof Blob ? new BlobSource(file) : new BufferSource(file),
    formats: [MP4],
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("MP4 has no video track");
    const duration = await input.computeDuration();
    const sink = new EncodedPacketSink(track);
    const targets: VideoFrameTarget[] = [];
    for (const time of times) {
      if (!Number.isFinite(time) || time < 0 || time >= duration)
        throw new Error(`MP4 sample time ${time}s is outside [0, ${duration})`);
      const packet = await sink.getPacket(time, { metadataOnly: true });
      if (!packet || packet.duration <= 0 || time >= packet.timestamp + packet.duration)
        throw new Error(`MP4 has no frame covering ${time}s`);
      targets.push({ time, timestamp: packet.timestamp, duration: packet.duration });
    }
    return targets;
  } finally {
    input.dispose();
  }
}

/**
 * Also serialized with .toString() into CDP Runtime.evaluate: keep this function
 * self-contained, with no module variables/imports referenced at runtime.
 * sample, when supplied, must likewise be defined in the player page.
 */
export async function readVideoPixels(
  video: HTMLVideoElement,
  targets: VideoFrameTarget[],
  sample?: (video: HTMLVideoElement) => number[],
) {
  if (video.readyState < 1 || !Number.isFinite(video.duration) || video.duration <= 0)
    throw new Error("MP4 metadata is not ready");
  for (const { time, timestamp, duration } of targets) {
    if (!Number.isFinite(time) || time < 0 || time >= video.duration)
      throw new Error(`MP4 sample time ${time}s is outside [0, ${video.duration})`);
    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      timestamp < 0 ||
      time < timestamp ||
      time >= timestamp + duration
    )
      throw new Error(`Invalid MP4 frame interval for ${time}s`);
  }
  video.pause();
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d")!;
  const pixels: number[][] = [];
  let previous: { timestamp: number; pixels: number[] } | undefined;
  for (const { time, timestamp, duration } of targets) {
    // Dense scans often request the same encoded frame several times. Reuse
    // only a frame whose presentation was already verified in this call.
    if (previous?.timestamp === timestamp) {
      pixels.push([...previous.pixels]);
      continue;
    }
    // A no-op seek need not produce seeked/rVFC. Move within the SAME encoded
    // frame when the requested time is already current, rather than timing out.
    let seekTime = time;
    if (seekTime === video.currentTime) {
      const end = Math.min(timestamp + duration, video.duration);
      seekTime = timestamp + (end - timestamp) / 2;
      if (seekTime === video.currentTime) seekTime = timestamp + (end - timestamp) / 4;
    }
    await new Promise<void>((resolve, reject) => {
      let seeked = false;
      let presented = false;
      let mediaTime: number | undefined;
      let callback = 0;
      const cleanup = () => {
        clearTimeout(timer);
        video.cancelVideoFrameCallback(callback);
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
      };
      const complete = () => {
        if (!seeked || !presented) return;
        cleanup();
        resolve();
      };
      const onSeeked = () => {
        seeked = true;
        complete();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`MP4 playback failed: ${video.error?.message}`));
      };
      const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
        mediaTime = metadata.mediaTime;
        // rVFC reports the frame's PTS, not the seek position. A previous
        // frame's queued callback must not satisfy a seek to a different frame.
        presented = Math.abs(mediaTime - timestamp) < 0.0001;
        if (presented) complete();
        else callback = video.requestVideoFrameCallback(onFrame);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `MP4 frame at ${time}s did not become ready (expected PTS=${timestamp}, actual PTS=${mediaTime}, seeked=${seeked}, presented=${presented}, readyState=${video.readyState})`,
          ),
        );
      }, 5000);
      video.addEventListener("seeked", onSeeked);
      video.addEventListener("error", onError);
      callback = video.requestVideoFrameCallback(onFrame);
      try {
        video.currentTime = seekTime;
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
    let pixel: number[];
    if (sample) pixel = sample(video);
    else {
      context.drawImage(video, 0, 0);
      pixel = Array.from(context.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data);
    }
    previous = { timestamp, pixels: pixel };
    pixels.push(pixel);
  }
  return pixels;
}
