import { type CdpTarget } from "@/browser-driver/frame-graph";
import type { ViewportRect } from "../geometry";
import { createCaptureCheckpoint } from "./capture-abort";
import type {
  CaptureIssue,
  DocumentFacts,
  DocumentIdentity,
  NodeFacts,
  ObservationFacts,
} from "./facts";
import type { FrameOwnedAxNode } from "./frame-document";
import {
  EMPTY_VISUAL_CONTEXT,
  extendVisualContext,
  projectVisualBox,
  resolveVisualRegion,
  type VisualContext,
  type VisualIssueReason,
  type VisualRegionResult,
  visualProjectionIssue,
} from "./visual-region";

export interface VisualCandidate {
  readonly document: DocumentIdentity;
  readonly backendNodeId: number;
  readonly parentBackendNodeId: number | null;
  readonly label?: string;
  readonly region: Extract<VisualRegionResult, { status: "available" }>;
}

export interface VisualDiscoveryIssue {
  readonly target: CdpTarget;
  readonly frameId: string;
  readonly backendNodeId?: number;
  readonly reason: VisualIssueReason;
}

export interface VisualDiscoveryResult {
  readonly candidates: readonly VisualCandidate[];
  readonly issues: readonly VisualDiscoveryIssue[];
  /** Preserve upstream failures, including those that do not invalidate Canvas geometry. */
  readonly captureIssues: readonly CaptureIssue[];
  readonly complete: boolean;
}

type Document = DocumentFacts<FrameOwnedAxNode>;
interface NodeContext {
  self: VisualContext;
  children: VisualContext;
}

function viewportRect(
  rect: { x: number; y: number; w: number; h: number } | null | undefined,
): ViewportRect | null {
  return rect ? { x: rect.x, y: rect.y, width: rect.w, height: rect.h } : null;
}

/** Client offsets are unscaled local CSS units. Only ordinary, untransformed
 * overflow chains consume this adapter; other combinations are rejected by policy. */
function clientBox(node: NodeFacts, document: Document): ViewportRect | null {
  const client = node.layout?.clientRect;
  const bounds = node.layout?.bounds;
  const border =
    node.localRect ??
    (bounds?.length === 4 && bounds.every(Number.isFinite) && document.geometry
      ? {
          x:
            bounds[0] / document.geometry.coordinates.layoutUnitsPerCssPixel -
            document.geometry.coordinates.scrollCss.x,
          y:
            bounds[1] / document.geometry.coordinates.layoutUnitsPerCssPixel -
            document.geometry.coordinates.scrollCss.y,
        }
      : null);
  if (
    !client ||
    client.length !== 4 ||
    !client.every(Number.isFinite) ||
    client[2] < 0 ||
    client[3] < 0 ||
    !border ||
    !document.geometry
  )
    return null;
  return projectVisualBox(
    { x: border.x + client[0], y: border.y + client[1], width: client[2], height: client[3] },
    document.geometry.projections,
  );
}

/** Pure Facts consumer: no CDP, ref registration, selection, or semantic keep/drop.
 * Both frame and node ancestry are memoized in this call, using iterative walks. */
export async function discoverVisualCandidates(
  facts: ObservationFacts<FrameOwnedAxNode>,
  signal?: AbortSignal,
): Promise<VisualDiscoveryResult> {
  const checkpoint = createCaptureCheckpoint(signal);
  let work = 0;
  const candidates: VisualCandidate[] = [];
  const issues: VisualDiscoveryIssue[] = [];
  const documents = new Map(facts.documents.map((document) => [document.frame.frameId, document]));
  const contexts = new Map<string, Map<number, NodeContext>>();
  const roots = new Map<string, VisualContext>();

  async function nodeContext(document: Document, id: number): Promise<NodeContext> {
    const cache = contexts.get(document.frame.frameId)!;
    const path: NodeFacts[] = [];
    let node = document.index.nodes.get(id);
    while (node && !cache.has(node.backendNodeId)) {
      if (work++ % 256 === 0) {
        const pending = checkpoint();
        if (pending) await pending;
      }
      if (
        !document.index.ancestryComplete.get(node.backendNodeId) ||
        path.length >= document.index.nodes.size
      ) {
        const incomplete = {
          ...roots.get(document.frame.frameId)!,
          issue: roots.get(document.frame.frameId)!.issue ?? ("ancestry-incomplete" as const),
        };
        cache.set(node.backendNodeId, { self: incomplete, children: incomplete });
        break;
      }
      path.push(node);
      node =
        node.parentBackendNodeId === null
          ? undefined
          : document.index.nodes.get(node.parentBackendNodeId);
    }
    let parent = node
      ? cache.get(node.backendNodeId)!.children
      : roots.get(document.frame.frameId)!;
    for (let i = path.length - 1; i >= 0; i--) {
      if (work++ % 256 === 0) {
        const pending = checkpoint();
        if (pending) await pending;
      }
      const current = path[i];
      let self = parent;
      let children = parent;
      if (document.index.excludedBackendNodeIds.has(current.backendNodeId)) {
        self = children = { ...parent, hidden: true };
      } else if (current.nodeType === 1) {
        if (!current.layout) {
          // An element without layout is not evidence that descendants are hidden
          // (e.g. a boxless ancestor). Keep the missing style evidence explicit.
          self = children = { ...parent, issue: parent.issue ?? "facts-unavailable" };
        } else if (document.identity) {
          const ancestor = {
            document: document.identity,
            backendNodeId: current.backendNodeId,
            styles: current.layout.styles,
            clientBox: clientBox(current, document),
          };
          children = extendVisualContext(
            parent,
            ancestor,
            current.tag !== "iframe" && current.tag !== "frame",
          );
          self = current.tag === "canvas" ? extendVisualContext(parent, ancestor, false) : children;
        }
      }
      const result = { self, children };
      cache.set(current.backendNodeId, result);
      parent = children;
    }
    return (
      cache.get(id) ?? {
        self: { ...parent, issue: "ancestry-incomplete" },
        children: { ...parent, issue: "ancestry-incomplete" },
      }
    );
  }

  // Process parent documents first, independent of snapshot/target completion order.
  for (const document of facts.documents) {
    const path: Document[] = [];
    const visiting = new Set<string>();
    let current: Document | undefined = document;
    while (current && !roots.has(current.frame.frameId)) {
      if (work++ % 256 === 0) {
        const pending = checkpoint();
        if (pending) await pending;
      }
      if (visiting.has(current.frame.frameId)) {
        roots.set(current.frame.frameId, {
          ...EMPTY_VISUAL_CONTEXT,
          issue: "ownership-unresolved",
        });
        contexts.set(current.frame.frameId, new Map());
        break;
      }
      visiting.add(current.frame.frameId);
      path.push(current);
      current = current.frame.parentFrameId
        ? documents.get(current.frame.parentFrameId)
        : undefined;
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const doc = path[i];
      const { frame } = doc;
      let root: VisualContext = roots.get(frame.frameId) ?? EMPTY_VISUAL_CONTEXT;
      if (frame.parentFrameId) {
        const parent = documents.get(frame.parentFrameId);
        if (
          !parent ||
          !roots.has(parent.frame.frameId) ||
          frame.ownerBackendNodeId === undefined ||
          !parent.identity
        ) {
          root = { ...root, issue: "ownership-unresolved" };
        } else {
          const owner = parent.index.nodes.get(frame.ownerBackendNodeId);
          const ownerState = await nodeContext(parent, frame.ownerBackendNodeId);
          root = {
            ...ownerState.children,
            // CSS visibility inside a child document cannot override its hidden owner.
            hidden:
              ownerState.children.hidden ||
              owner?.layout?.styles.visibility === "hidden" ||
              owner?.layout?.styles.visibility === "collapse",
            // Frame scaling is already interpreted by the shared content-quad projection.
            transformed: false,
            localClip: false,
            unpositionedClip: false,
          };
        }
      } else if (frame.frameId !== facts.rootFrameId)
        root = { ...root, issue: "ownership-unresolved" };
      root = {
        ...root,
        issue:
          root.issue ??
          (!doc.identity ? "identity-unverified" : visualProjectionIssue(doc.geometry)),
      };
      roots.set(frame.frameId, root);
      contexts.set(frame.frameId, new Map());
    }
  }

  for (const document of facts.documents) {
    for (const node of document.index.nodes.values()) {
      if (work++ % 256 === 0) {
        const pending = checkpoint();
        if (pending) await pending;
      }
      if (node.tag !== "canvas" || document.index.excludedBackendNodeIds.has(node.backendNodeId))
        continue;
      // No layout/zero size is positive evidence of no screenshot area for this node.
      if (!node.layout) continue;
      const bounds = node.layout.bounds;
      if (
        bounds?.length === 4 &&
        bounds.every(Number.isFinite) &&
        (bounds[2] <= 0 || bounds[3] <= 0)
      )
        continue;
      const context = (await nodeContext(document, node.backendNodeId)).self;
      const local = viewportRect(node.localRect);
      const borderBox =
        local && document.geometry ? projectVisualBox(local, document.geometry.projections) : null;
      const region = resolveVisualRegion({
        borderBox,
        frameVisibleBox: viewportRect(node.rect),
        context,
        visibility: node.layout.styles.visibility,
      });
      if (region.status === "unavailable") {
        issues.push({
          target: document.frame.target,
          frameId: document.frame.frameId,
          backendNodeId: node.backendNodeId,
          reason: region.reason,
        });
      } else if (region.status === "available" && document.identity) {
        const label = node.attrs["aria-label"]?.trim() || node.attrs.title?.trim();
        candidates.push({
          document: document.identity,
          backendNodeId: node.backendNodeId,
          parentBackendNodeId: node.parentBackendNodeId,
          ...(label ? { label } : {}),
          region,
        });
      }
    }
  }
  // AX-only/missing documents have no Canvas nodes to carry the missing evidence.
  const reportedFrames = new Set(issues.map((issue) => issue.frameId));
  for (const document of facts.documents) {
    const reason = roots.get(document.frame.frameId)?.issue;
    if (
      reason &&
      !reportedFrames.has(document.frame.frameId) &&
      (!document.identity || !document.index.nodes.size)
    )
      issues.push({ target: document.frame.target, frameId: document.frame.frameId, reason });
  }
  const pending = checkpoint();
  if (pending) await pending;
  return {
    candidates,
    issues,
    captureIssues: facts.issues,
    complete: issues.length === 0 && facts.issues.length === 0,
  };
}
