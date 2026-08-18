import type { CdpRunner } from "../shared";
import type { CapturedViewModel } from "./capture";
import {
  buildFrameDocuments,
  type FrameAxBatch,
  type FrameDocument,
  type FrameOwnedAxNode,
} from "./frame-document";

export type FrameAxNode = FrameOwnedAxNode;
export type CapturedFrameDocument<T extends FrameAxNode> = FrameDocument<T>;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("observation aborted", "AbortError");
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function capturedFrameIds(captured: CapturedViewModel): string[] {
  const frameIds = new Set<string>();
  if (captured.rootFrameId) frameIds.add(captured.rootFrameId);
  for (const frameId of captured.frameNodes?.keys() ?? []) frameIds.add(frameId);
  if (frameIds.size === 0) frameIds.add("root");
  return [...frameIds];
}

async function captureAxTrees<T extends FrameAxNode>(
  cdp: CdpRunner,
  tabId: number,
  captured: CapturedViewModel,
  signal?: AbortSignal,
): Promise<FrameAxBatch<T>[]> {
  const frameIds = capturedFrameIds(captured);
  let firstFailure: unknown;
  await cdp.send(tabId, "Accessibility.enable", {});
  const trees = await Promise.all(
    frameIds.map(async (frameId): Promise<FrameAxBatch<T>> => {
      try {
        throwIfAborted(signal);
        const result = await cdp.send<{ nodes?: T[] }>(
          tabId,
          "Accessibility.getFullAXTree",
          frameId === "root" ? {} : { frameId },
        );
        throwIfAborted(signal);
        return { frameId, nodes: result.nodes ?? [] };
      } catch (err) {
        if (isAbortError(err)) throw err;
        firstFailure ??= err;
        console.debug("[bsk observation] frame AX capture failed", { frameId, err });
        return { frameId, nodes: [] };
      }
    }),
  );
  const capturedNodeCount = [...captured.iframeNodes.values()].reduce(
    (count, nodes) => count + nodes.length,
    captured.nodes.length,
  );
  if (firstFailure && capturedNodeCount === 0 && trees.every((tree) => tree.nodes.length === 0)) {
    throw firstFailure;
  }
  return trees;
}

export async function captureFrameData<T extends FrameAxNode>(
  cdp: CdpRunner,
  tabId: number,
  captured: CapturedViewModel,
  signal?: AbortSignal,
): Promise<CapturedFrameDocument<T>[]> {
  const batches = await captureAxTrees<T>(cdp, tabId, captured, signal);
  return buildFrameDocuments(batches, captured);
}
