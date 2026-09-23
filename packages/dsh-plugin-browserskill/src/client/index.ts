/**
 * dsh-plugin-browserskill browser half: the `browser_inspect` keyed toolview
 * plus the observation overlay (live thumbnails + interrupt). The
 * native right Sidebar is preferred when the host provides it; older hosts
 * keep the floating card. The user may switch to floating for this page.
 */

import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import type { ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
// Type-only: pulls the 'shell.overlay' SlotMap merge into scope.
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
// Current renderer/session adapters own Context.slots and the session-scoped props.
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { createElement, useCallback } from "react";
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

/** Return a fresh component-owned URL; the host's loadImage may return shared cached URLs. */
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
      function BrowserInspectSessionView(props: ToolCallViewProps) {
        const loadImage = useCallback(
          (attachment: ImageAttachmentRef) =>
            loadSessionImage(sessions, props.sessionId, attachment),
          [props.sessionId],
        );
        return createElement(BrowserInspectToolView, {
          ...props,
          loadImage,
        });
      },
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
