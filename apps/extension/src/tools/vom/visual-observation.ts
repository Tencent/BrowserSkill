import {
  prepareObservationRender,
  type RenderedRef,
  type RenderRow,
  type VomOptions,
  type VomScene,
} from "@browser-skill/vom";
import type { CdpTarget } from "@/browser-driver/frame-graph";
import type { RefInput, RefStore } from "@/session-manager/ref-store";
import type { ObserveResult, RpcError } from "@/transport/types";
import type { CdpRunner } from "../shared";
import { throwIfAborted } from "./capture-abort";
import { verifyDocumentIdentity } from "./document-identity";
import type { DocumentIdentity } from "./facts";
import { frameBackendKey, type StructuredSemanticGraph } from "./semantic-graph/types";
import type { VisualCandidate, VisualDiscoveryResult } from "./visual-discovery";

/** Attach by source structure, never by spatial proximity or a guessed label. */
export function attachVisualEntries(
  scene: VomScene,
  graph: StructuredSemanticGraph,
  candidates: readonly VisualCandidate[],
): VomScene {
  const retained = new Map(
    scene.nodes
      .filter((n) => n.backendNodeId !== undefined)
      .map((n) => [frameBackendKey(n.frameId!, n.backendNodeId!), n.id]),
  );
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));
  const parents = new Map<string, number | null>();
  function parentOf(id: string | undefined): number | null {
    const path: string[] = [];
    const seen = new Set<string>();
    while (id && !parents.has(id)) {
      const node = graph.nodes.get(id);
      if (!node) break;
      const kept =
        node.backendNodeId === undefined
          ? undefined
          : retained.get(frameBackendKey(node.frameId, node.backendNodeId));
      if (kept !== undefined) {
        parents.set(id, kept);
        break;
      }
      if (seen.has(id)) break;
      seen.add(id);
      path.push(id);
      id = node.domParentId;
    }
    const parent = id ? (parents.get(id) ?? null) : null;
    for (const key of path) parents.set(key, parent);
    return parent;
  }
  const siblings = new Map<string, { id: number; order: number }[]>();
  for (const node of scene.nodes) {
    const sourceId =
      node.backendNodeId === undefined
        ? undefined
        : graph.nodeByFrameBackend.get(frameBackendKey(node.frameId!, node.backendNodeId));
    const source = sourceId ? graph.nodes.get(sourceId) : undefined;
    if (!source) continue;
    const key = `${node.frameId}:${node.parentId}`;
    const list = siblings.get(key) ?? [];
    list.push({ id: node.id, order: source.sourceOrder });
    siblings.set(key, list);
  }
  for (const list of siblings.values()) list.sort((a, b) => a.order - b.order);
  return {
    ...scene,
    visuals: candidates.map((c, key) => {
      const sourceId = graph.nodeByFrameBackend.get(
        frameBackendKey(c.document.frameId, c.backendNodeId),
      );
      const source = sourceId ? graph.nodes.get(sourceId) : undefined;
      const own = retained.get(frameBackendKey(c.document.frameId, c.backendNodeId));
      let parentId = own !== undefined ? byId.get(own)!.parentId : parentOf(source?.domParentId);
      if (parentId === null) {
        const owner = graph.frames.get(c.document.frameId)?.ownerNodeId;
        if (owner) parentId = parentOf(owner);
      }
      const list = siblings.get(`${c.document.frameId}:${parentId}`) ?? [];
      let lo = 0,
        hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (list[mid].order < (source?.sourceOrder ?? Infinity)) lo = mid + 1;
        else hi = mid;
      }
      return {
        key,
        ...(parentId === null
          ? {
              fallbackContext: `Unplaced Canvas regions (frame ${(graph.frames.get(c.document.frameId)?.order ?? 0) + 1})`,
            }
          : {}),
        parentId,
        sourceId: own,
        rect: {
          x: c.region.crop.x,
          y: c.region.crop.y,
          w: c.region.crop.width,
          h: c.region.crop.height,
        },
        paintOrder: source?.vom.paintOrder,
        beforeId: own ?? list[lo]?.id,
        label: c.label,
        frameId: c.document.frameId,
      };
    }),
  };
}

export interface ObservationOutput {
  render: ReturnType<typeof prepareObservationRender>;
  candidates: readonly VisualCandidate[];
  identities: Map<string, DocumentIdentity>;
  rootIdentity?: DocumentIdentity;
  frames: Map<string, { target: CdpTarget; parentFrameId?: string }>;
  notices: string[];
  maxTokens?: number;
}

export function prepareVisualObservation(
  scene: VomScene,
  graph: StructuredSemanticGraph,
  discovery: VisualDiscoveryResult,
  identities: Map<string, DocumentIdentity>,
  rootFrameId: string,
  notices: string[],
  options: VomOptions,
): ObservationOutput {
  const candidates = discovery.candidates.filter((c) => !!c.framePath);
  const unavailable = discovery.candidates.length - candidates.length;
  if (unavailable)
    notices.push(`@warning ${unavailable} Canvas regions have no verified screenshot path.`);
  const unsupported = discovery.issues.filter(
    (issue) => issue.reason === "geometry-unsupported",
  ).length;
  const incomplete = discovery.issues.length - unsupported;
  if (unsupported)
    notices.push(
      `@warning visual geometry unsupported (${unsupported} issues); no screenshot refs for those regions.`,
    );
  if (incomplete)
    notices.push(
      `@warning visual discovery incomplete (${incomplete} issues); some Canvas regions could not be verified.`,
    );
  return {
    render: prepareObservationRender(attachVisualEntries(scene, graph, candidates), options),
    candidates,
    identities,
    rootIdentity: identities.get(rootFrameId),
    frames: new Map(
      [...graph.frames].map(([id, frame]) => [
        id,
        { target: frame.target, parentFrameId: frame.parentFrameId },
      ]),
    ),
    notices,
    maxTokens: options.maxTokens,
  };
}

interface Page {
  text: string;
  refs: RenderedRef[];
  more: boolean;
  frameIds: Set<string>;
  consumed: number;
}
interface Continuation {
  output: ObservationOutput;
  tabId: number;
  revision: number;
  token: string;
  buffer: RenderRow[];
  exhausted: boolean;
  /** Only the latest response is retained for retrying its input cursor. */
  last?: {
    input: string;
    budget?: number;
    result: ObserveResult;
    identities: Map<string, DocumentIdentity>;
  };
}
const continuations = new WeakMap<RefStore, Continuation>();
export function clearObservationContinuation(store: RefStore): void {
  continuations.delete(store);
}
const cost = (line: string) => Math.ceil(line.length / 4);
const failure = (message: string): RpcError => ({ code: "invalid_params", message });

function page(
  state: Continuation,
  budget: number | undefined,
  continued: boolean,
  nextToken: string,
): Page | RpcError {
  const max = budget ?? Infinity;
  if (!(max >= 0) || Number.isNaN(max)) return failure("max_tokens must be nonnegative");
  const headers = [
    ...state.output.render.headers,
    ...(continued ? ["@continued same observation; only refs in this response are current."] : []),
  ];
  const footer = `@more observe --cursor ${nextToken}; use this page's refs before continuing.`;
  if (continued && state.buffer[0]?.context) headers.push(state.buffer[0].context);
  const fixed = [...headers, ...state.output.notices];
  let used = fixed.reduce((n, line) => n + cost(line), 0);
  if (used > max) return failure("max_tokens is too small for observation headers and notices");
  const lines = [...headers];
  const refs: RenderedRef[] = [];
  const frameIds = new Set<string>();
  let emitted = 0;
  while (true) {
    // One-row lookahead avoids reserving a continuation footer on the final row.
    while (state.buffer.length < emitted + 2 && !state.exhausted) {
      const next = state.output.render.rows.next();
      if (next.done) state.exhausted = true;
      else state.buffer.push(next.value);
    }
    const row = state.buffer[emitted];
    if (!row) break;
    const reserve = state.buffer.length > emitted + 1 || !state.exhausted ? cost(footer) : 0;
    let text = row.text;
    if (used + cost(text) + reserve > max && row.minimal) text = row.minimal;
    if (used + cost(text) + reserve > max) {
      if (!emitted) return failure("max_tokens is too small to advance; increase the budget");
      break;
    }
    if (row.ref) refs.push({ ...row.ref, line: lines.length });
    if (row.frameId) frameIds.add(row.frameId);
    lines.push(text);
    used += cost(text);
    emitted++;
  }
  lines.push(...state.output.notices);
  const more = state.buffer.length > emitted || !state.exhausted;
  if (more) lines.push(footer);
  return { text: lines.join("\n"), refs, more, frameIds, consumed: emitted };
}

export async function publishObservationPage(
  store: RefStore,
  cdp: CdpRunner,
  tabId: number,
  input: { output?: ObservationOutput; cursor?: string; maxTokens?: number },
  signal?: AbortSignal,
): Promise<ObserveResult | RpcError> {
  let state: Continuation;
  if (input.output)
    state = {
      output: input.output,
      tabId,
      revision: store.revision,
      token: crypto.randomUUID(),
      exhausted: false,
      buffer: [],
    };
  else {
    const saved = continuations.get(store);
    if (
      !saved ||
      saved.tabId !== tabId ||
      saved.revision !== store.revision ||
      (input.cursor !== saved.token && input.cursor !== saved.last?.input)
    )
      return failure("observation cursor expired; observe again");
    state = saved;
  }
  const budget = input.maxTokens ?? state.output.maxTokens;
  if (input.cursor && state.last?.input === input.cursor && state.last.budget !== budget)
    return failure("retry this cursor with the same budget, or use next_cursor");
  // Retry retains exactly the latest output; it cannot advance the iterator twice.
  const retry = input.cursor && state.last?.input === input.cursor ? state.last : undefined;
  const nextToken = crypto.randomUUID();
  const rendered = retry ? undefined : page(state, budget, !!input.cursor, nextToken);
  if (rendered && "code" in rendered) return rendered;
  const identities = new Map<string, DocumentIdentity>(retry?.identities);
  if (state.output.rootIdentity)
    identities.set(state.output.rootIdentity.frameId, state.output.rootIdentity);
  const refs = rendered?.refs ?? [];
  const visited = new Set<string>();
  let missingIdentity = false;
  for (const frameId of rendered?.frameIds ?? []) {
    let id: string | undefined = frameId;
    while (id && !visited.has(id)) {
      visited.add(id);
      const identity = state.output.identities.get(id);
      if (identity) identities.set(id, identity);
      else missingIdentity = true;
      id = state.output.frames.get(id)?.parentFrameId;
    }
  }
  if (input.cursor) {
    if (!state.output.rootIdentity || missingIdentity) {
      if (continuations.get(store) === state) continuations.delete(store);
      return failure("observation identity unavailable; observe again");
    }
    for (const identity of identities.values()) {
      if ((await verifyDocumentIdentity(cdp, identity, signal)) !== "current") {
        if (continuations.get(store) === state) continuations.delete(store);
        return failure("observation DOM changed; observe again");
      }
    }
  }
  throwIfAborted(signal);
  if (input.cursor && (continuations.get(store) !== state || store.revision !== state.revision))
    return failure("observation cursor expired during validation; observe again");
  if (retry) return retry.result;
  const entries: [string, RefInput][] = refs.map((ref) => {
    if (ref.visualKey !== undefined)
      return [
        ref.ref,
        { kind: "visual-region", candidate: state.output.candidates[ref.visualKey] },
      ];
    const target = ref.frameId ? state.output.frames.get(ref.frameId)?.target : undefined;
    return [
      ref.ref,
      {
        backendNodeId: ref.backendNodeId,
        tabId,
        frameId: ref.frameId,
        cdpSessionId: target?.sessionId,
      },
    ];
  });
  // Publish only after validation; cancelled preparation leaves buffered rows and refs intact.
  store.replace(entries);
  state.buffer.splice(0, rendered!.consumed);
  state.token = nextToken;
  state.revision = store.revision;
  const result: ObserveResult = {
    text: rendered!.text,
    ref_count: refs.length,
    tab_id: tabId,
    truncated: rendered!.more || state.output.render.truncated(),
    ...(rendered!.more ? { next_cursor: state.token } : {}),
  };
  if (input.cursor) state.last = { input: input.cursor, budget, result, identities };
  if (!rendered!.more) {
    // Keep only the latest response/identity proof for transport retry, not the full observation.
    state.output = {
      ...state.output,
      candidates: [],
      identities: new Map(),
      frames: new Map(),
      notices: [],
      render: { headers: [], rows: [][Symbol.iterator](), truncated: () => false },
    };
  }
  if (rendered!.more || input.cursor) continuations.set(store, state);
  else continuations.delete(store);
  return result;
}
