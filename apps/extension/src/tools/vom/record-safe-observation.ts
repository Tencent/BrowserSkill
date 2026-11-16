import type { Rect, RenderedRef, VomResult } from "@browser-skill/vom";
import type { FrameDocumentHandle } from "@/browser-driver/frame-graph";
import { readRecordingDocumentIdentity } from "@/shared/recording-document-identity";
import type { CapturedSurfaceProbe } from "./capture";
import type {
  FrameDocument as CapturedFrameDocument,
  FrameOwnedAxNode as FrameAxNode,
} from "./frame-document";

/** Frame identity needed to resolve an `@eN` that lives in an iframe. */
export interface CaptureVomFrame {
  frameId: string;
  handle: FrameDocumentHandle;
  parentFrameId?: string;
  ownerBackendNodeId?: number;
  /** BrowserSkill-generated identity for the recording agent in this Document. */
  recordingDocumentId?: string;
}

/** Allowlisted geometry used to match a recorded action to a rendered ref. */
export interface CaptureVomMatchNode {
  frameId: string;
  backendNodeId: number;
  tag: string;
  /** Top-level viewport-relative geometry. */
  rect: Rect | null;
  /** Frame-local viewport-relative geometry, when available. */
  localRect?: Rect | null;
}

/**
 * Raw AX/DOM trees are never returned. When `redactValues` is enabled by the
 * caller, form values in `text` are masked as well.
 */
export interface CaptureVomObservationResult {
  text: string;
  refs: RenderedRef[];
  truncated: boolean;
  rootFrameId: string;
  frames: CaptureVomFrame[];
  matchNodes: CaptureVomMatchNode[];
  surfaceProbes?: CapturedSurfaceProbe[];
  /**
   * Whether this observation actively hovered the page, and whether that
   * revealed content the static tree does not contain. Lets callers judge how
   * far the page may have drifted from the returned snapshot.
   */
  hoverProbe?: HoverProbeReport;
}

export interface HoverProbeReport {
  performed: boolean;
  revealedContent: boolean;
}

function projectFrames(
  documents: CapturedFrameDocument<FrameAxNode>[],
  identities?: ReadonlyMap<string, { documentElementBackendNodeId: number }>,
): CaptureVomFrame[] {
  return documents.map((document) => {
    let recordingDocumentId: string | undefined;
    for (const node of document.domNodes) {
      recordingDocumentId = readRecordingDocumentIdentity(node.attrs);
      if (recordingDocumentId) break;
    }
    const documentElementBackendNodeId = identities?.get(
      document.frameId,
    )?.documentElementBackendNodeId;
    return {
      frameId: document.frameId,
      handle: {
        tabId: document.target.tabId,
        frameId: document.frameId,
        loaderId: document.loaderId ?? "",
        ...(documentElementBackendNodeId !== undefined ? { documentElementBackendNodeId } : {}),
      },
      ...(document.parentFrameId ? { parentFrameId: document.parentFrameId } : {}),
      ...(document.ownerBackendNodeId !== undefined
        ? { ownerBackendNodeId: document.ownerBackendNodeId }
        : {}),
      ...(recordingDocumentId ? { recordingDocumentId } : {}),
    };
  });
}

function projectMatchNodes(documents: CapturedFrameDocument<FrameAxNode>[]): CaptureVomMatchNode[] {
  return documents.flatMap((document) =>
    document.domNodes.map((node) => ({
      frameId: document.frameId,
      backendNodeId: node.backendNodeId,
      tag: node.tag,
      rect: node.rect,
      ...(node.localRect !== undefined ? { localRect: node.localRect } : {}),
    })),
  );
}

export function projectRecordSafeObservation(input: {
  rootFrameId: string;
  frameDocuments: CapturedFrameDocument<FrameAxNode>[];
  identities?: ReadonlyMap<string, { documentElementBackendNodeId: number }>;
  rendered: VomResult;
  surfaceProbes?: CapturedSurfaceProbe[];
  hoverProbe?: HoverProbeReport;
}): CaptureVomObservationResult {
  return {
    text: input.rendered.text,
    refs: input.rendered.refs,
    truncated: input.rendered.truncated,
    rootFrameId: input.rootFrameId,
    frames: projectFrames(input.frameDocuments, input.identities),
    matchNodes: projectMatchNodes(input.frameDocuments),
    surfaceProbes: input.surfaceProbes,
    ...(input.hoverProbe ? { hoverProbe: input.hoverProbe } : {}),
  };
}
