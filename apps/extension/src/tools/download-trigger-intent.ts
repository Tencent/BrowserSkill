import type { ResolvedActionTarget } from "./interaction";
import { type CdpRunner, sendToCdpTarget } from "./shared";

const READ_ANCHOR_INTENT = `function () {
  const anchor = this instanceof Element ? this.closest("a[href]") : null;
  if (!(anchor instanceof HTMLAnchorElement) || anchor.target.toLowerCase() !== "_blank") return null;
  const url = new URL(anchor.href, document.baseURI);
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
}`;

export async function resolveDownloadTriggerUrl(
  cdp: CdpRunner,
  target: ResolvedActionTarget,
): Promise<string | undefined> {
  let objectId: string | undefined;
  try {
    const resolved = await sendToCdpTarget<{ object?: { objectId?: string } }>(
      cdp,
      target.cdpTarget,
      "DOM.resolveNode",
      { backendNodeId: target.backendNodeId },
    );
    objectId = resolved.object?.objectId;
    if (!objectId) return undefined;
    const result = await sendToCdpTarget<{ result?: { value?: unknown } }>(
      cdp,
      target.cdpTarget,
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: READ_ANCHOR_INTENT,
        returnByValue: true,
        silent: true,
      },
    );
    if (typeof result.result?.value !== "string") return undefined;
    const url = new URL(result.result.value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  } finally {
    if (objectId) {
      await sendToCdpTarget(cdp, target.cdpTarget, "Runtime.releaseObject", { objectId }).catch(
        () => {},
      );
    }
  }
}
