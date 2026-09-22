/**
 * dsh-plugin-browserskill browser half: the `browser_inspect` keyed toolview
 * plus the observation overlay (live thumbnails + interrupt). The
 * native right Sidebar is preferred when the host provides it; older hosts
 * keep the floating card. The user may switch to floating for this page.
 */

import type { ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
// Development-only types for the injected services; newer hosts no longer ship this package.
import type { ClientContext, ISessions, SessionId } from "@deepseek-ai/dsh-client-runtime/client";
// Type-only: pulls the 'shell.overlay' SlotMap merge into scope.
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import { createElement } from "react";
// Scope-prefixed BSK design tokens and utility sheet (injected verbatim as
// <style> tags; selectors stay unhashed so `cn(..., "bsk-obs")` roots match).
import "./bsk-tokens.nomodule.css";
import "./bsk-ui.nomodule.css";
import { BrowserInspectToolView } from "./BrowserInspectToolView";
import { ObservationOverlay } from "./ObservationOverlay";
import { type NativeSidebarHost, registerObservationSidebar } from "./observation-sidebar";
import { type EventSourceLike, ObservationClientStore } from "./observation-store";

/** Required services: slots, session-scoped attachment reads, and the overlay seat. */
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
 * Thumbnail loader for the overlay: frames are plugin-owned runtime data
 * (never referenced by a session log, so the session-authorized RPC refuses
 * them), served by the host over the plugin's own route.
 */
async function overlayImageLoader(attachmentId: string): Promise<string> {
  const res = await fetch(`/bsk-observation/thumbnail/${encodeURIComponent(attachmentId)}`);
  if (!res.ok) throw new Error(`thumbnail fetch failed: ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

/**
 * Client plugin body: register the keyed toolview and the observation overlay.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const sessions = ctx.get("sessions") as unknown as ISessions;
  ctx.slots.inject("tool.call.toolview", () =>
    ctx.slots.register(
      { name: "tool.call.toolview", key: "browser_inspect" },
      (props: ToolCallViewProps) =>
        createElement(BrowserInspectToolView, {
          ...props,
          loadImage: (attachment: ImageAttachmentRef) =>
            loadSessionImage(sessions, props.sessionId, attachment),
        }),
    ),
  );
  const store = new ObservationClientStore({
    fetchFn: (url, init) => fetch(url, init),
    eventSourceFactory: (url) => new EventSource(url) as unknown as EventSourceLike,
    loadImage: overlayImageLoader,
  });
  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register({ name: "shell.overlay", id: "bsk-observation" }, () =>
      createElement(ObservationOverlay, { store }),
    ),
  );
  // Optional services, not required client packages: profiles without the
  // native sidebar still load this bundle and use the floating observation.
  ctx.inject(["sidebarRight", "sidebarRightTabs"], (injected) =>
    registerObservationSidebar(injected as unknown as NativeSidebarHost, store),
  );
}
