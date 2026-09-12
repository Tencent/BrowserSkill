import type { VisualCandidate } from "@/tools/vom/visual-discovery";

/** Session-local refs describe the latest observation. Reusing eN does not identify
 * which observation a caller read; generation is internal bookkeeping only. */
export type BackendNodeId = number;

export interface DomRefEntry {
  readonly kind: "dom";
  name?: string;
  backendNodeId: BackendNodeId;
  tabId: number | null;
  frameId?: string;
  cdpSessionId?: string;
  generation: number;
}

export interface VisualRefInput {
  readonly kind: "visual-region";
  readonly candidate: VisualCandidate;
}

export type RefEntry = DomRefEntry | (VisualRefInput & { readonly generation: number });

export type RefInput =
  | VisualRefInput
  | BackendNodeId
  | {
      name?: string;
      backendNodeId: BackendNodeId;
      tabId: number;
      frameId?: string;
      cdpSessionId?: string;
    };

export class RefStore {
  private map = new Map<string, RefEntry>();
  private generation = 0;

  size(): number {
    return this.map.size;
  }

  isEmpty(): boolean {
    return this.map.size === 0;
  }

  resolve(ref: string, opts: { tabId?: number } = {}): BackendNodeId | null {
    const entry = this.map.get(normaliseRef(ref));
    if (!entry || entry.kind !== "dom") return null;
    if (opts.tabId !== undefined && entry.tabId !== opts.tabId) return null;
    return entry.backendNodeId;
  }

  resolveEntry(ref: string): RefEntry | null {
    return this.map.get(normaliseRef(ref)) ?? null;
  }

  /**
   * Replace the entire store with a new ref → CDP node identity mapping.
   * Used after every fresh `tool.snapshot`.
   */
  replace(entries: Iterable<readonly [string, RefInput]>): void {
    const generation = this.generation + 1;
    const next = new Map<string, RefEntry>();
    for (const [ref, input] of entries) next.set(normaliseRef(ref), this.entry(input, generation));
    this.map = next;
    this.generation = generation;
  }

  set(
    ref: string,
    id: BackendNodeId,
    opts: {
      tabId?: number;
      frameId?: string;
      cdpSessionId?: string;
    } = {},
  ): void {
    this.map.set(normaliseRef(ref), {
      kind: "dom",
      backendNodeId: id,
      tabId: opts.tabId ?? null,
      ...(opts.frameId ? { frameId: opts.frameId } : {}),
      ...(opts.cdpSessionId ? { cdpSessionId: opts.cdpSessionId } : {}),
      generation: this.generation,
    });
  }

  clear(): void {
    this.map.clear();
  }

  entries(): IterableIterator<[string, RefEntry]> {
    return this.map.entries();
  }

  private entry(input: RefInput, generation: number): RefEntry {
    if (typeof input !== "number" && "kind" in input) {
      const { document } = input.candidate;
      if (
        !document?.attachmentId ||
        !document.frameId ||
        !Number.isSafeInteger(document.target?.tabId) ||
        !Number.isSafeInteger(document.documentElementBackendNodeId) ||
        document.documentElementBackendNodeId <= 0 ||
        !Number.isSafeInteger(input.candidate.backendNodeId) ||
        input.candidate.backendNodeId <= 0
      )
        throw new TypeError("visual ref requires a verified DOM identity and anchor");
      // Preserve the read-only evidence and shared clipping chain; do not clone ancestors per ref.
      return { kind: "visual-region", candidate: input.candidate, generation };
    }
    if (typeof input === "number") {
      return {
        kind: "dom",
        backendNodeId: input,
        tabId: null,
        generation,
      };
    }
    return {
      kind: "dom",
      ...(input.name ? { name: input.name } : {}),
      backendNodeId: input.backendNodeId,
      tabId: input.tabId,
      ...(input.frameId ? { frameId: input.frameId } : {}),
      ...(input.cdpSessionId ? { cdpSessionId: input.cdpSessionId } : {}),
      generation,
    };
  }
}

/** Canonical RefStore key: `@e3` and `e3` both become `e3`. */
export function normaliseRef(ref: string): string {
  return ref.startsWith("@") ? ref.slice(1) : ref;
}
