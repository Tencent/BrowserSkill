import type { Size } from "../geometry";

interface SerializedValue {
  type: string;
  value?: unknown;
}

type Send = <T>(method: string, params: object, cleanup?: boolean) => Promise<T>;

/** Batch only accessible frame owners. Missing/shadow/cross-origin owners keep
 * the existing node-scoped read; no page-wide style columns are requested. */
export async function readSnapshotOwnerSizes(
  send: Send,
  owners: ReadonlySet<number>,
): Promise<Map<number, Size>> {
  const sizes = new Map<number, Size>();
  const objectGroup = `bsk-frame-sizes-${crypto.randomUUID()}`;
  try {
    const reply = await send<{ result?: { deepSerializedValue?: SerializedValue } }>(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const result = [];
          const documents = [document];
          for (let i = 0; i < documents.length && result.length < ${owners.size}; i++) {
            for (const owner of documents[i].querySelectorAll('iframe,frame')) {
              if (result.length >= ${owners.size}) break;
              if (!owner.isConnected) continue;
              const style = getComputedStyle(owner);
              result.push([owner, JSON.stringify({
                width: owner.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
                height: owner.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
              })]);
              try { if (owner.contentDocument) documents.push(owner.contentDocument); } catch {}
            }
          }
          return result;
        })()`,
        objectGroup,
        serializationOptions: {
          serialization: "deep",
          maxDepth: 3,
          additionalParameters: { maxNodeDepth: 0, includeShadowTree: "none" },
        },
      },
    );
    const result = reply.result?.deepSerializedValue;
    if (result?.type !== "array" || !Array.isArray(result.value)) return sizes;
    for (const entry of result.value as SerializedValue[]) {
      if (entry.type !== "array" || !Array.isArray(entry.value)) continue;
      const [node, data] = entry.value as SerializedValue[];
      if (node?.type !== "node" || data?.type !== "string" || typeof data.value !== "string")
        continue;
      const id = (node.value as { backendNodeId?: number } | undefined)?.backendNodeId;
      if (id === undefined || !owners.has(id)) continue;
      try {
        const size = JSON.parse(data.value) as Size;
        if (
          size &&
          Number.isFinite(size.width) &&
          Number.isFinite(size.height) &&
          size.width > 0 &&
          size.height > 0
        )
          sizes.set(id, size);
      } catch {
        /* An invalid entry uses the existing individual read. */
      }
    }
  } finally {
    await send("Runtime.releaseObjectGroup", { objectGroup }, true).catch(() => {});
  }
  return sizes;
}
