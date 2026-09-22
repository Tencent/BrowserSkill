import { isAgentControlledTab, type SessionManager } from "./manager";

const INPUT_WINDOW_MS = 100;
const CANDIDATE_BUDGET_MS = 500;

/** Browser source relationships are not proof of creation by an agent.
 * Only observe a short interval starting at actual click/key dispatch. Same-window
 * targets may be controlled, but are never added to the destructive cleanup set.
 * Cross-window or late targets retain the explicit borrow flow. */
export async function withTaskPopups<T>(
  manager: SessionManager,
  params: { session_id?: string; tab_id?: number },
  run: (inputSent: (tabId: number) => void) => Promise<T>,
  onClaimed?: (tabId: number, windowId: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  const task = params.session_id ? manager.get(params.session_id) : null;
  const targets = globalThis.chrome?.webNavigation?.onCreatedNavigationTarget;
  if (!task || !targets || signal?.aborted) return run(() => {});
  let active = true;
  let listening = false;
  let observationEnded = Promise.resolve();
  let finishObservation = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const invalid = new Set<number>();
  const candidates = new Map<number, Promise<boolean>>();
  const live = () =>
    active &&
    !signal?.aborted &&
    manager.get(task.sessionId) === task &&
    !manager.isWindowCloseExpected(task);
  const validSource = async (id: number) => {
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
  const created = ({
    sourceTabId,
    sourceFrameId,
    tabId,
  }: {
    sourceTabId: number;
    sourceFrameId: number;
    tabId: number;
  }) => {
    const parent = candidates.get(sourceTabId);
    if (!live() || !listening || sourceFrameId !== 0 || !parent || candidates.has(tabId)) return;
    const work = Promise.resolve()
      .then(async () => {
        if (!(await parent) || !(await validSource(sourceTabId))) return false;
        const tab = await chrome.tabs.get(tabId);
        if (
          !(await validSource(sourceTabId)) ||
          invalid.has(tabId) ||
          tab.windowId !== task.agentWindowId ||
          manager.findBorrowingSession(tabId, task.sessionId) ||
          manager.findControllingSession(tabId)
        )
          return false;
        // Non-destructive authority: stop releases this tab and preserves its window.
        (task.observedTabs ??= new Set()).add(tabId);
        onClaimed?.(tabId, tab.windowId);
        return true;
      })
      .catch((error) => {
        console.warn("[bsk] popup observation failed", error);
        return false;
      });
    candidates.set(tabId, work);
  };
  const stopListening = () => {
    listening = false;
    clearTimeout(timer);
    targets.removeListener(created);
    finishObservation();
  };
  const invalidate = (id: number) => {
    invalid.add(id);
  };
  const abort = () => {
    active = false;
    stopListening();
    chrome.tabs.onRemoved?.removeListener(invalidate);
    chrome.tabs.onDetached?.removeListener(invalidate);
  };
  const inputSent = (tabId: number) => {
    if (!live()) return;
    if (params.tab_id !== undefined && tabId !== params.tab_id) return;
    candidates.set(tabId, Promise.resolve(true));
    if (!listening) {
      observationEnded = new Promise<void>((resolve) => {
        finishObservation = resolve;
      });
      targets.addListener(created);
    }
    listening = true;
    clearTimeout(timer);
    timer = setTimeout(stopListening, INPUT_WINDOW_MS);
  };
  chrome.tabs.onRemoved?.addListener(invalidate);
  chrome.tabs.onDetached?.addListener(invalidate);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await run(inputSent);
  } finally {
    // Chrome may deliver navigation-target events after the input response.
    // Finish the interval armed by the last input; only input can extend it.
    await observationEnded;
    stopListening();
    await settleOrExpire(Promise.all(candidates.values()), signal);
    active = false;
    signal?.removeEventListener("abort", abort);
    chrome.tabs.onRemoved?.removeListener(invalidate);
    chrome.tabs.onDetached?.removeListener(invalidate);
  }
}

async function settleOrExpire(work: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  let abort = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        abort = resolve;
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(resolve, CANDIDATE_BUDGET_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
