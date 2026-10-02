import type { SessionContext } from "@/session-manager/manager";
import type { RpcError } from "@/transport/types";
import { type CdpRunner, isRpcError } from "./shared";
import { isAbortError } from "./vom/capture-abort";

export interface InputReadinessDeps {
  cdp: CdpRunner;
  signal?: AbortSignal;
  deadline?: number;
}

export interface ReadyInput {
  hidden: boolean;
  /** Call immediately before sending a click, key press or wheel event. */
  markSent(): void;
}
function abortError(signal?: AbortSignal): RpcError | null {
  return signal?.aborted
    ? { code: "cancelled", message: "input aborted", data: { effect_state: "none" } }
    : null;
}

class InputPaintUnconfirmedError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = error instanceof Error ? error.name : "Error";
  }
}

/** CDP commands cannot be cancelled; consume late replies without delaying cleanup. */
function waitForInputReply<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
  timeout = 5000,
  deadline = Infinity,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new DOMException("input aborted", "AbortError"));
    };
    const timer = setTimeout(
      () => {
        cleanup();
        reject(new DOMException("Renderer did not become ready for input", "TimeoutError"));
      },
      Math.max(0, Math.min(timeout, deadline - Date.now())),
    );
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** A surface read forces a compositor frame; rAF alone can remain suspended in a hidden window.
 * Discard the low-quality image. No file, tab activation, device metrics or viewport changes. */
export async function flushInputRendering(
  cdp: CdpRunner,
  tabId: number,
  signal?: AbortSignal,
  deadline?: number,
): Promise<void> {
  if (signal?.aborted) throw new DOMException("input aborted", "AbortError");
  // Read the viewport surface without a document-space clip, which can become
  // stale if a previously requested scroll has not yet reached the compositor.
  const shot = await waitForInputReply(
    cdp.send<{ data?: string }>(tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 0,
      fromSurface: true,
      captureBeyondViewport: false,
    }),
    signal,
    5000,
    deadline,
  );
  if (!shot.data) throw new Error("Renderer did not produce an input readiness frame");
}

/** Two animation frames on a visible page: the renderer completed a rendering update. */
async function waitForRendererFrames(
  cdp: CdpRunner,
  tabId: number,
  failure: string,
  signal?: AbortSignal,
  deadline?: number,
): Promise<void> {
  if (signal?.aborted) throw new DOMException("input aborted", "AbortError");
  const reply = await waitForInputReply(
    cdp.send<{ result?: { value?: boolean } }>(tabId, "Runtime.evaluate", {
      expression: `new Promise(resolve => {
      let frame;
      const timer = setTimeout(() => { cancelAnimationFrame(frame); resolve(false); }, 4000);
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => {
        clearTimeout(timer); resolve(true);
      }); });
    })`,
      awaitPromise: true,
      returnByValue: true,
    }),
    signal,
    5000,
    deadline,
  );
  if (reply.result?.value !== true) throw new Error(failure);
}

/** After waking, wait for wheel scrolling to reach the renderer before hiding it again. */
export async function waitForInputPaint(
  cdp: CdpRunner,
  tabId: number,
  signal?: AbortSignal,
  deadline?: number,
): Promise<void> {
  try {
    await waitForRendererFrames(
      cdp,
      tabId,
      "Renderer did not finish painting input",
      signal,
      deadline,
    );
  } catch (error) {
    // This helper runs only after the wheel dispatch was acknowledged.
    throw new InputPaintUnconfirmedError(error);
  }
}

function sampleVisibility(tabId: number, deps: InputReadinessDeps): Promise<string | undefined> {
  return waitForInputReply(
    deps.cdp.send<{ result: { value?: string } }>(tabId, "Runtime.evaluate", {
      expression: "document.visibilityState",
      returnByValue: true,
    }),
    deps.signal,
    5000,
    deps.deadline,
  ).then((reply) => reply.result.value);
}

/** Recover an owned lease whose override Chrome dropped outside the applied-state cache.
 * Only the lease owner changes focus emulation; its override stays enabled for later tools.
 * Wait on animation frames, not a surface read: after a re-show, Chrome can leave
 * `Page.captureScreenshot({ fromSurface })` pending while frames already run. */
async function restoreLeasedInput(
  ctx: SessionContext,
  tabId: number,
  deps: InputReadinessDeps,
): Promise<RpcError | undefined> {
  const notReady = (message: string): RpcError => ({
    code: "cdp_failed",
    message,
    data: { reason: "input_not_ready", effect_state: "none" },
  });
  const restore = deps.cdp.restoreBackgroundExecution?.bind(deps.cdp);
  if (!restore)
    return notReady("Input target is hidden despite an owned background-execution lease");
  try {
    await waitForInputReply(restore(ctx.sessionId, tabId), deps.signal, 5000, deps.deadline);
    // Frames stay suspended while hidden, so check visibility before waiting on them.
    if ((await sampleVisibility(tabId, deps)) !== "visible")
      return notReady("Input target is not visible after restoring its background-execution lease");
    await waitForRendererFrames(
      deps.cdp,
      tabId,
      "Renderer did not produce a frame after restoring its background-execution lease",
      deps.signal,
      deps.deadline,
    );
    return;
  } catch (error) {
    // Cancellation and deadlines keep their own codes in the caller.
    if (isAbortError(error) || (error instanceof Error && error.name === "TimeoutError"))
      throw error;
    return notReady(
      `Could not restore the owned background-execution lease: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Prepare hidden native input without activating the tab or retrying the action.
 * Focus ownership relies on the daemon's per-session queue and exclusive tab ownership. */
export async function withInputReady<T extends object>(
  ctx: SessionContext,
  tabId: number,
  deps: InputReadinessDeps,
  action: (input: ReadyInput) => Promise<T | RpcError>,
): Promise<T | RpcError> {
  const aborted = abortError(deps.signal);
  if (aborted) return aborted;
  const documentRevision = ctx.refStore.documentRevision(tabId);
  let restoreFocus = false;
  let attachmentId: string | undefined;
  let inputSent = false;
  let ready = false;
  const checkActive = () => {
    if (deps.signal?.aborted) throw new DOMException("input aborted", "AbortError");
    if (Date.now() >= (deps.deadline ?? Infinity))
      throw new DOMException("input timed out", "TimeoutError");
  };
  let result: T | RpcError;
  let cleanupError: string | undefined;
  try {
    checkActive();
    deps.cdp.trackSessionTab?.(ctx.sessionId, tabId);
    // A persistent lease owns focus emulation for dispatcher-controlled tools;
    // unowned direct-handler paths retain the bounded 0.3.0 fallback below.
    const persistentLease = deps.cdp.ownsBackgroundExecution?.(ctx.sessionId, tabId) === true;
    const visibility = await sampleVisibility(tabId, deps);
    const cancelled = abortError(deps.signal);
    if (cancelled) return cancelled;
    checkActive();
    if (visibility === "hidden" && persistentLease) {
      const notReady = await restoreLeasedInput(ctx, tabId, deps);
      if (notReady) return notReady;
      checkActive();
    } else if (visibility === "hidden") {
      attachmentId = deps.cdp.getAttachmentId?.(tabId);
      // Mark ownership before awaiting: a failed reply may still have enabled it.
      restoreFocus = true;
      await waitForInputReply(
        deps.cdp.send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }),
        deps.signal,
        5000,
        deps.deadline,
      );
      checkActive();
      await flushInputRendering(deps.cdp, tabId, deps.signal, deps.deadline);
    } else if (visibility !== "visible") {
      throw new Error("Could not determine input target visibility");
    }
    const cancelledAfterEnable = abortError(deps.signal);
    if (cancelledAfterEnable) result = cancelledAfterEnable;
    else {
      if (ctx.refStore.documentRevision(tabId) !== documentRevision) {
        result = {
          code: "not_found",
          message: "Document changed while preparing input; observe again",
          data: { reason: "ref_not_found", effect_state: "none" },
        };
      } else {
        checkActive();
        // Recompute geometry after waking: the background viewport may have changed.
        ready = true;
        result = await action({
          hidden: restoreFocus,
          markSent: () => {
            checkActive();
            inputSent = true;
          },
        });
      }
    }
  } catch (error) {
    const code =
      deps.signal?.aborted || isAbortError(error)
        ? "cancelled"
        : error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "cdp_failed";
    result = {
      code,
      message: error instanceof Error ? error.message : String(error),
      data: {
        effect_state: inputSent ? "unknown" : "none",
        ...(inputSent && error instanceof InputPaintUnconfirmedError
          ? { reason: "input_paint_unconfirmed" as const }
          : {}),
        ...(!ready && code !== "cancelled" ? { reason: "input_not_ready" as const } : {}),
      },
    };
  } finally {
    // Detaching clears the override. Do not reattach a closed/replaced target to clean up.
    if (
      restoreFocus &&
      (attachmentId === undefined || deps.cdp.getAttachmentId?.(tabId) === attachmentId)
    ) {
      try {
        await waitForInputReply(
          deps.cdp.send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: false }),
          undefined,
          // Leave room within the daemon's 2s cancellation grace for other cleanup and transport.
          1000,
        );
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : String(error);
      }
    }
  }
  // Actions can return structured errors instead of throwing. Keep both paths
  // consistent, including cancellation after an input acknowledgement was lost.
  if (isRpcError(result)) {
    result = {
      ...result,
      data: {
        ...result.data,
        effect_state: inputSent ? "unknown" : "none",
        ...(inputSent && result.data?.reason !== "input_paint_unconfirmed"
          ? { reason: "input_outcome_unknown" as const }
          : {}),
      },
    };
  }
  if (cleanupError) {
    if (!isRpcError(result))
      result = {
        code: "cdp_failed",
        message: "Input completed but temporary focus emulation could not be disabled",
        data: { reason: "input_cleanup_failed", effect_state: "unknown" },
      };
    return { ...result, data: { ...result.data, cleanup_error: cleanupError } };
  }
  return result;
}
