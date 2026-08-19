import type { Rect, RenderedRef, VomResult } from "@browser-skill/vom";
import type { CdpTarget } from "@/browser-driver/frame-graph";
import { readRecordingDocumentIdentity } from "@/shared/recording-document-identity";
import type { CapturedSurfaceProbe } from "./capture";
import type { CapturedFrameDocument, FrameAxNode } from "./frame-capture";

/** Frame identity needed to resolve an `@eN` that lives in an iframe. */
export interface CaptureVomFrame {
  frameId: string;
  target: CdpTarget;
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
}

function projectFrames(documents: CapturedFrameDocument<FrameAxNode>[]): CaptureVomFrame[] {
  return documents.map((document) => {
    const recordingDocumentId = document.domNodes
      .map((node) => readRecordingDocumentIdentity(node.attrs))
      .find((identity) => identity !== undefined);
    return {
      frameId: document.frameId,
      target: document.target,
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
  rendered: VomResult;
  surfaceProbes?: CapturedSurfaceProbe[];
}): CaptureVomObservationResult {
  return {
    text: input.rendered.text,
    refs: input.rendered.refs,
    truncated: input.rendered.truncated,
    rootFrameId: input.rootFrameId,
    frames: projectFrames(input.frameDocuments),
    matchNodes: projectMatchNodes(input.frameDocuments),
    surfaceProbes: input.surfaceProbes,
  };
}
