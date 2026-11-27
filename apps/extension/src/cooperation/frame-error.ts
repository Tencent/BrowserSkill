import type { RpcError } from "@/transport/types";
import type { FrameIdentity } from "./types";

const describe = (frames: FrameIdentity[]) =>
  frames.map((frame) => `${frame.frame_id} (${frame.url})`).join(", ");

/** Permanent collection failures must not suggest another wait/sync loop. */
export class FrameCollectionError extends Error {
  constructor(
    readonly reason: "frame_unobservable" | "page_load_failed",
    readonly frames: FrameIdentity[],
  ) {
    super(
      reason === "page_load_failed"
        ? `The main page failed to load (${frames[0]?.url})`
        : `Page frames cannot be observed: ${describe(frames)}`,
    );
  }

  toRpcError(effect: "none" | "unknown" = "none"): RpcError {
    const blankMainFrame = this.frames.some(
      (frame) => frame.frame_id === 0 && frame.url === "about:",
    );
    return {
      code: "permission_denied",
      message: this.message,
      data: {
        reason: this.reason,
        effect_state: effect,
        frames: this.frames,
        recovery:
          effect === "unknown"
            ? "Inspect the application result before reloading or choosing another action. Never replay an uncertain submission."
            : this.reason === "page_load_failed"
              ? "Check the page URL and network connection, then reload the tab and synchronize."
              : blankMainFrame
                ? "Navigate this tab to a web page with `bsk navigate <url> --session <id>`, then sync again. Reloading about:blank will not make it observable."
                : "Reload the tab once. If it persists, use read-only commands such as get-html or snapshot.",
      },
    };
  }
}

/**
 * Live documents that did not answer before the collection deadline. A busy
 * renderer can recover, so this stays on the ordinary wait/sync retry path
 * (unlike FrameCollectionError) while still naming each frame.
 */
export class FrameUnresponsiveError extends Error {
  constructor(readonly frames: FrameIdentity[]) {
    super(`A page frame is not responding: ${describe(frames)}`);
  }
}
