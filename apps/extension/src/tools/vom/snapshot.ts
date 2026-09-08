import type { CapturedNode } from "./facts";
import { captureCheckpoint, type DecodedDocument, type DecodedNode } from "./facts";
export const REQUESTED_STYLES = [
  "position",
  "pointer-events",
  "cursor",
  "visibility",
  "opacity",
  "display",
  "overflow-x",
  "overflow-y",
  "transform",
  "zoom",
  "clip-path",
  "mask-image",
] as const;
const STYLE_COL = Object.fromEntries(
  REQUESTED_STYLES.map((name, index) => [name, index]),
) as Record<(typeof REQUESTED_STYLES)[number], number>;
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
    paintOrders?: number[];
    clientRects?: number[][];
    offsetRects?: number[][];
    scrollRects?: number[][];
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

function sparseIndexMap(sparse: SparseArray | undefined): Map<number, number> {
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
): Promise<DecodedDocument> {
  const dn = doc.nodes;
  const dl = doc.layout;
  if (!dn?.backendNodeId) {
    return { nodes: [] };
  }

  const count = dn.backendNodeId.length;
  const layoutByNode = new Map<number, number>();
  for (let i = 0; i < (dl?.nodeIndex?.length ?? 0); i++) {
    if (i % 256 === 0) await captureCheckpoint(signal);
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
      if (n % 256 === 0) await captureCheckpoint(signal);
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
    if (n % 256 === 0) await captureCheckpoint(signal);
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
    for (const name of REQUESTED_STYLES) styles[name] = str(strings, styleRow[STYLE_COL[name]]);
    const layout =
      li === undefined
        ? undefined
        : {
            boundsSpace: "snapshot-document-css" as const,
            clientSpace: "unscaled-client-offset-css" as const,
            bounds: dl?.bounds?.[li],
            clientRect: dl?.clientRects?.[li],
            offsetRect: dl?.offsetRects?.[li],
            scrollRect: dl?.scrollRects?.[li],
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
      ...(parentIdx >= 0 && dn.backendNodeId[parentIdx] === undefined
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
