import type { VisualCandidate } from "@/tools/vom/visual-discovery";

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

export interface DomRefInput {
  name?: string;
  backendNodeId: BackendNodeId;
  tabId: number;
  frameId?: string;
  cdpSessionId?: string;
}

export type RefInput = VisualRefInput | BackendNodeId | DomRefInput;

export class RefStore {
  private map = new Map<string, RefEntry>();
  private generation = 0;
  private observationToken = crypto.randomUUID();
  private stable = false;
  private nextRef = 1;
  private readonly identities = new Map<number, Map<string, string>>();

  get stableRefsEnabled(): boolean {
    return this.stable;
  }

  /** Negotiate once, before publishing the first observation under the new policy. */
  enableStableRefs(): void {
    if (this.stable) return;
    this.stable = true;
    this.clear();
  }

  /** Reserve a name while rendering; only published rows become actionable. */
  allocateRef(input: DomRefInput | VisualRefInput): string {
    if ("kind" in input) return this.allocateVisualRef();
    let tab = this.identities.get(input.tabId);
    if (!tab) {
      tab = new Map();
      this.identities.set(input.tabId, tab);
    }
    const key = JSON.stringify([
      this.documentRevision(input.tabId),
      input.frameId,
      input.cdpSessionId,
      input.backendNodeId,
    ]);
    let ref = tab.get(key);
    if (!ref) {
      ref = `e${this.nextRef++}`;
      tab.set(key, ref);
    }
    return ref;
  }

  /** Visual regions remain observation-scoped even when DOM refs are stable. */
  allocateVisualRef(): string {
    return `e${this.nextRef++}`;
  }

  get observationId(): string {
    return this.observationToken;
  }
  private readonly documents = new Map<number, number>();

  get revision(): number {
    return this.generation;
  }

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
   * Publish a new observation. Stable DOM refs survive supplementary reads;
   * screenshot regions always belong to the most recently published page.
   */
  replace(entries: Iterable<readonly [string, RefInput]>): void {
    const generation = this.generation + 1;
    const next = this.stable
      ? new Map([...this.map].filter(([, entry]) => entry.kind === "dom"))
      : new Map<string, RefEntry>();
    for (const [ref, input] of entries) {
      this.reserveRef(ref);
      next.set(normaliseRef(ref), this.entry(input, generation));
    }
    this.map = next;
    this.generation = generation;
    this.observationToken = crypto.randomUUID();
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
    this.reserveRef(ref);
    this.map.set(normaliseRef(ref), {
      kind: "dom",
      backendNodeId: id,
      tabId: opts.tabId ?? null,
      ...(opts.frameId ? { frameId: opts.frameId } : {}),
      ...(opts.cdpSessionId ? { cdpSessionId: opts.cdpSessionId } : {}),
      generation: this.generation,
    });
  }

  documentRevision(tabId: number): number {
    return this.documents.get(tabId) ?? 0;
  }

  /** A CDP node id may be reused by a new document in the same tab. */
  invalidateTab(tabId: number): void {
    this.documents.set(tabId, this.documentRevision(tabId) + 1);
    this.identities.delete(tabId);
    let changed = false;
    for (const [ref, entry] of this.map) {
      const owner = entry.kind === "dom" ? entry.tabId : entry.candidate.document.target.tabId;
      if (owner === tabId) {
        this.map.delete(ref);
        changed = true;
      }
    }
    if (changed) {
      this.generation++;
      this.observationToken = crypto.randomUUID();
    }
  }

  clear(): void {
    this.generation++;
    this.map.clear();
    this.identities.clear();
    this.observationToken = crypto.randomUUID();
  }

  entries(): IterableIterator<[string, RefEntry]> {
    return this.map.entries();
  }

  private reserveRef(ref: string): void {
    const match = /^@?e(\d+)$/.exec(ref);
    if (match) this.nextRef = Math.max(this.nextRef, Number(match[1]) + 1);
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
