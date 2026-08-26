import type { Rect } from "@browser-skill/vom";

/**
 * Per-session map from `@e<N>` snapshot refs to a CDP node address.
 *
 * Each fresh `tool.snapshot` resets the store: M6 will call
 * `replace(...)` with the new ref → node address pairs. A node address
 * includes the owning flat CDP session/frame when the element lives in
 * an OOPIF; tools resolve live geometry from that identity at call time.
 *
 * Refs are session-scoped (§7): looking up a ref in the wrong session
 * returns `null`, never silently leaks. Storing values in different
 * sessions is fine; they live in independent `RefStore` instances
 * inside the `SessionContext`.
 */
export type BackendNodeId = number;
export type RefCapability = "interact" | "screenshot";
export type RefTargetKind = "dom" | "surface";

export interface RefEntry {
  backendNodeId: BackendNodeId;
  tabId: number | null;
  frameId?: string;
  cdpSessionId?: string;
  visibleRect?: Rect;
  kind: RefTargetKind;
  capabilities: RefCapability[];
  generation: number;
}

export type RefInput =
  | BackendNodeId
  | {
      backendNodeId: BackendNodeId;
      tabId: number;
      frameId?: string;
      cdpSessionId?: string;
      visibleRect?: Rect;
      kind?: RefTargetKind;
      capabilities?: RefCapability[];
    };

function capabilitiesFor(
  kind: RefTargetKind,
  capabilities: RefCapability[] | undefined,
): RefCapability[] {
  if (kind === "surface") return ["screenshot"];
  return capabilities ?? ["interact", "screenshot"];
}

export class RefStore {
  private readonly map = new Map<string, RefEntry>();
  private generation = 0;

  size(): number {
    return this.map.size;
  }

  isEmpty(): boolean {
    return this.map.size === 0;
  }

  resolve(ref: string, opts: { tabId?: number } = {}): BackendNodeId | null {
    const entry = this.map.get(normaliseRef(ref));
    if (!entry) return null;
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
    this.map.clear();
    this.generation += 1;
    for (const [ref, input] of entries) this.map.set(normaliseRef(ref), this.entry(input));
  }

  set(
    ref: string,
    id: BackendNodeId,
    opts: {
      tabId?: number;
      frameId?: string;
      cdpSessionId?: string;
      visibleRect?: Rect;
      kind?: RefTargetKind;
      capabilities?: RefCapability[];
    } = {},
  ): void {
    const kind = opts.kind ?? "dom";
    this.map.set(normaliseRef(ref), {
      backendNodeId: id,
      tabId: opts.tabId ?? null,
      ...(opts.frameId ? { frameId: opts.frameId } : {}),
      ...(opts.cdpSessionId ? { cdpSessionId: opts.cdpSessionId } : {}),
      ...(opts.visibleRect ? { visibleRect: opts.visibleRect } : {}),
      kind,
      capabilities: capabilitiesFor(kind, opts.capabilities),
      generation: this.generation,
    });
  }

  clear(): void {
    this.map.clear();
  }

  entries(): IterableIterator<[string, RefEntry]> {
    return this.map.entries();
  }

  private entry(input: RefInput): RefEntry {
    if (typeof input === "number") {
      return {
        backendNodeId: input,
        tabId: null,
        kind: "dom",
        capabilities: ["interact", "screenshot"],
        generation: this.generation,
      };
    }
    const kind = input.kind ?? "dom";
    return {
      backendNodeId: input.backendNodeId,
      tabId: input.tabId,
      ...(input.frameId ? { frameId: input.frameId } : {}),
      ...(input.cdpSessionId ? { cdpSessionId: input.cdpSessionId } : {}),
      ...(input.visibleRect ? { visibleRect: input.visibleRect } : {}),
      kind,
      capabilities: capabilitiesFor(kind, input.capabilities),
      generation: this.generation,
    };
  }
}

/** Canonical RefStore key: `@e3` and `e3` both become `e3`. */
export function normaliseRef(ref: string): string {
  return ref.startsWith("@") ? ref.slice(1) : ref;
}
