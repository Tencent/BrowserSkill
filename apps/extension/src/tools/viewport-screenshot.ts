import {
  type CaptureSuppressSendToTab,
  withExtensionOverlayHidden,
} from "@/lib/capture-suppress-bridge";
import type { RpcError } from "@/transport/types";
import { rpcError } from "./errors";
import { parsePngDimensions } from "./png";
import type { CdpRunner } from "./shared";
import { isAbortError, throwIfAborted } from "./vom/capture-abort";
import { verifyDocumentIdentity } from "./vom/document-identity";
import type { DocumentIdentity } from "./vom/facts";

function changed(): RpcError {
  return rpcError(
    "not_found",
    "visual_target_changed",
    "Screenshot target changed or its document could not be verified; capture the current target again",
  );
}

/** Cleanup and identity probes must not auto-attach to a replacement connection. */
function boundToAttachment(cdp: CdpRunner, tabId: number, attachmentId: string): CdpRunner {
  return {
    getAttachmentId: (id) => cdp.getAttachmentId?.(id),
    send: <T>(id: number, method: string, params?: object) => {
      if (id !== tabId || cdp.getAttachmentId?.(id) !== attachmentId) {
        return Promise.reject(new Error("Screenshot attachment changed"));
      }
      return cdp.send<T>(id, method, params);
    },
  };
}

/** Read only the main document identity, not a VOM/AX snapshot or frame graph. */
async function readDocumentIdentity(cdp: CdpRunner, tabId: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  const tree = await cdp.send<{ frameTree?: { frame: { id: string } } }>(
    tabId,
    "Page.getFrameTree",
  );
  const attachmentId = cdp.getAttachmentId?.(tabId);
  const frameId = tree.frameTree?.frame.id;
  if (!attachmentId || !frameId) return null;
  const bound = boundToAttachment(cdp, tabId, attachmentId);
  const objectGroup = `bsk-viewport-identity-${crypto.randomUUID()}`;
  try {
    throwIfAborted(signal);
    const world = await bound.send<{ executionContextId: number }>(
      tabId,
      "Page.createIsolatedWorld",
      {
        frameId,
        worldName: "bsk-document-identity",
      },
    );
    throwIfAborted(signal);
    const root = await bound.send<{
      result?: { deepSerializedValue?: { type: string; value?: { backendNodeId?: number } } };
    }>(tabId, "Runtime.evaluate", {
      expression: "document.documentElement",
      contextId: world.executionContextId,
      objectGroup,
      serializationOptions: {
        serialization: "deep",
        additionalParameters: { maxNodeDepth: 0, includeShadowTree: "none" },
      },
    });
    const node = root.result?.deepSerializedValue;
    const backendNodeId = node?.type === "node" ? node.value?.backendNodeId : undefined;
    if (backendNodeId === undefined || cdp.getAttachmentId?.(tabId) !== attachmentId) return null;
    return {
      attachmentId,
      frameId,
      target: { tabId },
      documentElementBackendNodeId: backendNodeId,
    } satisfies DocumentIdentity;
  } finally {
    await bound.send(tabId, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
  }
}

/** Capture a controlled target's viewport without using the window's selected tab.
 * The caller owns execution policy; this operation neither acquires nor releases it. */
export async function captureControlledViewport(
  cdp: CdpRunner,
  tabId: number,
  stillControlled: () => Promise<boolean>,
  signal?: AbortSignal,
  sendToTab?: CaptureSuppressSendToTab,
): Promise<{ image_base64: string; width: number; height: number } | RpcError> {
  try {
    throwIfAborted(signal);
    if (!(await stillControlled())) return changed();
    const identity = await readDocumentIdentity(cdp, tabId, signal);
    if (!identity) return changed();
    const bound = boundToAttachment(cdp, tabId, identity.attachmentId);
    const current = async () => {
      throwIfAborted(signal);
      return (
        (await stillControlled()) &&
        (await verifyDocumentIdentity(bound, identity, signal)) === "current" &&
        cdp.getAttachmentId?.(tabId) === identity.attachmentId
      );
    };
    const shot = await withExtensionOverlayHidden(
      tabId,
      async () => {
        if (!(await current())) return null;
        return bound.send<{ data?: string }>(tabId, "Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
        });
      },
      sendToTab,
    );
    throwIfAborted(signal);
    // Validate after overlay restoration as well: navigation/return can race it.
    if (!shot || !(await current()) || !(await stillControlled())) return changed();
    throwIfAborted(signal);
    if (cdp.getAttachmentId?.(tabId) !== identity.attachmentId) return changed();
    const dims = shot.data ? parsePngDimensions(shot.data) : null;
    if (!dims) {
      return rpcError(
        "cdp_failed",
        "screenshot_capture_failed",
        "Viewport capture returned no valid PNG dimensions",
      );
    }
    return { image_base64: shot.data!, ...dims };
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      return { code: "cancelled", message: "screenshot aborted" };
    }
    return rpcError(
      "cdp_failed",
      "screenshot_capture_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}
