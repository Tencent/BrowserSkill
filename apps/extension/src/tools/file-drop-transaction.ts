// One native file-drop transaction bound to an explicit page target. CDP drag
// events are sent to the target that owns the node: root targets use top-level
// coordinates, while OOPIF targets require coordinates local to their session.

import { isStaleFrameHandleError } from "@/browser-driver/frame-handles";
import type { RpcError, TransferEffectState } from "@/transport/types";
import { rpcError, transferError } from "./errors";
import { resolveNodeGeometry } from "./frame-geometry";
import type { ResolvedActionTarget } from "./interaction";
import { type CdpRunner, isRpcError, sendToFrameHandle } from "./shared";
import { pointReachesTarget } from "./target-hit";
import { BoundedWaitError, waitBounded } from "./transfer-transaction";

const CLEANUP_TIMEOUT_MS = 1_000;

type FileDropPhase = "resolve_target" | "drag_enter" | "drag_over" | "drop" | "cleanup";

interface DragData {
  items: [];
  files: string[];
  dragOperationsMask: number;
}

export interface FileDropTransactionOptions {
  cdp: CdpRunner;
  actionTarget: ResolvedActionTarget;
  files: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called immediately before dispatching the final `drop` event (commit boundary). */
  onDropSent?: () => void;
  withOverlayHidden: <T>(operation: () => Promise<T>) => Promise<T>;
}

export interface FileDropTransactionResult {
  x: number;
  y: number;
}

function failure(
  code: RpcError["code"],
  reason: "upload_mechanism_unsupported" | "file_drop_target_unavailable" | "file_drop_failed",
  message: string,
  effectState: TransferEffectState,
  phase: FileDropPhase,
): RpcError {
  const error = transferError(code, reason, message, { effectState, phase });
  error.data = { ...error.data, mechanism: "drop" };
  return error;
}

function enrichFailure(
  error: RpcError,
  effectState: TransferEffectState,
  phase: FileDropPhase,
): RpcError {
  return {
    ...error,
    data: {
      ...error.data,
      mechanism: "drop",
      effect_state: effectState,
      phase,
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function methodUnavailable(error: unknown): boolean {
  return /(?:method|command).*(?:not found|wasn't found|unsupported)|wasn't found|-32601/i.test(
    messageOf(error),
  );
}

export async function uploadThroughFileDrop(
  options: FileDropTransactionOptions,
): Promise<FileDropTransactionResult | RpcError> {
  const deadline = Date.now() + options.timeoutMs;
  const handle = options.actionTarget.handle;
  const dragData: DragData = {
    items: [],
    files: options.files,
    dragOperationsMask: 1,
  };
  let dragStarted = false;
  let dropSent = false;
  let dragPoint = { x: 0, y: 0 };
  let cleanupFailed = false;
  let releaseTabAttachment: (() => void) | undefined;
  let outcome: FileDropTransactionResult | RpcError = failure(
    "protocol_error",
    "file_drop_failed",
    "file-drop transaction ended without an outcome",
    "none",
    "cleanup",
  );

  try {
    releaseTabAttachment = options.cdp.retainTabAttachment?.(handle.tabId);
    const geometry = await waitBounded(
      resolveNodeGeometry(options.cdp, options.actionTarget.tab.tabId, handle, {
        scrollIntoView: true,
      }),
      deadline,
      options.signal,
      "resolving file-drop target timed out",
    );
    if (isRpcError(geometry)) {
      outcome = enrichFailure(geometry, "none", "resolve_target");
      return outcome;
    }
    const point = geometry.targetActionPoint;
    dragPoint = point;

    outcome = await options.withOverlayHidden(async () => {
      try {
        try {
          // Verify through the full top-level target chain so parent-page modals,
          // sticky headers, and nested frame overlays occluding an OOPIF drop
          // target fail closed before any drag event is sent.
          const reaches = await waitBounded(
            pointReachesTarget(options.cdp, { handle }, geometry.actionPoint),
            deadline,
            options.signal,
            "verifying file-drop target timed out",
          );
          if (!reaches) {
            return failure(
              "permission_denied",
              "file_drop_target_unavailable",
              "file-drop target is not the topmost element at its action point",
              "none",
              "resolve_target",
            );
          }
        } catch (error) {
          if (isStaleFrameHandleError(error)) {
            return enrichFailure(
              rpcError("not_found", "ref_not_found", error.message),
              "none",
              "resolve_target",
            );
          }
          return failure(
            error instanceof BoundedWaitError
              ? error.kind === "aborted"
                ? "cancelled"
                : "timeout"
              : "cdp_failed",
            "file_drop_target_unavailable",
            messageOf(error),
            "none",
            "resolve_target",
          );
        }

        const dispatchDragStep = async (
          type: "dragEnter" | "dragOver" | "drop",
          timeoutMessage: string,
          onDispatched?: () => void,
        ) => {
          const stepAbort = new AbortController();
          const forward = () => stepAbort.abort();
          options.signal?.addEventListener("abort", forward, { once: true });
          if (options.signal?.aborted) stepAbort.abort();
          let dispatched = false;
          try {
            await waitBounded(
              sendToFrameHandle(
                options.cdp,
                handle,
                "Input.dispatchDragEvent",
                {
                  type,
                  x: point.x,
                  y: point.y,
                  data: dragData,
                },
                {
                  signal: stepAbort.signal,
                  onDispatch: () => {
                    if (stepAbort.signal.aborted || Date.now() >= deadline) {
                      throw new DOMException(timeoutMessage, "AbortError");
                    }
                    dispatched = true;
                    onDispatched?.();
                  },
                },
              ),
              deadline,
              options.signal,
              timeoutMessage,
            );
          } catch (error) {
            if (!dispatched) stepAbort.abort();
            throw error;
          } finally {
            options.signal?.removeEventListener("abort", forward);
          }
        };

        for (const [type, phase] of [
          ["dragEnter", "drag_enter"],
          ["dragOver", "drag_over"],
        ] as const) {
          try {
            await dispatchDragStep(
              type,
              `${type} timed out`,
              type === "dragEnter"
                ? () => {
                    dragStarted = true;
                  }
                : undefined,
            );
          } catch (error) {
            const unsupported = methodUnavailable(error);
            if (type === "dragEnter" && !(error instanceof BoundedWaitError)) dragStarted = false;
            if (isStaleFrameHandleError(error) && type === "dragEnter") {
              return enrichFailure(
                rpcError("not_found", "ref_not_found", error.message),
                "none",
                phase,
              );
            }
            return failure(
              unsupported
                ? "unsupported"
                : error instanceof BoundedWaitError
                  ? error.kind === "aborted"
                    ? "cancelled"
                    : "timeout"
                  : "cdp_failed",
              unsupported ? "upload_mechanism_unsupported" : "file_drop_failed",
              messageOf(error),
              "none",
              phase,
            );
          }
        }

        try {
          await dispatchDragStep("drop", "file drop timed out", () => {
            options.onDropSent?.();
            dropSent = true;
          });
          return { x: point.x, y: point.y };
        } catch (error) {
          if (isStaleFrameHandleError(error) && !dropSent) {
            outcome = enrichFailure(
              rpcError("not_found", "ref_not_found", error.message),
              "none",
              "drop",
            );
            return outcome;
          }
          const aborted =
            options.signal?.aborted ||
            (error instanceof BoundedWaitError && error.kind === "aborted") ||
            (error instanceof Error && error.name === "AbortError");
          const timedOut =
            (error instanceof BoundedWaitError && error.kind === "timeout") ||
            (error instanceof Error && error.name === "TimeoutError");
          outcome = failure(
            aborted ? "cancelled" : timedOut ? "timeout" : "cdp_failed",
            "file_drop_failed",
            messageOf(error),
            dropSent ? "unknown" : "none",
            "drop",
          );
          return outcome;
        }
      } finally {
        if (dragStarted && !dropSent) {
          try {
            await waitBounded(
              sendToFrameHandle(options.cdp, handle, "Input.dispatchDragEvent", {
                type: "dragCancel",
                x: dragPoint.x,
                y: dragPoint.y,
                data: dragData,
              }),
              Date.now() + CLEANUP_TIMEOUT_MS,
              undefined,
              "cancelling file drag timed out",
            );
          } catch {
            cleanupFailed = true;
          }
        }
      }
    });
    return outcome;
  } catch (error) {
    outcome = isStaleFrameHandleError(error)
      ? enrichFailure(
          rpcError("not_found", "ref_not_found", error.message),
          "none",
          "resolve_target",
        )
      : failure(
          error instanceof BoundedWaitError
            ? error.kind === "aborted"
              ? "cancelled"
              : "timeout"
            : "cdp_failed",
          "file_drop_target_unavailable",
          messageOf(error),
          "none",
          "resolve_target",
        );
    return outcome;
  } finally {
    try {
      const effect = isRpcError(outcome)
        ? (outcome.data?.effect_state as TransferEffectState | undefined)
        : "committed";
      if (effect === "unknown" || cleanupFailed) {
        await options.cdp.detach?.(handle.tabId).catch(() => {});
      }
      if (cleanupFailed && isRpcError(outcome)) {
        outcome.data = { ...outcome.data, cleanup_state: "failed" };
      }
    } finally {
      releaseTabAttachment?.();
    }
  }
}
