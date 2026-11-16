export interface CdpTarget {
  tabId: number;
  sessionId?: string;
}

/**
 * Stable cross-layer document/frame addressing handle.
 * Never carries transient CDP `sessionId`; `ChromiumCdp` resolves `frameId` to
 * its live session internally and validates `loaderId` (+ optional `documentElementBackendNodeId`).
 */
export interface FrameDocumentHandle {
  tabId: number;
  frameId: string;
  loaderId: string;
  documentElementBackendNodeId?: number;
}

/**
 * Stable cross-layer DOM node addressing handle.
 * Never carries transient CDP `sessionId`; `ChromiumCdp` routes and validates
 * `frameId` + `loaderId` (+ optional `documentElementBackendNodeId`) internally.
 */
export interface FrameNodeHandle {
  tabId: number;
  frameId: string;
  loaderId: string;
  backendNodeId: number;
  documentElementBackendNodeId?: number;
}

export class StaleFrameHandleError extends Error {
  readonly tabId: number;
  readonly frameId: string;

  constructor(handle: { tabId: number; frameId: string }, detail?: string);
  constructor(tabId: number, frameId: string, detail?: string);
  constructor(
    tabOrHandle: number | { tabId: number; frameId: string },
    frameOrDetail?: string,
    maybeDetail?: string,
  ) {
    const tabId = typeof tabOrHandle === "number" ? tabOrHandle : tabOrHandle.tabId;
    const frameId = typeof tabOrHandle === "number" ? (frameOrDetail ?? "") : tabOrHandle.frameId;
    const detail = typeof tabOrHandle === "number" ? maybeDetail : frameOrDetail;
    super(detail ?? `Frame ${frameId} in tab ${tabId} changed or is no longer available`);
    this.name = "StaleFrameHandleError";
    this.tabId = tabId;
    this.frameId = frameId;
  }
}

export function isStaleFrameHandleError(error: unknown): error is StaleFrameHandleError {
  return error instanceof StaleFrameHandleError;
}

export function toFrameDocumentHandle(
  tabId: number,
  frame: { frameId: string; loaderId?: string },
  documentElementBackendNodeId?: number,
): FrameDocumentHandle {
  return {
    tabId,
    frameId: frame.frameId,
    loaderId: frame.loaderId ?? "",
    ...(documentElementBackendNodeId !== undefined ? { documentElementBackendNodeId } : {}),
  };
}

export interface CdpFrame {
  frameId: string;
  loaderId?: string;
  parentFrameId?: string;
  ownerBackendNodeId?: number;
  url?: string;
  urlFragment?: string;
  target: CdpTarget;
}

export interface CdpFrameGraph {
  rootFrameId: string;
  frames: CdpFrame[];
  /** Unavailable subtrees are excluded from routing, but remain visible as gaps. */
  unavailableFrames?: CdpFrame[];
}

export function omitFrameSubtrees(
  graph: CdpFrameGraph,
  unavailable: ReadonlyMap<string, CdpTarget>,
): CdpFrameGraph {
  if (!unavailable.size) return graph;
  const blocked = new Set(unavailable.keys());
  const children = new Map<string, string[]>();
  for (const frame of graph.frames) {
    if (!frame.parentFrameId) continue;
    const siblings = children.get(frame.parentFrameId) ?? [];
    siblings.push(frame.frameId);
    children.set(frame.parentFrameId, siblings);
  }
  const queue = [...blocked];
  for (let i = 0; i < queue.length; i++) {
    for (const child of children.get(queue[i]) ?? []) {
      if (blocked.has(child)) continue;
      blocked.add(child);
      queue.push(child);
    }
  }
  const omitted = new Map(
    graph.frames
      .filter((frame) => blocked.has(frame.frameId))
      .map((frame) => [frame.frameId, frame]),
  );
  for (const [frameId, target] of unavailable)
    omitted.set(frameId, { ...omitted.get(frameId), frameId, target });
  return {
    ...graph,
    frames: graph.frames.filter((frame) => !blocked.has(frame.frameId)),
    unavailableFrames: [...omitted.values()],
  };
}

export interface CdpFrameTreeNode {
  frame: {
    id: string;
    parentId?: string;
    loaderId?: string;
    url?: string;
    urlFragment?: string;
  };
  childFrames?: CdpFrameTreeNode[];
}

export interface CdpFrameTreeSource {
  target: CdpTarget;
  tree: CdpFrameTreeNode;
}

export function cdpTargetKey(target: CdpTarget): string {
  return `${target.tabId}:${target.sessionId ?? "root"}`;
}

function mergeFrame(
  frames: Map<string, CdpFrame>,
  order: string[],
  node: CdpFrameTreeNode,
  target: CdpTarget,
  authoritative: boolean,
): void {
  const existing = frames.get(node.frame.id);
  if (!existing) order.push(node.frame.id);
  const parentFrameId = node.frame.parentId || existing?.parentFrameId;
  const loaderId = authoritative
    ? node.frame.loaderId || existing?.loaderId
    : existing?.loaderId || node.frame.loaderId;
  const url = authoritative ? node.frame.url || existing?.url : existing?.url || node.frame.url;
  const urlFragment = authoritative
    ? (node.frame.urlFragment ?? existing?.urlFragment)
    : (existing?.urlFragment ?? node.frame.urlFragment);
  frames.set(node.frame.id, {
    frameId: node.frame.id,
    ...(loaderId !== undefined ? { loaderId } : {}),
    ...(parentFrameId ? { parentFrameId } : {}),
    ...(url ? { url } : {}),
    ...(urlFragment !== undefined ? { urlFragment } : {}),
    target,
  });
}

function walkFrameTree(
  source: CdpFrameTreeSource,
  targetByRootFrameId: ReadonlyMap<string, CdpTarget>,
  frames: Map<string, CdpFrame>,
  order: string[],
): void {
  const stack: Array<{ node: CdpFrameTreeNode; inheritedTarget: CdpTarget }> = [
    { node: source.tree, inheritedTarget: source.target },
  ];
  const expanded = new WeakSet<CdpFrameTreeNode>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || expanded.has(current.node)) continue;
    expanded.add(current.node);

    const target = targetByRootFrameId.get(current.node.frame.id) ?? current.inheritedTarget;
    const authoritative =
      target.sessionId === source.target.sessionId && target.tabId === source.target.tabId;
    mergeFrame(frames, order, current.node, target, authoritative);

    const children = current.node.childFrames ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index], inheritedTarget: target });
    }
  }
}

export function buildFrameGraph(sources: readonly CdpFrameTreeSource[]): CdpFrameGraph | null {
  const rootSource = sources.find((source) => source.target.sessionId === undefined) ?? sources[0];
  if (!rootSource) return null;

  const frames = new Map<string, CdpFrame>();
  const order: string[] = [];
  const targetByRootFrameId = new Map(
    sources.map((source) => [source.tree.frame.id, source.target] as const),
  );
  // The top-level source is authoritative if malformed input reports the same
  // frame as both a root target and a child target.
  targetByRootFrameId.set(rootSource.tree.frame.id, rootSource.target);

  walkFrameTree(rootSource, targetByRootFrameId, frames, order);
  for (const source of sources) {
    if (source === rootSource) continue;
    walkFrameTree(source, targetByRootFrameId, frames, order);
  }

  return {
    rootFrameId: rootSource.tree.frame.id,
    frames: order.flatMap((frameId) => {
      const frame = frames.get(frameId);
      return frame ? [frame] : [];
    }),
  };
}
