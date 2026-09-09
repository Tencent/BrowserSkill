import { type CdpFrame, type CdpTarget, cdpTargetKey } from "@/browser-driver/frame-graph";
import { createCaptureCheckpoint } from "./capture-abort";
import type { CapturedNode } from "./capture-types";
import type { DecodedDocument, DecodedNode } from "./facts";
export const REQUESTED_STYLES = [
  "position",
  "pointer-events",
  "cursor",
  "visibility",
  "opacity",
] as const;
export const VISUAL_STYLES = [
  ...REQUESTED_STYLES,
  "display",
  "overflow-x",
  "overflow-y",
  "transform",
  "zoom",
  "clip-path",
  "mask-image",
  "rotate",
  "scale",
  "perspective",
  "clip",
  "contain",
  "overflow-clip-margin",
] as const;

/** The same profile owns request columns, decoding and visual-only derived facts. */
export const BASIC_SNAPSHOT = {
  includeVisualFacts: false,
  computedStyles: REQUESTED_STYLES,
} as const;
export const VISUAL_SNAPSHOT = { includeVisualFacts: true, computedStyles: VISUAL_STYLES } as const;
export type SnapshotProfile = typeof BASIC_SNAPSHOT | typeof VISUAL_SNAPSHOT;
/** Sparse array format Chrome uses for infrequently-set per-node fields. */
interface SparseArray {
  index: number[];
  value: number[];
}

interface RareBooleanData {
  index: number[];
}

export interface SnapshotDocument {
  frameId?: string | number;
  documentURL?: number;
  scrollOffsetX?: number;
  scrollOffsetY?: number;
  nodes?: {
    parentIndex?: number[];
    nodeName?: number[];
    nodeType?: number[];
    backendNodeId?: number[];
    attributes?: number[][];
    /**
     * Per-node text value (index into strings), set for `#text` / CDATA nodes.
     * Element nodes carry -1. Same length as `backendNodeId`.
     */
    nodeValue?: number[];
    /** Maps node array index → index into `documents[]` for frame content. */
    contentDocumentIndex?: SparseArray;
    inputValue?: SparseArray;
    textValue?: SparseArray;
    inputChecked?: RareBooleanData;
    optionSelected?: RareBooleanData;
  };
  layout?: {
    nodeIndex?: number[];
    styles?: number[][];
    bounds?: number[][];
    clientRects?: number[][];
    paintOrders?: number[];
  };
}

export function snapshotFrameId(document: SnapshotDocument, strings: string[]): string | undefined {
  if (typeof document.frameId === "string") return document.frameId || undefined;
  if (typeof document.frameId === "number") return str(strings, document.frameId) || undefined;
  return undefined;
}

export interface SnapshotReply {
  strings?: string[];
  documents?: SnapshotDocument[];
}

function isSensitiveFormControl(node: Pick<CapturedNode, "tag" | "attrs">): boolean {
  return node.tag === "input" && (node.attrs.type ?? "").toLowerCase() === "password";
}

function snapshotFormState(
  value: string | undefined,
  defaultValue: string,
  hasDefaultValue: boolean,
  sensitive: boolean,
): CapturedNode["formState"] {
  if (sensitive) {
    if (value === undefined && !hasDefaultValue) return undefined;
    return (value ?? defaultValue) === "" ? "empty" : "filled";
  }
  if (value === undefined) return undefined;
  if (value === "") return "empty";
  return value === defaultValue ? "default" : "filled";
}

function str(strings: string[], idx: number | undefined): string {
  if (idx === undefined || idx < 0) return "";
  return strings[idx] ?? "";
}

export function sparseIndexMap(sparse: SparseArray | undefined): Map<number, number> {
  const out = new Map<number, number>();
  if (!sparse?.index || !sparse.value) return out;
  for (let i = 0; i < sparse.index.length; i++) {
    const nodeIndex = sparse.index[i];
    const docIndex = sparse.value[i];
    if (nodeIndex !== undefined && docIndex !== undefined) out.set(nodeIndex, docIndex);
  }
  return out;
}

export async function decodeDocument(
  doc: SnapshotDocument,
  strings: string[],
  signal?: AbortSignal,
  profile: SnapshotProfile = BASIC_SNAPSHOT,
): Promise<DecodedDocument> {
  const checkpoint = createCaptureCheckpoint(signal);
  const dn = doc.nodes;
  const dl = doc.layout;
  if (!dn?.backendNodeId) {
    return { nodes: [] };
  }

  const count = dn.backendNodeId.length;
  const layoutByNode = new Map<number, number>();
  for (let i = 0; i < (dl?.nodeIndex?.length ?? 0); i++) {
    if (i % 256 === 0) {
      const pending = checkpoint();
      if (pending) await pending;
    }
    layoutByNode.set(dl!.nodeIndex![i], i);
  }

  const inputValues = sparseIndexMap(dn.inputValue);
  const textValues = sparseIndexMap(dn.textValue);
  const checkedInputs = new Set(dn.inputChecked?.index ?? []);
  const selectedOptions = new Set(dn.optionSelected?.index ?? []);

  // Collect visible text from #text child nodes so element CapturedNodes
  // carry a textContent value usable as a button/link label fallback.
  // nodeValue is a parallel array: string index for text nodes, -1 otherwise.
  const nodeTextContent = new Map<number, string[]>();
  if (dn.nodeValue) {
    for (let n = 0; n < count; n++) {
      if (n % 256 === 0) {
        const pending = checkpoint();
        if (pending) await pending;
      }
      const nvIdx = dn.nodeValue[n] ?? -1;
      if (nvIdx < 0) continue;
      const text = str(strings, nvIdx).trim();
      if (!text) continue;
      const parentIdx = dn.parentIndex?.[n] ?? -1;
      if (parentIdx >= 0) {
        const existing = nodeTextContent.get(parentIdx);
        if (existing) existing.push(text);
        else nodeTextContent.set(parentIdx, [text]);
      }
    }
  }

  // Decode fields without assigning a coordinate projection or semantic policy.
  const nodes: DecodedNode[] = [];
  for (let n = 0; n < count; n++) {
    if (n % 256 === 0) {
      const pending = checkpoint();
      if (pending) await pending;
    }
    const backendNodeId = dn.backendNodeId[n];
    const parentIdx = dn.parentIndex?.[n] ?? -1;
    const parentBackendNodeId = parentIdx >= 0 ? (dn.backendNodeId[parentIdx] ?? null) : null;
    const tag = str(strings, dn.nodeName?.[n]).toLowerCase();

    const attrs: Record<string, string> = {};
    const pairs = dn.attributes?.[n] ?? [];
    for (let a = 0; a + 1 < pairs.length; a += 2) {
      attrs[str(strings, pairs[a]).toLowerCase()] = str(strings, pairs[a + 1]);
    }

    const li = layoutByNode.get(n);
    const styleRow = li === undefined ? [] : (dl?.styles?.[li] ?? []);
    const styles: Record<string, string> = {};
    for (let i = 0; i < profile.computedStyles.length; i++)
      styles[profile.computedStyles[i]] = str(strings, styleRow[i]);
    const layout =
      li === undefined
        ? undefined
        : {
            boundsSpace: "snapshot-document-layout" as const,
            bounds: dl?.bounds?.[li],
            ...(profile.includeVisualFacts && dl?.clientRects?.[li]
              ? { clientRect: dl.clientRects[li] }
              : {}),
            styles,
          };

    const textContent = nodeTextContent.get(n)?.join(" ");

    const rawFormValueIndex = tag === "textarea" ? textValues.get(n) : inputValues.get(n);
    const rawFormValue =
      rawFormValueIndex !== undefined ? str(strings, rawFormValueIndex) : undefined;
    const sensitive = isSensitiveFormControl({ tag, attrs });
    const formDefaultValue = attrs.value ?? "";
    const formValue = sensitive ? undefined : rawFormValue;
    const formState = snapshotFormState(
      rawFormValue,
      formDefaultValue,
      Object.prototype.hasOwnProperty.call(attrs, "value"),
      sensitive,
    );
    if (sensitive) delete attrs.value;

    nodes.push({
      backendNodeId,
      nodeType: dn.nodeType?.[n],
      parentBackendNodeId,
      ...(profile.includeVisualFacts &&
      (dn.parentIndex?.[n] === undefined || (parentIdx >= 0 && parentBackendNodeId === null))
        ? { parentMissing: true }
        : {}),

      tag,
      attrs,
      layout,
      paintOrder: li === undefined ? 0 : (dl?.paintOrders?.[li] ?? 0),
      position: styles.position || "static",
      pointerEvents: styles["pointer-events"] || "auto",
      cursor: styles.cursor || "auto",

      textContent,
      ...(formValue !== undefined ? { formValue } : {}),
      ...(tag === "input" || tag === "textarea"
        ? {
            formPlaceholder: attrs.placeholder ?? "",
            ...(!sensitive ? { formDefaultValue } : {}),
            ...(formState ? { formState } : {}),
          }
        : {}),
      ...(checkedInputs.has(n) ? { formValue: "true", formState: "filled" } : {}),
      ...(selectedOptions.has(n) ? { formValue: attrs.value ?? textContent ?? "" } : {}),
    });
  }
  return { nodes };
}

/** Snapshot membership and same-target edges are current response evidence.
 * The earlier graph only supplies compatible metadata and cross-target edges. */
export function describeSnapshotFrames(
  snapshot: SnapshotReply,
  target: CdpTarget,
  hintById: ReadonlyMap<string, CdpFrame>,
  pageUrl?: string,
): { frames: CdpFrame[]; ids: Set<string>; rootFrameId?: string } {
  const raw = snapshot.documents ?? [];
  const strings = snapshot.strings ?? [];
  const ids = new Set<string>();
  const invalid = new Set<string>();
  const frames = raw.map((doc) => {
    const frameId = snapshotFrameId(doc, strings);
    if (!frameId) return undefined;
    if (ids.has(frameId)) invalid.add(frameId);
    ids.add(frameId);
    const hint = hintById.get(frameId);
    const compatible =
      hint && cdpTargetKey(hint.target) === cdpTargetKey(target) ? hint : undefined;
    const url =
      (doc.documentURL === undefined ? undefined : strings[doc.documentURL]) || compatible?.url;
    return { frameId, target, ...(url ? { url } : {}) } as CdpFrame;
  });
  const root = frames[0];
  if (root) {
    const hint = hintById.get(root.frameId);
    const parent = hint?.parentFrameId ? hintById.get(hint.parentFrameId) : undefined;
    if (
      target.sessionId &&
      hint &&
      cdpTargetKey(hint.target) === cdpTargetKey(target) &&
      parent &&
      cdpTargetKey(parent.target) !== cdpTargetKey(target)
    ) {
      root.parentFrameId = parent.frameId;
      root.ownerBackendNodeId = hint.ownerBackendNodeId;
    }
    if (!target.sessionId && !root.url && pageUrl) root.url = pageUrl;
  }
  const owned = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const edges = raw[i].nodes?.contentDocumentIndex;
    const parent = frames[i];
    if (!parent || !edges) continue;
    for (let e = 0; e < edges.index.length; e++) {
      const child = frames[edges.value[e]];
      const owner = raw[i].nodes?.backendNodeId?.[edges.index[e]];
      if (!child || owner === undefined) continue;
      if (child === root || child === parent || owned.has(child.frameId)) {
        invalid.add(child.frameId);
        continue;
      }
      owned.add(child.frameId);
      child.parentFrameId = parent.frameId;
      child.ownerBackendNodeId = owner;
    }
  }
  return {
    frames: frames.filter((frame): frame is CdpFrame => !!frame && !invalid.has(frame.frameId)),
    ids,
    rootFrameId: root?.frameId,
  };
}
