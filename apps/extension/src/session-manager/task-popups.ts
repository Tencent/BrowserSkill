import { isAgentControlledTab, type SessionContext, type SessionManager } from "./manager";

/**
 * Chrome can deliver `onCreatedNavigationTarget` just after it acknowledges the
 * input that caused it, so an action waits this long before it stops listening
 * — but only when a tab actually appeared while it ran.
 */
const TARGET_EVENT_TAIL_MS = 100;

/**
 * Attributes tabs that an agent action opened from a page it already controls.
 *
 * Only Chrome's own navigation-target events count, and only while the action
 * runs: window membership and `openerTabId` are page-influenced metadata and
 * never authorize a tab on their own. A target that arrives late, or that
 * Chrome reports without a source, keeps the ordinary consent-based borrow
 * flow. A popup that opened its own window is moved into the Agent Window,
 * which is what makes it reachable for a local session as well.
 */
export async function withTaskPopups<T>(
  manager: SessionManager,
  params: { session_id?: string; tab_id?: number },
  run: () => Promise<T>,
  onClaimed?: (tabId: number, windowId: number) => void,
): Promise<T> {
  const task = params.session_id ? manager.get(params.session_id) : null;
  const targets = globalThis.chrome?.webNavigation?.onCreatedNavigationTarget;
  const opened = globalThis.chrome?.tabs?.onCreated;
  if (!task || !targets || !opened) return run();
  const source = await actionSource(manager, task, params.tab_id);
  if (source === undefined) return run();

  const sources = new Set([source]);
  const pending = new Set<Promise<void>>();
  let sawNewTab = false;
  const live = () => manager.get(task.sessionId) === task && !manager.isWindowCloseExpected(task);
  const probe = () => {
    sawNewTab = true;
  };
  const created = ({ sourceTabId, tabId }: { sourceTabId: number; tabId: number }) => {
    if (
      !live() ||
      !sources.has(sourceTabId) ||
      !controlsTab(task, sourceTabId) ||
      manager.list().some((other) => other !== task && isAgentControlledTab(other, tabId))
    )
      return;
    // Record the attribution synchronously so a nested popup opened from this
    // tab, and the cleanup below, both see it.
    task.agentCreatedTabs.add(tabId);
    sources.add(tabId);
    const work = (async () => {
      try {
        let tab = await chrome.tabs.get(tabId);
        if (!live() || !isAgentControlledTab(task, tabId)) return;
        const other = manager.findByWindowId(tab.windowId);
        if (other && other !== task) {
          task.agentCreatedTabs.delete(tabId);
          sources.delete(tabId);
          return;
        }
        if (tab.windowId !== task.agentWindowId) {
          await chrome.tabs.move(tabId, { windowId: task.agentWindowId, index: -1 });
          tab = await chrome.tabs.get(tabId);
        }
        if (!live() || !isAgentControlledTab(task, tabId)) return;
        onClaimed?.(tabId, tab.windowId);
      } catch (error) {
        // Keep a live tab's attribution when the move failed, so session.stop
        // still cleans it up; Chrome's removal event forgets closed tabs.
        console.warn("[bsk] task popup setup failed", error);
      }
    })();
    pending.add(work);
    void work.then(() => pending.delete(work));
  };

  targets.addListener(created);
  opened.addListener(probe);
  try {
    return await run();
  } finally {
    opened.removeListener(probe);
    if (sawNewTab) {
      await new Promise((resolve) => setTimeout(resolve, TARGET_EVENT_TAIL_MS));
    }
    targets.removeListener(created);
    await Promise.all(pending);
  }
}

/**
 * The tab the action targets, when this session may drive it. A remote session
 * needs the explicit per-tab claim; a local one controls the Agent Window.
 */
async function actionSource(
  manager: SessionManager,
  task: SessionContext,
  tabId: number | undefined,
): Promise<number | undefined> {
  if (tabId === undefined) {
    const [active] = await chrome.tabs.query({ windowId: task.agentWindowId, active: true });
    return active?.id !== undefined && controlsTab(task, active.id) ? active.id : undefined;
  }
  if (!controlsTab(task, tabId)) return undefined;
  if (task.remote) return tabId;
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.windowId === task.agentWindowId && manager.get(task.sessionId) === task
      ? tabId
      : undefined;
  } catch {
    return undefined;
  }
}

/** Remote sessions authorize tab by tab; local ones by Agent Window. */
function controlsTab(task: SessionContext, tabId: number): boolean {
  return task.remote ? isAgentControlledTab(task, tabId) : true;
}
