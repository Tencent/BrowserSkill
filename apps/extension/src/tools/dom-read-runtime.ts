import type { CdpFrame } from "@/browser-driver/frame-graph";
import type { CdpRunner } from "./shared";
import { sendToCdpTarget } from "./shared";
import type { DocumentIdentity } from "./vom/facts";
export const SERIALIZATION = {
  serialization: "deep",
  additionalParameters: { maxNodeDepth: 0, includeShadowTree: "none" },
};
interface DeepValue {
  type: string;
  value?: unknown;
}
export interface RuntimeReply {
  result?: { value?: unknown; deepSerializedValue?: DeepValue };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}
function decode(value: DeepValue, depth = 0): unknown {
  if (depth > 32) throw new Error("Extraction serialization exceeded nesting limit");
  if (value.type === "node") return value.value;
  if (value.type === "null" || value.type === "undefined") return null;
  if (value.type === "array")
    return (value.value as DeepValue[]).map((item) => decode(item, depth + 1));
  if (value.type === "object")
    return Object.fromEntries(
      (value.value as [string, DeepValue][]).map(([key, item]) => [key, decode(item, depth + 1)]),
    );
  if (["string", "boolean", "number"].includes(value.type)) return value.value;
  throw new Error(`Unsupported extraction serialization: ${value.type}`);
}
export function unwrap(reply: RuntimeReply): unknown {
  if (reply.exceptionDetails)
    throw new Error(
      reply.exceptionDetails.exception?.description ??
        reply.exceptionDetails.text ??
        "DOM extraction failed",
    );
  return reply.result?.deepSerializedValue
    ? decode(reply.result.deepSerializedValue)
    : reply.result?.value;
}
export async function documentIdentity(
  cdp: CdpRunner,
  frame: CdpFrame,
  attachmentId: string,
  unavailable: () => never = () => {
    throw new Error("Could not establish DOM document identity");
  },
): Promise<{ identity: DocumentIdentity; contextId: number }> {
  const world = await sendToCdpTarget<{ executionContextId: number }>(
    cdp,
    frame.target,
    "Page.createIsolatedWorld",
    {
      frameId: frame.frameId,
      worldName: "bsk-extract",
    },
  );
  const group = `bsk-extract-root-${crypto.randomUUID()}`;
  try {
    const root = unwrap(
      await sendToCdpTarget<RuntimeReply>(cdp, frame.target, "Runtime.evaluate", {
        expression: "document.documentElement",
        contextId: world.executionContextId,
        objectGroup: group,
        serializationOptions: SERIALIZATION,
      }),
    ) as { backendNodeId?: number } | null;
    if (!root?.backendNodeId) unavailable();
    return {
      identity: {
        attachmentId,
        target: frame.target,
        frameId: frame.frameId,
        documentElementBackendNodeId: root.backendNodeId,
      },
      contextId: world.executionContextId,
    };
  } finally {
    await sendToCdpTarget(cdp, frame.target, "Runtime.releaseObjectGroup", {
      objectGroup: group,
    }).catch(() => {});
  }
}
