import type { Viewport } from "@browser-skill/vom";
import type { CdpFrame, CdpTarget } from "@/browser-driver/frame-graph";
import { isOverlayHostNode } from "@/lib/overlay-bridge";
import type { GeometryProjection } from "../geometry";
import type { FrameProjectionIssue, SnapshotCoordinates } from "../geometry/coordinate-types";
import { createCaptureCheckpoint } from "./capture-abort";
import type { CapturedNode } from "./capture-types";
import type { FrameOwnedAxNode } from "./frame-document";

/** Bounds retain their raw snapshot document layout units until normalization. */
export interface SnapshotLayout {
  readonly boundsSpace: "snapshot-document-layout";
  bounds?: number[];
  /** [clientLeft, clientTop, clientWidth, clientHeight], untransformed local CSS units. */
  clientRect?: number[];
  styles: Readonly<Record<string, string>>;
}

export interface DecodedNode extends Omit<CapturedNode, "rect" | "localRect" | "rendered"> {
  nodeType?: number;
  parentMissing?: boolean;
  layout?: SnapshotLayout;
}

export interface NodeFacts extends CapturedNode {
  nodeType?: number;
  parentMissing?: boolean;
  layout?: SnapshotLayout;
}

export interface DocumentIndex<T extends DecodedNode = NodeFacts> {
  readonly nodes: ReadonlyMap<number, T>;
  readonly ancestryComplete?: ReadonlyMap<number, boolean>;
  readonly excludedBackendNodeIds: ReadonlySet<number>;
}

export interface DecodedDocument {
  nodes: DecodedNode[];
}

/** All snapshot nodes participate, including document and shadow roots. This
 * preserves overlay propagation when the semantic adapter omits those nodes. */
export async function buildDocumentIndex<T extends DecodedNode>(
  input: readonly T[],
  signal?: AbortSignal,
  includeVisualFacts = false,
): Promise<DocumentIndex<T>> {
  const checkpoint = createCaptureCheckpoint(signal);
  const nodes = new Map<number, T>();
  const overlayByNode = new Map<number, boolean>();
  const ancestryComplete = includeVisualFacts ? new Map<number, boolean>() : undefined;
  const excludedBackendNodeIds = new Set<number>();
  for (let i = 0; i < input.length; i++) {
    if (i % 256 === 0) {
      const pending = checkpoint();
      if (pending) await pending;
    }
    const node = input[i];
    nodes.set(node.backendNodeId, node);
  }
  let work = 0;
  for (const node of input) {
    if (work++ % 256 === 0) {
      const pending = checkpoint();
      if (pending) await pending;
    }
    if (overlayByNode.has(node.backendNodeId)) continue;
    const path: DecodedNode[] = [];
    const visiting = new Set<number>();
    let current: DecodedNode | undefined = node;
    let overlay = false;
    let complete = false;
    while (current && !overlayByNode.has(current.backendNodeId)) {
      if (work++ % 256 === 0) {
        const pending = checkpoint();
        if (pending) await pending;
      }
      if (visiting.has(current.backendNodeId)) {
        // Only an overlay inside the cycle may mark the cycle and its descendants.
        overlay = path
          .slice(path.findIndex((item) => item.backendNodeId === current!.backendNodeId))
          .some((item) => isOverlayHostNode(item.tag, Object.keys(item.attrs)));
        break;
      }
      visiting.add(current.backendNodeId);
      path.push(current);
      if (current.parentBackendNodeId === null) {
        if (ancestryComplete) complete = !current.parentMissing && current.nodeType === 9;
        current = undefined;
        break;
      }
      current = nodes.get(current.parentBackendNodeId);
    }
    if (current && overlayByNode.has(current.backendNodeId)) {
      overlay = overlayByNode.get(current.backendNodeId)!;
      if (ancestryComplete) complete = ancestryComplete.get(current.backendNodeId) === true;
    }
    for (let i = path.length - 1; i >= 0; i--) {
      if (work++ % 256 === 0) {
        const pending = checkpoint();
        if (pending) await pending;
      }
      const item = path[i];
      overlay = overlay || isOverlayHostNode(item.tag, Object.keys(item.attrs));
      overlayByNode.set(item.backendNodeId, overlay);
      if (ancestryComplete) {
        complete = complete && !item.parentMissing;
        ancestryComplete.set(item.backendNodeId, complete);
      }
      if (overlay) excludedBackendNodeIds.add(item.backendNodeId);
    }
  }
  return { nodes, ...(ancestryComplete ? { ancestryComplete } : {}), excludedBackendNodeIds };
}

export interface DocumentIdentity {
  attachmentId: string;
  target: CdpTarget;
  frameId: string;
  documentElementBackendNodeId: number;
}

/** Narrow input shared by the existing semantic scene/hover consumers. */
export interface CapturedSceneInput {
  nodes: CapturedNode[];
  viewport: Viewport;
  rootFrameId?: string;
  excludedBackendNodeIds: ReadonlySet<number>;
}

export interface CaptureIssue {
  /** Owner failure or inherited blockage; absent for other geometry failures. */
  projectionIssue?: FrameProjectionIssue;
  target: CdpTarget;
  frameId?: string;
  stage: "dom" | "ax" | "identity" | "ownership" | "geometry" | "forms";
  reason:
    | "document-changed"
    | "identity-unavailable"
    | "identity-unverified"
    | "capture-unavailable"
    | "frame-ownership-unresolved"
    | "geometry-unavailable";
}

/** Shared per document; never retain the live GeometryContext in published facts. */
export interface DocumentGeometry {
  readonly projections: readonly GeometryProjection[];
  readonly coordinates: SnapshotCoordinates;
  /** Visual viewport scale (pinch), distinct from browser UI zoom. */
  readonly pageScale?: number;
}

export interface DocumentFacts<T extends FrameOwnedAxNode> {
  readonly geometry?: DocumentGeometry;
  readonly frame: CdpFrame;
  readonly identity?: DocumentIdentity;
  readonly index: DocumentIndex;
  readonly domNodes: CapturedNode[];
  readonly axNodes: T[];
}

export interface ObservationFacts<T extends FrameOwnedAxNode> {
  /** Whether visual collection was enabled; partial capture failures remain in issues. */
  readonly visualFactsCollected: boolean;
  readonly rootFrameId: string;
  readonly viewport: Viewport;
  readonly documents: readonly DocumentFacts<T>[];
  readonly issues: readonly CaptureIssue[];
  readonly startedAt: number;
  readonly finishedAt: number;
}

export interface CapturedSurfaceProbe {
  triggerBackendNodeId: number;
  triggerPoint?: { x: number; y: number };
  triggerAction: "hover" | "focus" | string;
  subItems: string[];
  confidence?: "high" | "medium" | "low";
}

export type { CapturedNode } from "./capture-types";
