/**
 * Screenshot delivery. The canonical tool value stays plain JSON (a PNG file
 * path plus pixel metadata); when the host mounts a durable attachment store
 * AND the calling route declares image input, the PNG bytes are additionally
 * committed through `ctx.attachments` so the render step can attach the image
 * itself to the tool result. Any uncertainty (no store, unknown route,
 * text-only model) falls back to the path-only form.
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
  if (!attachments.imageLimits.mediaTypes.includes("image/png")) return undefined;
  if (
    data.byteLength >
    Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
  ) {
    return undefined;
  }
  if (!(await isImageCapableRoute(ctx, exec))) return undefined;
  try {
    return await attachments.saveImage({ data, mediaType: "image/png", name });
  } catch {
    // A store hiccup must not fail the tool call; the PNG path still works.
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
