import { isAgentControlledTab, type SessionManager } from "./manager";

const TARGET_EVENT_TAIL_MS = 100;

/** Track browser-reported source relationships during an uncancelled action.
 * These relationships do not prove that a particular input caused a popup.
 * Late or unattributed targets continue through the ordinary borrow flow. */
export async function withTaskPopups<T>(
  manager: SessionManager,
  params: { session_id?: string; tab_id?: number },
  run: () => Promise<T>,
  onClaimed?: (tabId: number, windowId: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  const task = params.session_id ? manager.get(params.session_id) : null;
  const targets = globalThis.chrome?.webNavigation?.onCreatedNavigationTarget;
  const opened = globalThis.chrome?.tabs?.onCreated;
  if (!task || !targets || !opened || signal?.aborted) return run();
  const live = () =>
    !signal?.aborted &&
    manager.get(task.sessionId) === task &&
    !manager.isWindowCloseExpected(task);
  const source =
    params.tab_id ??
    (
      await chrome.tabs.query({
        windowId: task.agentWindowId,
        active: true,
      })
    )[0]?.id;
  const invalid = new Set<number>();
  const moving = new Set<number>();
  const validSource = async (id: number): Promise<boolean> => {
    if (!live() || invalid.has(id) || (task.remote && !isAgentControlledTab(task, id)))
      return false;
    try {
      const tab = await chrome.tabs.get(id);
      return (
        live() &&
        !invalid.has(id) &&
        tab.windowId === task.agentWindowId &&
        (!task.remote || isAgentControlledTab(task, id))
      );
    } catch {
      return false;
    }
  };
  if (source === undefined || !(await validSource(source))) return run();

  // Candidates are not authorization. A child waits for its parent's validation
  // and migration before it can use that parent as a controlled source.
  const candidates = new Map<number, Promise<boolean>>([[source, Promise.resolve(true)]]);
  let sawNewTab = false;
  const probe = () => {
    sawNewTab = true;
  };
  const removed = (id: number) => {
    invalid.add(id);
  };
  const detached = (id: number) => {
    if (!moving.has(id)) invalid.add(id);
  };
  const targetAvailable = (id: number) =>
    !invalid.has(id) &&
    !manager.findBorrowingSession(id, task.sessionId) &&
    !manager.list().some((owner) => isAgentControlledTab(owner, id));
  const created = ({ sourceTabId, tabId }: { sourceTabId: number; tabId: number }) => {
    const parent = candidates.get(sourceTabId);
    if (!live() || !parent || candidates.has(tabId)) return;
    const work = Promise.resolve()
      .then(async () => {
        if (!(await parent) || !(await validSource(sourceTabId))) return false;
        let tab = await chrome.tabs.get(tabId);
        // Recheck the source after the target lookup, before granting ownership.
        if (!(await validSource(sourceTabId)) || !targetAvailable(tabId)) return false;
        const other = manager.findByWindowId(tab.windowId);
        if (other && other !== task) return false;
        task.agentCreatedTabs.add(tabId);
        // From this point ownership is legitimate even if migration fails or the
        // action is cancelled. Preserve it so normal session cleanup can run.
        if (tab.windowId !== task.agentWindowId) {
          if (!live() || invalid.has(tabId)) return false;
          moving.add(tabId);
          try {
            await chrome.tabs.move(tabId, { windowId: task.agentWindowId, index: -1 });
          } finally {
            moving.delete(tabId);
          }
          tab = await chrome.tabs.get(tabId);
        }
        if (
          !live() ||
          invalid.has(tabId) ||
          !isAgentControlledTab(task, tabId) ||
          tab.windowId !== task.agentWindowId
        )
          return false;
        onClaimed?.(tabId, tab.windowId);
        return true;
      })
      .catch((error) => {
        console.warn("[bsk] task popup setup failed", error);
        return false;
      });
    candidates.set(tabId, work);
  };
  let finishTail: (() => void) | undefined;
  const stopListening = () => {
    targets.removeListener(created);
    opened.removeListener(probe);
    finishTail?.();
  };
  targets.addListener(created);
  opened.addListener(probe);
  chrome.tabs.onRemoved?.addListener(removed);
  chrome.tabs.onDetached?.addListener(detached);
  signal?.addEventListener("abort", stopListening, { once: true });
  try {
    if (!live()) stopListening();
    return await run();
  } finally {
    opened.removeListener(probe);
    if (sawNewTab && live()) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, TARGET_EVENT_TAIL_MS);
        finishTail = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    stopListening();
    // Cancellation ends observation immediately, even if a Chrome lookup never
    // returns. Late work remains guarded and its rejection is always consumed.
    await settleOrAbort(Promise.all(candidates.values()), signal);
    signal?.removeEventListener("abort", stopListening);
    chrome.tabs.onRemoved?.removeListener(removed);
    chrome.tabs.onDetached?.removeListener(detached);
  }
}

async function settleOrAbort(work: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  let abort = () => {};
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        abort = resolve;
        signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
