import type { RenderedRef } from "@browser-skill/vom";
import { captureVomObservation } from "@/tools/capture-vom-observation";
import type { CdpRunner, ChromeTabsApi } from "@/tools/shared";
import type { CapturedNode } from "@/tools/vom/capture";

export interface IndexedObservationNode {
  frameId: string;
  node: CapturedNode;
  ref?: RenderedRef;
}

export interface CapturedRecordingObservation {
  rootFrameId: string;
  index: ObservationNodeIndex;
  url: string;
  title?: string;
  vomText: string;
  truncated: boolean;
}

export interface RegisteredObservation {
  stateId: string;
  rootFrameId: string;
  index: ObservationNodeIndex;
  url: string;
}

function nodeKey(frameId: string, backendNodeId: number): string {
  return `${frameId}:${backendNodeId}`;
}

function frameTagKey(frameId: string, tag: string): string {
  return `${frameId}:${tag.toLowerCase()}`;
}

export class ObservationNodeIndex {
  readonly #nodesByFrameTag = new Map<string, IndexedObservationNode[]>();
  readonly #refById = new Map<string, RenderedRef>();
  readonly #refsByFrame = new Map<string, RenderedRef[]>();

  constructor(input: {
    rootFrameId: string;
    frameDocuments: Array<{ frameId: string; domNodes: CapturedNode[] }>;
    refs: RenderedRef[];
  }) {
    const refByNode = new Map<string, RenderedRef>();
    for (const ref of input.refs) {
      const frameId = ref.frameId ?? input.rootFrameId;
      refByNode.set(nodeKey(frameId, ref.backendNodeId), ref);
      this.#refById.set(ref.ref, ref);
      const frameRefs = this.#refsByFrame.get(frameId) ?? [];
      frameRefs.push(ref);
      this.#refsByFrame.set(frameId, frameRefs);
    }
    for (const document of input.frameDocuments) {
      for (const node of document.domNodes) {
        const frameId = node.frameId ?? document.frameId;
        const entry = { frameId, node, ref: refByNode.get(nodeKey(frameId, node.backendNodeId)) };
        const key = frameTagKey(frameId, node.tag);
        const bucket = this.#nodesByFrameTag.get(key) ?? [];
        bucket.push(entry);
        this.#nodesByFrameTag.set(key, bucket);
      }
    }
  }

  candidates(frameId: string, tag: string): readonly IndexedObservationNode[] {
    return this.#nodesByFrameTag.get(frameTagKey(frameId, tag)) ?? [];
  }

  ref(refId: string): RenderedRef | undefined {
    return this.#refById.get(refId);
  }

  refs(frameId: string): readonly RenderedRef[] {
    return this.#refsByFrame.get(frameId) ?? [];
  }
}

async function readTabMeta(
  tabsApi: ChromeTabsApi,
  tabId: number,
): Promise<{ url: string; title?: string }> {
  try {
    const tab = await tabsApi.get(tabId);
    return { url: tab.url ?? "about:blank", title: tab.title };
  } catch {
    return { url: "about:blank" };
  }
}

export async function captureRecordingObservation(input: {
  cdp: CdpRunner;
  tabsApi: ChromeTabsApi;
  tabId: number;
  maxTokens: number;
  redactValues: boolean;
  signal?: AbortSignal;
}): Promise<CapturedRecordingObservation> {
  const { url, title } = await readTabMeta(input.tabsApi, input.tabId);
  const captured = await captureVomObservation(input.cdp, input.tabId, url, {
    maxTokens: input.maxTokens,
    redactValues: input.redactValues,
    conditionalSurfaceProbe: false,
    signal: input.signal,
  });
  return {
    rootFrameId: captured.rootFrameId,
    index: new ObservationNodeIndex(captured),
    url,
    title,
    vomText: captured.text,
    truncated: captured.truncated,
  };
}
