import type { SessionContext } from "./manager";

const pending = new WeakMap<SessionContext, Set<Promise<void>>>();

/** Chrome can emit tab events before returning the ids we are about to claim. */
export function beginTabCreation(task: SessionContext): () => void {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const operations = pending.get(task) ?? new Set();
  pending.set(task, operations);
  operations.add(done);
  return () => {
    operations.delete(done);
    finish();
  };
}

export async function waitForTabCreation(task: SessionContext): Promise<void> {
  const operations = pending.get(task);
  while (operations?.size) await Promise.all(operations);
}
