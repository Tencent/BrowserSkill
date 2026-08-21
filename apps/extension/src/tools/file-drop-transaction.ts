// One native file-drop transaction bound to an explicit page target. CDP drag
// events are sent to the target that owns the node: root targets use top-level
// coordinates, while OOPIF targets require coordinates local to their session.

import type { RpcError, TransferEffectState } from "@/transport/types";
import { transferError } from "./errors";
import { resolveNodeGeometry } from "./frame-geometry";
import type { ResolvedActionTarget } from "./interaction";
import { type CdpRunner, isRpcError, sendToCdpTarget } from "./shared";
import { BoundedWaitError, waitBounded } from "./transfer-transaction";

const CLEANUP_TIMEOUT_MS = 1_000;

type FileDropPhase = "resolve_target" | "drag_enter" | "drag_over" | "drop" | "cleanup";

interface RuntimeReply {
  result?: { value?: unknown; objectId?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

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

function runtimeError(reply: RuntimeReply, fallback: string): Error | null {
  if (!reply.exceptionDetails) return null;
  return new Error(
    reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? fallback,
  );
}

async function pointBelongsToTarget(
  options: FileDropTransactionOptions,
  x: number,
  y: number,
  objectGroup: string,
): Promise<boolean> {
  const target = options.actionTarget.cdpTarget;
  const hit = await sendToCdpTarget<{ backendNodeId?: number; frameId?: string }>(
    options.cdp,
    target,
    "DOM.getNodeForLocation",
    { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: true },
  );
  if (typeof hit.backendNodeId !== "number") return false;
  if (options.actionTarget.frameId && hit.frameId !== options.actionTarget.frameId) return false;

  const [resolvedTarget, resolvedHit] = await Promise.all([
    sendToCdpTarget<{ object?: { objectId?: string } }>(options.cdp, target, "DOM.resolveNode", {
      backendNodeId: options.actionTarget.backendNodeId,
      objectGroup,
    }),
    sendToCdpTarget<{ object?: { objectId?: string } }>(options.cdp, target, "DOM.resolveNode", {
      backendNodeId: hit.backendNodeId,
      objectGroup,
    }),
  ]);
  const targetObjectId = resolvedTarget.object?.objectId;
  const hitObjectId = resolvedHit.object?.objectId;
  if (!targetObjectId || !hitObjectId) return false;

  const reply = await sendToCdpTarget<RuntimeReply>(options.cdp, target, "Runtime.callFunctionOn", {
    objectId: targetObjectId,
    functionDeclaration: `function(hit) {
        for (let node = hit; node; ) {
          if (node === this) return true;
          if (this.contains?.(node)) return true;
          const root = node.getRootNode?.();
          node = node.parentNode || (root && root !== node ? root.host : null);
        }
        return false;
      }`,
    arguments: [{ objectId: hitObjectId }],
    returnByValue: true,
  });
  const error = runtimeError(reply, "failed to verify file-drop target");
  if (error) throw error;
  return reply.result?.value === true;
}

export async function uploadThroughFileDrop(
  options: FileDropTransactionOptions,
): Promise<FileDropTransactionResult | RpcError> {
  const deadline = Date.now() + options.timeoutMs;
  const target = options.actionTarget.cdpTarget;
  const objectGroup = `bsk-file-drop-${crypto.randomUUID()}`;
  const dragData: DragData = {
    items: [],
    files: options.files,
    dragOperationsMask: 1,
  };
  let dragStarted = false;
  let dropSent = false;
  let dragPoint = { x: 0, y: 0 };
  let cleanupFailed = false;
  let outcome: FileDropTransactionResult | RpcError = failure(
    "protocol_error",
    "file_drop_failed",
    "file-drop transaction ended without an outcome",
    "none",
    "cleanup",
  );

  try {
    const geometry = await waitBounded(
      resolveNodeGeometry(
        options.cdp,
        options.actionTarget.tab.tabId,
        {
          target,
          backendNodeId: options.actionTarget.backendNodeId,
          ...(options.actionTarget.frameId ? { frameId: options.actionTarget.frameId } : {}),
        },
        { scrollIntoView: true },
      ),
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
          const belongs = await waitBounded(
            pointBelongsToTarget(options, point.x, point.y, objectGroup),
            deadline,
            options.signal,
            "verifying file-drop target timed out",
          );
          if (!belongs) {
            return failure(
              "permission_denied",
              "file_drop_target_unavailable",
              "file-drop target is not the topmost element at its action point",
              "none",
              "resolve_target",
            );
          }
        } catch (error) {
          return failure(
            error instanceof BoundedWaitError ? "timeout" : "cdp_failed",
            "file_drop_target_unavailable",
            messageOf(error),
            "none",
            "resolve_target",
          );
        }

        for (const [type, phase] of [
          ["dragEnter", "drag_enter"],
          ["dragOver", "drag_over"],
        ] as const) {
          try {
            if (type === "dragEnter") dragStarted = true;
            await waitBounded(
              sendToCdpTarget(options.cdp, target, "Input.dispatchDragEvent", {
                type,
                x: point.x,
                y: point.y,
                data: dragData,
              }),
              deadline,
              options.signal,
              `${type} timed out`,
            );
          } catch (error) {
            const unsupported = methodUnavailable(error);
            if (type === "dragEnter" && unsupported) dragStarted = false;
            return failure(
              unsupported
                ? "unsupported"
                : error instanceof BoundedWaitError
                  ? "timeout"
                  : "cdp_failed",
              unsupported ? "upload_mechanism_unsupported" : "file_drop_failed",
              messageOf(error),
              "none",
              phase,
            );
          }
        }

        try {
          dropSent = true;
          await waitBounded(
            sendToCdpTarget(options.cdp, target, "Input.dispatchDragEvent", {
              type: "drop",
              x: point.x,
              y: point.y,
              data: dragData,
            }),
            deadline,
            options.signal,
            "file drop timed out",
          );
          return { x: point.x, y: point.y };
        } catch (error) {
          outcome = failure(
            error instanceof BoundedWaitError ? "timeout" : "cdp_failed",
            "file_drop_failed",
            messageOf(error),
            "unknown",
            "drop",
          );
          return outcome;
        }
      } finally {
        if (dragStarted && !dropSent) {
          try {
            await waitBounded(
              sendToCdpTarget(options.cdp, target, "Input.dispatchDragEvent", {
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
    outcome = failure(
      error instanceof BoundedWaitError ? "timeout" : "cdp_failed",
      "file_drop_target_unavailable",
      messageOf(error),
      "none",
      "resolve_target",
    );
    return outcome;
  } finally {
    try {
      await waitBounded(
        sendToCdpTarget(options.cdp, target, "Runtime.releaseObjectGroup", { objectGroup }),
        Date.now() + CLEANUP_TIMEOUT_MS,
        undefined,
        "releasing file-drop object group timed out",
      );
    } catch {
      cleanupFailed = true;
    }

    const effect = isRpcError(outcome)
      ? (outcome.data?.effect_state as TransferEffectState | undefined)
      : "committed";
    if (effect === "unknown" || cleanupFailed) {
      await options.cdp.detach?.(target.tabId);
    }
    if (cleanupFailed && isRpcError(outcome)) {
      outcome.data = { ...outcome.data, cleanup_state: "failed" };
    }
  }
}
