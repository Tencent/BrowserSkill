import type { CdpRunner } from "../shared";
import { sendToCdpTarget } from "../shared";
import { isAbortError, throwIfAborted } from "./capture-abort";
import type { DocumentIdentity } from "./facts";

/** Compare the snapshot root with the current root in that exact frame.
 * Deep serialization supplies the backend ID without a separate describeNode. */
export async function verifyDocumentIdentity(
  cdp: CdpRunner,
  identity: DocumentIdentity,
  signal?: AbortSignal,
): Promise<"current" | "changed" | "unavailable"> {
  const attached = () => cdp.getAttachmentId?.(identity.target.tabId) === identity.attachmentId;
  throwIfAborted(signal);
  if (!attached()) return "changed";
  const objectGroup = `bsk-document-identity-${crypto.randomUUID()}`;
  const send = <T>(method: string, params: object) => {
    throwIfAborted(signal);
    return sendToCdpTarget<T>(cdp, identity.target, method, params);
  };
  try {
    const world = await send<{ executionContextId: number }>("Page.createIsolatedWorld", {
      frameId: identity.frameId,
      worldName: "bsk-document-identity",
    });
    const reply = await send<{
      result?: { deepSerializedValue?: { type: string; value?: { backendNodeId?: number } } };
    }>("Runtime.evaluate", {
      expression: "document.documentElement",
      contextId: world.executionContextId,
      objectGroup,
      serializationOptions: {
        serialization: "deep",
        additionalParameters: { maxNodeDepth: 0, includeShadowTree: "none" },
      },
    });
    if (!attached()) return "changed";
    const root = reply.result?.deepSerializedValue;
    if (root?.type === "null") return "changed";
    const id = root?.type === "node" ? root.value?.backendNodeId : undefined;
    if (id === undefined) return "unavailable";
    return id === identity.documentElementBackendNodeId ? "current" : "changed";
  } catch (error) {
    throwIfAborted(signal);
    if (isAbortError(error)) throw error;
    return attached() ? "unavailable" : "changed";
  } finally {
    await sendToCdpTarget(cdp, identity.target, "Runtime.releaseObjectGroup", {
      objectGroup,
    }).catch(() => {});
    throwIfAborted(signal);
  }
}
