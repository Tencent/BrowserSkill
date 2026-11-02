/**
 * Screenshot delivery. The canonical tool value stays plain JSON (a screenshot
 * file path plus pixel metadata); when the host mounts a durable attachment
 * store AND the calling route declares image input, the capture bytes are
 * additionally committed through `ctx.attachments` so the render step can
 * attach the image itself to the tool result. Any uncertainty (no store,
 * unknown route, text-only model, unrecognized bytes) falls back to the
 * path-only form.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";

/** Structural view of the attachment seam (avoids a runtime dependency). */
interface AttachmentLike {
  imageLimits: {
    mediaTypes: readonly string[];
    maxImageBytes: number;
    maxMessageImageBytes: number;
  };
  saveImage(input: {
    data: Uint8Array;
    mediaType: string;
    name?: string;
  }): Promise<ImageAttachmentRef>;
}

interface LlmLike {
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ inputModalities?: readonly string[] }>;
}

/**
 * Sniff the image media type from magic bytes. The capture path can hand back
 * JPEG (e.g. `chrome.tabs.captureVisibleTab` on some Chromium/Edge builds
 * returning JPEG regardless of the requested format), so the declared type can
 * never be trusted from the file extension alone.
 * @param data - first bytes of the capture.
 * @returns the detected media type, or undefined when unrecognized.
 */
export function sniffImageMediaType(data: Uint8Array): string | undefined {
  if (data.length >= 4) {
    // PNG signature: 89 50 4E 47 (0D 0A 1A 0A)
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
      return "image/png";
    }
    // JPEG SOI: FF D8 FF
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
      return "image/jpeg";
    }
    // WebP: "RIFF" (52 49 46 46) + "WEBP" at offset 8
    if (
      data[0] === 0x52 &&
      data[1] === 0x49 &&
      data[2] === 0x46 &&
      data[3] === 0x46 &&
      data.length >= 12 &&
      data[8] === 0x57 &&
      data[9] === 0x45 &&
      data[10] === 0x42 &&
      data[11] === 0x50
    ) {
      return "image/webp";
    }
    // GIF: "GIF87a" or "GIF89a"
    if (
      data[0] === 0x47 &&
      data[1] === 0x49 &&
      data[2] === 0x46 &&
      data[3] === 0x38 &&
      data.length >= 6 &&
      (data[4] === 0x37 || data[4] === 0x39) &&
      data[5] === 0x61
    ) {
      return "image/gif";
    }
  }
  return undefined;
}

/**
 * Commit screenshot bytes to the host attachment store when the composition
 * supports durable images on the current model route.
 * @returns the durable reference, or undefined to stay in path-only mode.
 */
export async function trySaveScreenshot(
  ctx: Context,
  exec: ToolExecution,
  data: Uint8Array,
  name: string,
): Promise<ImageAttachmentRef | undefined> {
  const attachments = ctx.get("attachments") as AttachmentLike | undefined;
  if (attachments === undefined) return undefined;
  // Declare the real media type from the bytes, never a hard-coded "image/png".
  // Declaring the wrong type trips the store's IMAGE_TYPE_MISMATCH check and
  // silently degrades to path-only; sniffing first lets JPEG captures (returned
  // by some Chromium builds for `captureVisibleTab({ format: "png" })`) still
  // inline correctly.
  const mediaType = sniffImageMediaType(data);
  if (mediaType === undefined) return undefined;
  if (!attachments.imageLimits.mediaTypes.includes(mediaType)) return undefined;
  if (
    data.byteLength >
    Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
  ) {
    return undefined;
  }
  if (!(await isImageCapableRoute(ctx, exec))) return undefined;
  try {
    return await attachments.saveImage({ data, mediaType, name });
  } catch {
    // A store hiccup must not fail the tool call; the path-only form still works.
    return undefined;
  }
}

/**
 * Best-effort check that the calling route's model accepts image input,
 * mirroring dsh-tool-fs `read_image`. Unknown route / missing llm service
 * answers false (refuse to attach) so history never gains an image block a
 * text-only adapter cannot replay.
 */
async function isImageCapableRoute(ctx: Context, exec: ToolExecution): Promise<boolean> {
  const llm = ctx.get("llm") as LlmLike | undefined;
  const provider =
    exec.agent?.session.requestHeader()?.config.provider ?? exec.agent?.options.provider;
  const model = exec.agent?.session.requestHeader()?.config.model ?? exec.agent?.options.model;
  if (llm === undefined || provider === undefined || model === undefined) return false;
  try {
    const info = await llm.resolveModelInfo(provider, model, exec.signal);
    return info.inputModalities?.includes("image") ?? false;
  } catch {
    return false;
  }
}
