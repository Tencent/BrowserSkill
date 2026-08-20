import type { Viewport } from "@browser-skill/vom";
import type { FrameDocument } from "../frame-document";
import {
  frameAxKey,
  frameBackendKey,
  type SemanticAxNode,
  type SemanticFrame,
  type SemanticGraph,
  type SemanticGraphNode,
  type SemanticNodeId,
} from "./types";

export interface BuildSemanticGraphInput {
  documents: FrameDocument<SemanticAxNode>[];
  viewport: Viewport;
  rootFrameId?: string;
  excludedBackendNodeIds?: ReadonlySet<number>;
}

function domNodeId(frameId: string, backendNodeId: number): SemanticNodeId {
  return JSON.stringify([frameId, "dom", backendNodeId]);
}

function axNodeId(frameId: string, nodeId: string): SemanticNodeId {
  return JSON.stringify([frameId, "ax", nodeId]);
}

export function buildSemanticGraph(input: BuildSemanticGraphInput): SemanticGraph {
  const rootFrameId =
    input.rootFrameId ??
    input.documents.find((document) => !document.parentFrameId)?.frameId ??
    input.documents[0]?.frameId ??
    "root";
  const frames = new Map<string, SemanticFrame>();
  const nodes = new Map<SemanticNodeId, SemanticGraphNode>();
  const nodeIdsByFrame = new Map<string, SemanticNodeId[]>();
  const nodeByFrameBackend = new Map<string, SemanticNodeId>();
  const nodeByFrameAx = new Map<string, SemanticNodeId>();

  for (const [frameOrder, document] of input.documents.entries()) {
    frames.set(document.frameId, {
      frameId: document.frameId,
      ...(document.parentFrameId ? { parentFrameId: document.parentFrameId } : {}),
      ...(document.ownerBackendNodeId !== undefined
        ? { ownerBackendNodeId: document.ownerBackendNodeId }
        : {}),
      contextScopeId: document.contextScopeId,
      target: document.target,
      ...(document.url ? { url: document.url } : {}),
      order: frameOrder,
    });

    const frameNodeIds: SemanticNodeId[] = [];
    nodeIdsByFrame.set(document.frameId, frameNodeIds);
    for (const [index, dom] of document.domNodes.entries()) {
      const id = domNodeId(document.frameId, dom.backendNodeId);
      const node: SemanticGraphNode = {
        id,
        frameId: document.frameId,
        backendNodeId: dom.backendNodeId,
        dom,
        sourceOrder: index,
        excluded:
          document.frameId === rootFrameId &&
          input.excludedBackendNodeIds?.has(dom.backendNodeId) === true,
      };
      nodes.set(id, node);
      frameNodeIds.push(id);
      nodeByFrameBackend.set(frameBackendKey(document.frameId, dom.backendNodeId), id);
    }

    for (const [index, ax] of document.axNodes.entries()) {
      const joinedId =
        typeof ax.backendDOMNodeId === "number"
          ? nodeByFrameBackend.get(frameBackendKey(document.frameId, ax.backendDOMNodeId))
          : undefined;
      const id = joinedId ?? axNodeId(document.frameId, ax.nodeId);
      const existing = nodes.get(id);
      if (existing) {
        existing.ax = ax;
        existing.axNodeId = ax.nodeId;
      } else {
        nodes.set(id, {
          id,
          frameId: document.frameId,
          ...(typeof ax.backendDOMNodeId === "number"
            ? { backendNodeId: ax.backendDOMNodeId }
            : {}),
          axNodeId: ax.nodeId,
          ax,
          sourceOrder: document.domNodes.length + index,
          excluded:
            document.frameId === rootFrameId &&
            typeof ax.backendDOMNodeId === "number" &&
            input.excludedBackendNodeIds?.has(ax.backendDOMNodeId) === true,
        });
        frameNodeIds.push(id);
      }
      nodeByFrameAx.set(frameAxKey(document.frameId, ax.nodeId), id);
    }
  }

  for (const document of input.documents) {
    for (const dom of document.domNodes) {
      const id = nodeByFrameBackend.get(frameBackendKey(document.frameId, dom.backendNodeId));
      const node = id ? nodes.get(id) : undefined;
      if (!node || dom.parentBackendNodeId === null) continue;
      node.domParentId = nodeByFrameBackend.get(
        frameBackendKey(document.frameId, dom.parentBackendNodeId),
      );
    }
    for (const ax of document.axNodes) {
      const id = nodeByFrameAx.get(frameAxKey(document.frameId, ax.nodeId));
      const node = id ? nodes.get(id) : undefined;
      if (!node || !ax.parentId) continue;
      node.axParentId = nodeByFrameAx.get(frameAxKey(document.frameId, ax.parentId));
    }
  }

  const axChildren = new Map<SemanticNodeId, SemanticNodeId[]>();
  const excludedQueue: SemanticNodeId[] = [];
  for (const node of nodes.values()) {
    if (node.axParentId) {
      const children = axChildren.get(node.axParentId) ?? [];
      children.push(node.id);
      axChildren.set(node.axParentId, children);
    }
    if (node.excluded) excludedQueue.push(node.id);
  }
  for (let index = 0; index < excludedQueue.length; index += 1) {
    for (const childId of axChildren.get(excludedQueue[index]) ?? []) {
      const child = nodes.get(childId);
      if (!child || child.excluded) continue;
      child.excluded = true;
      excludedQueue.push(childId);
    }
  }

  for (const frame of frames.values()) {
    if (!frame.parentFrameId || frame.ownerBackendNodeId === undefined) continue;
    frame.ownerNodeId = nodeByFrameBackend.get(
      frameBackendKey(frame.parentFrameId, frame.ownerBackendNodeId),
    );
  }

  return {
    viewport: input.viewport,
    rootFrameId,
    frames,
    nodes,
    nodeIdsByFrame,
    nodeByFrameBackend,
  };
}
