import type { CdpRunner } from "../shared";
import { sendToCdpTarget } from "../shared";
import { isAbortError, throwIfAborted } from "./capture-abort";
import type { DocumentIdentity } from "./facts";
import type { VisualCandidate } from "./visual-discovery";

/** Compare the snapshot root with the current root in that exact frame.
 * Deep serialization supplies the backend ID without a separate describeNode. */
export async function verifyDocumentIdentity(
  cdp: CdpRunner,
  identity: DocumentIdentity,
  signal?: AbortSignal,
): Promise<"current" | "changed" | "unavailable"> {
  return (await verifyIdentity(cdp, identity, signal)).status;
}

/** Verify the visual anchor in its original frame; geometry is checked by screenshot execution. */
export async function verifyVisualTargetIdentity(
  cdp: CdpRunner,
  candidate: VisualCandidate,
  signal?: AbortSignal,
): Promise<"current" | "changed" | "unavailable"> {
  return (await verifyIdentity(cdp, candidate.document, signal, candidate.backendNodeId)).status;
}

export type VerifiedNodeResult =
  | { status: "changed" | "unavailable" }
  | { status: "current"; objectId: string; objectGroup: string };

/** Caller must release objectGroup in finally after its local read. */
export async function resolveVerifiedNode(
  cdp: CdpRunner,
  identity: DocumentIdentity,
  backendNodeId: number,
  signal?: AbortSignal,
): Promise<VerifiedNodeResult> {
  const result = await verifyIdentity(cdp, identity, signal, backendNodeId, true);
  return result.status === "current" && result.objectId && result.objectGroup
    ? { status: "current", objectId: result.objectId, objectGroup: result.objectGroup }
    : { status: result.status === "changed" ? "changed" : "unavailable" };
}

async function verifyIdentity(
  cdp: CdpRunner,
  identity: DocumentIdentity,
  signal?: AbortSignal,
  anchorBackendNodeId?: number,
  retain = false,
): Promise<{
  status: "current" | "changed" | "unavailable";
  objectId?: string;
  objectGroup?: string;
}> {
  const attached = () => cdp.getAttachmentId?.(identity.target.tabId) === identity.attachmentId;
  throwIfAborted(signal);
  if (!attached()) return { status: "changed" };
  const objectGroup = `bsk-document-identity-${crypto.randomUUID()}`;
  const send = <T>(method: string, params: object) => {
    throwIfAborted(signal);
    return sendToCdpTarget<T>(cdp, identity.target, method, params);
  };
  let objectId: string | undefined;
  let retained = false;
  try {
    const world = await send<{ executionContextId: number }>("Page.createIsolatedWorld", {
      frameId: identity.frameId,
      worldName: "bsk-document-identity",
    });
    const serializationOptions = {
      serialization: "deep",
      additionalParameters: { maxNodeDepth: 0, includeShadowTree: "none" },
    };
    type RootReply = {
      result?: { deepSerializedValue?: { type: string; value?: { backendNodeId?: number } } };
    };
    let reply: RootReply;
    if (anchorBackendNodeId === undefined) {
      reply = await send<RootReply>("Runtime.evaluate", {
        expression: "document.documentElement",
        contextId: world.executionContextId,
        objectGroup,
        serializationOptions,
      });
    } else {
      const anchor = await send<{ object?: { objectId?: string } }>("DOM.resolveNode", {
        backendNodeId: anchorBackendNodeId,
        executionContextId: world.executionContextId,
        objectGroup,
      });
      if (!anchor.object?.objectId) return { status: "unavailable" };
      objectId = anchor.object.objectId;
      reply = await send<RootReply>("Runtime.callFunctionOn", {
        objectId: anchor.object.objectId,
        functionDeclaration:
          "function() { return this.isConnected && this.ownerDocument === document ? document.documentElement : null; }",
        objectGroup,
        serializationOptions,
      });
    }
    if (!attached()) return { status: "changed" };
    const root = reply.result?.deepSerializedValue;
    if (root?.type === "null") return { status: "changed" };
    const id = root?.type === "node" ? root.value?.backendNodeId : undefined;
    if (id === undefined) return { status: "unavailable" };
    if (id !== identity.documentElementBackendNodeId) return { status: "changed" };
    throwIfAborted(signal);
    retained = retain && !!objectId;
    return { status: "current", ...(retained ? { objectId, objectGroup } : {}) };
  } catch (error) {
    throwIfAborted(signal);
    if (isAbortError(error)) throw error;
    return { status: attached() ? "unavailable" : "changed" };
  } finally {
    if (!retained)
      await sendToCdpTarget(cdp, identity.target, "Runtime.releaseObjectGroup", {
        objectGroup,
      }).catch(() => {});
    throwIfAborted(signal);
  }
}
