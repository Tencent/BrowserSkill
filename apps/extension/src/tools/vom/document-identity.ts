import type { CdpFrame } from "@/browser-driver/frame-graph";
import type { CdpRunner } from "../shared";
import { sendToCdpTarget } from "../shared";
import { type DocumentIdentity, isCaptureAbort, throwCaptureAborted } from "./facts";

/** Fresh, frame-scoped identity read. An isolated world supplies the owning
 * document without querying each node or installing a page observer. */
export async function readDocumentIdentity(
  cdp: CdpRunner,
  frame: CdpFrame,
  signal?: AbortSignal,
): Promise<DocumentIdentity | undefined> {
  const attachmentId = cdp.getAttachmentId?.(frame.target.tabId);
  if (!attachmentId || !frame.loaderId) return undefined;
  let objectId: string | undefined;
  const send = <T>(method: string, params: object) => {
    throwCaptureAborted(signal);
    return sendToCdpTarget<T>(cdp, frame.target, method, params);
  };
  try {
    const world = await send<{ executionContextId: number }>("Page.createIsolatedWorld", {
      frameId: frame.frameId,
      worldName: "bsk-document-identity",
    });
    const element = await send<{ result?: { objectId?: string } }>("Runtime.evaluate", {
      expression: "document.documentElement",
      contextId: world.executionContextId,
    });
    objectId = element.result?.objectId;
    if (!objectId) return undefined;
    const reply = await send<{ node?: { backendNodeId?: number } }>("DOM.describeNode", {
      objectId,
      depth: 0,
    });
    const backendNodeId = reply.node?.backendNodeId;
    if (!backendNodeId || cdp.getAttachmentId?.(frame.target.tabId) !== attachmentId)
      return undefined;
    return {
      attachmentId,
      target: frame.target,
      frameId: frame.frameId,
      loaderId: frame.loaderId,
      documentElementBackendNodeId: backendNodeId,
    };
  } catch (error) {
    if (isCaptureAbort(error)) throw error;
    return undefined;
  } finally {
    if (objectId)
      await sendToCdpTarget(cdp, frame.target, "Runtime.releaseObject", { objectId }).catch(
        () => {},
      );
  }
}

export function sameDocument(a: DocumentIdentity, b: DocumentIdentity): boolean {
  return (
    a.attachmentId === b.attachmentId &&
    a.target.tabId === b.target.tabId &&
    a.target.sessionId === b.target.sessionId &&
    a.frameId === b.frameId &&
    a.loaderId === b.loaderId &&
    a.documentElementBackendNodeId === b.documentElementBackendNodeId
  );
}
