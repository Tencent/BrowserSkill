/**
 * Per-session map from `@e<N>` snapshot refs to CDP `backendNodeId`.
 *
 * Each fresh `tool.snapshot` resets the store: M6 will call
 * `replace(...)` with the new ref → backendNodeId pairs. Tools like
 * `tool.click` consume the store via `resolve("@e1")`.
 *
 * Refs are session-scoped (§7): looking up a ref in the wrong session
 * returns `null`, never silently leaks. Storing values in different
 * sessions is fine; they live in independent `RefStore` instances
 * inside the `SessionContext`.
 */
export type BackendNodeId = number;

export interface RefEntry {
  backendNodeId: BackendNodeId;
  tabId: number | null;
  generation: number;
}

type RefInput = BackendNodeId | { backendNodeId: BackendNodeId; tabId: number };

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
   * Replace the entire store with a new ref → backendNodeId mapping.
   * Used after every fresh `tool.snapshot`.
   */
  replace(entries: Iterable<readonly [string, RefInput]>): void {
    this.map.clear();
    this.generation += 1;
    for (const [ref, input] of entries) this.map.set(normaliseRef(ref), this.entry(input));
  }

  set(ref: string, id: BackendNodeId, opts: { tabId?: number } = {}): void {
    this.map.set(normaliseRef(ref), {
      backendNodeId: id,
      tabId: opts.tabId ?? null,
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
        generation: this.generation,
      };
    }
    return {
      backendNodeId: input.backendNodeId,
      tabId: input.tabId,
      generation: this.generation,
    };
  }
}

/** Canonical RefStore key: `@e3` and `e3` both become `e3`. */
export function normaliseRef(ref: string): string {
  return ref.startsWith("@") ? ref.slice(1) : ref;
}
