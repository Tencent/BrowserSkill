/**
 * Public cross-layer frame/node/event handle types for `browser-driver/`.
 *
 * Invariant: transient OOPIF CDP `sessionId` strings never appear on any type
 * exported from this module. Upper layers address frames, nodes, renderer
 * process boundaries, and CDP event sources exclusively via these handles.
 */

export interface FrameDocumentHandle {
  tabId: number;
  frameId: string;
  loaderId: string;
  documentElementBackendNodeId?: number;
}

export interface FrameNodeHandle {
  tabId: number;
  frameId: string;
  loaderId: string;
  backendNodeId: number;
  documentElementBackendNodeId?: number;
}

/**
 * Discovered document frame metadata without exposing transient CDP `sessionId`.
 * `processKey` identifies the renderer target boundary (`"root"` for the top-level
 * renderer process, `"oopif:<targetRootFrameId>"` for an out-of-process iframe).
 */
export interface FrameDocumentInfo {
  readonly handle: FrameDocumentHandle;
  readonly frameId: string;
  readonly loaderId: string;
  readonly parentFrameId?: string;
  readonly ownerBackendNodeId?: number;
  readonly url?: string;
  readonly urlFragment?: string;
  readonly processKey: string;
  readonly isOutOfProcess: boolean;
}

export interface UnavailableFrameDocument {
  readonly frameId: string;
  readonly parentFrameId?: string;
  readonly url?: string;
  readonly processKey: string;
  readonly isOutOfProcess: boolean;
}

export interface FrameDocumentGraph {
  readonly attachmentId?: string;
  readonly rootFrameId: string;
  readonly frames: FrameDocumentInfo[];
  /** Unavailable subtrees are excluded from routing, but remain visible as gaps. */
  readonly unavailableFrames?: UnavailableFrameDocument[];
}

/**
 * Opaque CDP event source emitted by `ChromiumCdp.onEvent(...)`.
 * Never exposes transient CDP `sessionId`; `ChromiumCdp` maps `targetKey`
 * back to the live target internally.
 */
export interface TabEventSource {
  readonly tabId: number;
  readonly targetKey: string;
  readonly isRootTarget: boolean;
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

export function toRootFrameHandle(tabId: number): FrameDocumentHandle {
  return { tabId, frameId: "", loaderId: "" };
}

export function rootEventSource(tabId: number): TabEventSource {
  return { tabId, targetKey: "root", isRootTarget: true };
}

export function targetEventSource(tabId: number, targetKey = "root"): TabEventSource {
  return { tabId, targetKey, isRootTarget: targetKey === "root" };
}

export function createFrameDocumentInfo(input: {
  tabId: number;
  frameId: string;
  loaderId?: string;
  parentFrameId?: string;
  ownerBackendNodeId?: number;
  url?: string;
  urlFragment?: string;
  processKey?: string;
  isOutOfProcess?: boolean;
  documentElementBackendNodeId?: number;
}): FrameDocumentInfo {
  const loaderId = input.loaderId ?? "";
  const isOutOfProcess =
    input.isOutOfProcess ?? (input.processKey !== undefined && input.processKey !== "root");
  const processKey = input.processKey ?? (isOutOfProcess ? `oopif:${input.frameId}` : "root");
  return {
    handle: toFrameDocumentHandle(
      input.tabId,
      { frameId: input.frameId, loaderId },
      input.documentElementBackendNodeId,
    ),
    frameId: input.frameId,
    loaderId,
    ...(input.parentFrameId ? { parentFrameId: input.parentFrameId } : {}),
    ...(input.ownerBackendNodeId !== undefined
      ? { ownerBackendNodeId: input.ownerBackendNodeId }
      : {}),
    ...(input.url ? { url: input.url } : {}),
    ...(input.urlFragment !== undefined ? { urlFragment: input.urlFragment } : {}),
    processKey,
    isOutOfProcess,
  };
}

/**
 * Renderer process boundary without exposing transient OOPIF `sessionId`.
 * `processKey` is `"root"` for the top-level renderer process or
 * `"oopif:<targetRootFrameId>"` for an out-of-process iframe target.
 */
export interface FrameProcessBoundary {
  readonly tabId: number;
  readonly processKey: string;
  readonly isOutOfProcess: boolean;
  readonly rootHandle: FrameDocumentHandle;
}

export function rootProcessBoundary(tabId: number): FrameProcessBoundary {
  return {
    tabId,
    processKey: "root",
    isOutOfProcess: false,
    rootHandle: toRootFrameHandle(tabId),
  };
}

export function frameProcessBoundary(frame: FrameDocumentInfo): FrameProcessBoundary {
  const { tabId } = frame.handle;
  if (!frame.isOutOfProcess || frame.processKey === "root") {
    return rootProcessBoundary(tabId);
  }
  return {
    tabId,
    processKey: frame.processKey,
    isOutOfProcess: true,
    rootHandle: {
      tabId,
      frameId: frame.frameId,
      loaderId: frame.loaderId,
    },
  };
}

export function frameProcessIdentityKey(input: { tabId: number; processKey: string }): string {
  return `${input.tabId}:${input.processKey}`;
}

export function omitFrameDocumentSubtrees(
  graph: Pick<FrameDocumentGraph, "rootFrameId" | "frames" | "attachmentId">,
  unavailable: ReadonlyMap<string, UnavailableFrameDocument>,
): FrameDocumentGraph {
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
  const omitted = new Map<string, UnavailableFrameDocument>(
    graph.frames
      .filter((frame) => blocked.has(frame.frameId))
      .map((frame) => [
        frame.frameId,
        {
          frameId: frame.frameId,
          ...(frame.parentFrameId ? { parentFrameId: frame.parentFrameId } : {}),
          ...(frame.url ? { url: frame.url } : {}),
          processKey: frame.processKey,
          isOutOfProcess: frame.isOutOfProcess,
        },
      ]),
  );
  for (const [frameId, info] of unavailable) {
    const existing = omitted.get(frameId);
    omitted.set(frameId, { ...existing, ...info, frameId });
  }
  return {
    ...graph,
    frames: graph.frames.filter((frame) => !blocked.has(frame.frameId)),
    unavailableFrames: [...omitted.values()],
  };
}
