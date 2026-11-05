export interface ExpectedTabMove {
  tabId: number;
  fromWindowId: number;
  toWindowId: number;
}

interface MoveOperation extends ExpectedTabMove {
  detached: boolean;
  resolve?: (expected: boolean) => void;
}

/** Match one browser detach/attach pair to one explicitly issued tab move. */
export class ExpectedTabMoves {
  private readonly operations = new Map<number, Set<MoveOperation>>();
  private readonly detached = new Map<number, (MoveOperation | undefined)[]>();

  async run<T>(move: ExpectedTabMove, action: () => Promise<T>): Promise<T> {
    // Reordering in the same window does not generate detach/attach events.
    if (move.fromWindowId === move.toWindowId) return action();
    const operation: MoveOperation = { ...move, detached: false };
    const operations = this.operations.get(move.tabId) ?? new Set<MoveOperation>();
    operations.add(operation);
    this.operations.set(move.tabId, operations);
    try {
      return await action();
    } catch (error) {
      this.finish(operation, false);
      throw error;
    }
    // A successful API response may precede Chrome's browser events. Keep this
    // specific operation until its detach/attach pair arrives, never a timer.
  }

  onDetached(tabId: number, oldWindowId: number): boolean | Promise<boolean> {
    const candidates = [...(this.operations.get(tabId) ?? [])].filter(
      (operation) => !operation.detached && operation.fromWindowId === oldWindowId,
    );
    // Concurrent moves with the same origin cannot be attributed safely.
    const operation = candidates.length === 1 ? candidates[0] : undefined;
    if (!operation) {
      // An unrelated move makes any unused snapshot for this tab stale. Do
      // not let an operation that produced no events authorize a later drag.
      for (const candidate of this.operations.get(tabId) ?? []) {
        if (!candidate.detached) this.finish(candidate, false);
      }
    }
    const queue = this.detached.get(tabId) ?? [];
    queue.push(operation);
    this.detached.set(tabId, queue);
    if (!operation) return false;
    operation.detached = true;
    return new Promise<boolean>((resolve) => {
      operation.resolve = resolve;
    });
  }

  onAttached(tabId: number, newWindowId: number): void {
    const queue = this.detached.get(tabId);
    if (!queue) return;
    const operation = queue.shift();
    if (!queue.length) this.detached.delete(tabId);
    if (operation) this.finish(operation, operation.toWindowId === newWindowId);
  }

  forget(tabId: number): void {
    for (const operation of this.operations.get(tabId) ?? []) this.finish(operation, false);
    this.detached.delete(tabId);
  }

  clear(): void {
    for (const tabId of this.operations.keys()) this.forget(tabId);
    this.detached.clear();
  }

  private finish(operation: MoveOperation, expected: boolean): void {
    const operations = this.operations.get(operation.tabId);
    operations?.delete(operation);
    if (!operations?.size) this.operations.delete(operation.tabId);
    operation.resolve?.(expected);
    operation.resolve = undefined;
  }
}

export const expectedTabMoves = new ExpectedTabMoves();
