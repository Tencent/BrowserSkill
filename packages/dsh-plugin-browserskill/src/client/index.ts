/**
 * dsh-plugin-browserskill browser half: registers the `browser_screenshot`
 * keyed toolview (`tool.call.toolview` slot) so screenshot results render the
 * captured image inline in the Web UI instead of a bare JSON block. Every
 * other browser_* tool keeps the stock terminal card.
 *
 * The image bytes never enter the session log: the view resolves the durable
 * attachment reference through the client session's authorized
 * `readAttachment` RPC and hands a blob URL to the shared MessageImage atom.
 */

import type { ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import type { ClientContext, ISessions, SessionId } from "@deepseek-ai/dsh-client-runtime/client";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import { createElement } from "react";
import { ScreenshotToolView } from "./ScreenshotToolView";

/** Required services: the slot registry plus session-scoped attachment reads. */
export const inject = ["slots", "sessions"];

/** Resolve one durable image attachment into a browser blob URL. */
async function loadSessionImage(
  sessions: ISessions,
  sessionId: SessionId,
  attachment: ImageAttachmentRef,
): Promise<string> {
  const session = sessions.binding(sessionId)?.session;
  if (session === undefined) {
    throw new Error(`screenshot toolview: session "${String(sessionId)}" is not bound`);
  }
  const result = await session.readAttachment(attachment.attachmentId);
  if (!result.ok) {
    throw new Error(
      `screenshot toolview: readAttachment failed: ${result.error.code}: ${result.error.message}`,
    );
  }
  const bytes = Uint8Array.from(result.value.data);
  return URL.createObjectURL(
    new Blob([bytes.buffer as ArrayBuffer], { type: result.value.attachment.mediaType }),
  );
}

/**
 * Client plugin body: register the keyed view with its session-bound loader.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const sessions = ctx.get("sessions") as unknown as ISessions;
  ctx.slots.inject("tool.call.toolview", () =>
    ctx.slots.register(
      { name: "tool.call.toolview", key: "browser_screenshot" },
      (props: ToolCallViewProps) =>
        createElement(ScreenshotToolView, {
          ...props,
          loadImage: (attachment: ImageAttachmentRef) =>
            loadSessionImage(sessions, props.sessionId, attachment),
        }),
    ),
  );
}
