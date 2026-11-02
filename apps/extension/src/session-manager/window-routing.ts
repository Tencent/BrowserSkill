import { isAgentControlledTab, type SessionContext, type SessionManager } from "./manager";
import { waitForTabCreation } from "./tab-creation";

// Allow Chrome's navigation-target event to accompany its tab-created event.
// Explicit tool creations also have a completion barrier; this delay is never
// used to infer ownership or authorize an agent to operate a page.
const SOURCE_SETTLE_MS = 100;
const RETRY_DELAYS = [250, 1000, 3000];

type RoutingApi = Pick<typeof chrome, "tabs" | "windows" | "webNavigation">;
interface Candidate {
  task: SessionContext;
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Keep unrelated tabs out of live task windows without recreating their pages. */
export class AgentWindowRouting {
  private readonly candidates = new Map<number, Candidate>();
  private readonly tabWindows = new Map<number, number>();
  private readonly pageSourceWindows = new Map<number, number>();
  private readonly userWindows: number[] = [];
  private readonly scanned = new WeakSet<SessionContext>();
  private focusedWindow = -1;
  private focusRevision = 0;
  private disposed = false;
  private mutations: Promise<void> = Promise.resolve();

  constructor(
    private readonly manager: SessionManager,
    private readonly api: RoutingApi = chrome,
    private readonly userControlled: (sessionId: string) => boolean = () => false,
  ) {
    api.tabs.onCreated.addListener(this.created);
    api.tabs.onAttached.addListener(this.attached);
    api.tabs.onUpdated.addListener(this.updated);
    api.tabs.onRemoved.addListener(this.forget);
    api.tabs.onDetached.addListener(this.forget);
    api.webNavigation.onCreatedNavigationTarget.addListener(this.navigationTarget);
    api.windows.onFocusChanged.addListener(this.focusChanged);
    api.windows.onRemoved.addListener(this.windowRemoved);
    const revision = this.focusRevision;
    void api.windows
      .getAll({ windowTypes: ["normal"] })
      .then((windows) => {
        if (this.disposed) return;
        for (const window of windows) {
          if (window.id !== undefined && !this.manager.findByWindowId(window.id))
            this.userWindows.push(window.id);
        }
        // A live focus event is newer than this asynchronous startup snapshot.
        if (revision === this.focusRevision) {
          const focused = windows.find((window) => window.focused);
          if (focused?.id !== undefined) this.focusChanged(focused.id);
        }
      })
      .catch((error) => console.debug("[bsk] window routing initialization failed", error));
  }

  /** Startup events can precede registration of the new session's window. */
  sync(): void {
    for (const task of this.manager.list()) {
      if (this.scanned.has(task)) continue;
      this.scanned.add(task);
      void this.api.tabs
        .query({ windowId: task.agentWindowId })
        .then((tabs) => {
          for (const tab of tabs) this.created(tab);
        })
        .catch(() => {});
    }
    for (const [id, candidate] of this.candidates) {
      if (!this.live(candidate.task)) this.forget(id);
    }
  }

  dispose(): void {
    this.disposed = true;
    const { tabs, windows, webNavigation } = this.api;
    tabs.onCreated.removeListener(this.created);
    tabs.onAttached.removeListener(this.attached);
    tabs.onUpdated.removeListener(this.updated);
    tabs.onRemoved.removeListener(this.forget);
    tabs.onDetached.removeListener(this.forget);
    webNavigation.onCreatedNavigationTarget.removeListener(this.navigationTarget);
    windows.onFocusChanged.removeListener(this.focusChanged);
    windows.onRemoved.removeListener(this.windowRemoved);
    for (const id of this.candidates.keys()) this.forget(id);
    for (const task of this.manager.list()) task.pendingRoutingTabs?.clear();
    this.tabWindows.clear();
    this.pageSourceWindows.clear();
  }

  private live(task: SessionContext): boolean {
    return (
      !this.disposed &&
      this.manager.get(task.sessionId) === task &&
      !this.manager.isWindowCloseExpected(task)
    );
  }

  private protected(task: SessionContext, tabId: number): boolean {
    return (
      isAgentControlledTab(task, tabId) ||
      this.pageSourceWindows.get(tabId) === task.agentWindowId ||
      this.manager.findBorrowingSession(tabId, null) !== null ||
      this.userControlled(task.sessionId)
    );
  }

  private created = (tab: chrome.tabs.Tab): void => {
    if (this.disposed || tab.id === undefined) return;
    // Track location even while human assistance suppresses routing, and
    // independently of whether an agent has permission to control this tab.
    this.tabWindows.set(tab.id, tab.windowId);
    if (this.candidates.has(tab.id)) return;
    const task = this.manager.findByWindowId(tab.windowId);
    if (!task || !this.live(task) || this.protected(task, tab.id)) return;
    const candidate: Candidate = { task, attempt: 0 };
    this.candidates.set(tab.id, candidate);
    (task.pendingRoutingTabs ??= new Set()).add(tab.id);
    this.schedule(tab.id, candidate, SOURCE_SETTLE_MS);
  };

  private attached = (id: number, info: chrome.tabs.TabAttachInfo): void => {
    this.tabWindows.set(id, info.newWindowId);
    void this.api.tabs
      .get(id)
      .then((tab) => {
        if (this.tabWindows.get(id) === info.newWindowId) this.created(tab);
      })
      .catch(() => {});
  };

  private updated = (
    _id: number,
    _change: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab,
  ): void => {
    this.created(tab);
  };

  private clearCandidate(id: number): void {
    clearTimeout(this.candidates.get(id)?.timer);
    this.candidates.delete(id);
  }

  private forget = (id: number): void => {
    const task =
      this.candidates.get(id)?.task ?? this.manager.findByWindowId(this.tabWindows.get(id) ?? -1);
    task?.pendingRoutingTabs?.delete(id);
    this.clearCandidate(id);
    this.tabWindows.delete(id);
    this.pageSourceWindows.delete(id);
  };

  private navigationTarget = (
    details: chrome.webNavigation.WebNavigationSourceCallbackDetails,
  ): void => {
    // Snapshot provenance when Chrome reports it: the source can close or
    // move before routing runs. Neither a candidate nor control permission is
    // required, so multi-level popups opened during human assistance survive.
    // Chrome assigns openerTabId to native external links too; only this event
    // establishes page provenance, without granting control or cleanup rights.
    const windowId = this.tabWindows.get(details.sourceTabId);
    if (windowId !== undefined) {
      this.pageSourceWindows.set(details.tabId, windowId);
      this.manager.findByWindowId(windowId)?.pendingRoutingTabs?.delete(details.tabId);
    }
  };

  private focusChanged = (id: number): void => {
    this.focusedWindow = id;
    const revision = ++this.focusRevision;
    if (id < 0 || this.manager.findByWindowId(id)) return;
    void this.api.windows
      .get(id)
      .then((window) => {
        if (
          this.disposed ||
          revision !== this.focusRevision ||
          window.type !== "normal" ||
          this.manager.findByWindowId(id)
        )
          return;
        this.windowRemoved(id);
        this.userWindows.unshift(id);
      })
      .catch(() => {});
  };

  private windowRemoved = (id: number): void => {
    for (
      let index = this.userWindows.indexOf(id);
      index !== -1;
      index = this.userWindows.indexOf(id)
    )
      this.userWindows.splice(index, 1);
  };

  private schedule(id: number, candidate: Candidate, delay: number): void {
    candidate.timer = setTimeout(() => {
      void waitForTabCreation(candidate.task).then(() => {
        // Serialize destination selection and moves, so concurrent external
        // links share a single replacement user window when all others closed.
        this.mutations = this.mutations.then(async () => {
          if (this.candidates.get(id) !== candidate) return;
          if (!this.live(candidate.task)) {
            this.forget(id);
            return;
          }
          try {
            await this.route(id, candidate.task);
            if (this.candidates.get(id) === candidate) {
              this.clearCandidate(id);
              candidate.task.pendingRoutingTabs?.delete(id);
            }
          } catch (error) {
            if (this.candidates.get(id) !== candidate) return;
            if (!this.live(candidate.task)) {
              this.forget(id);
              return;
            }
            const retry = RETRY_DELAYS[candidate.attempt++];
            if (retry !== undefined) this.schedule(id, candidate, retry);
            else {
              // Keep the unresolved tab excluded from default tool targeting
              // until it moves, closes, is claimed, or gets page provenance.
              this.clearCandidate(id);
              console.warn("[bsk] could not return unrelated tab to a user window", id, error);
            }
          }
        });
      });
    }, delay);
  }

  private async route(id: number, task: SessionContext): Promise<void> {
    const tab = await this.api.tabs.get(id).catch(() => undefined);
    if (!tab || tab.windowId !== task.agentWindowId || !this.live(task) || this.protected(task, id))
      return;
    const windows = await this.api.windows.getAll({ windowTypes: ["normal"] });
    const available = windows.filter(
      (window) =>
        window.id !== undefined &&
        window.incognito === tab.incognito &&
        !this.manager.findByWindowId(window.id),
    );
    const destination =
      this.userWindows
        .map((windowId) => available.find((window) => window.id === windowId))
        .find((window) => window !== undefined) ??
      available.find((window) => window.focused) ??
      available[0];
    // Recheck after lookups: the user can move the tab or a borrow can begin.
    const current = await this.api.tabs.get(id).catch(() => undefined);
    if (
      !current ||
      current.windowId !== task.agentWindowId ||
      !this.live(task) ||
      this.protected(task, id)
    )
      return;
    const focusRevision = this.focusRevision;
    const show = current.active && this.focusedWindow === task.agentWindowId;
    let destinationId = destination?.id;
    if (destinationId !== undefined) {
      await this.api.tabs.move(id, { windowId: destinationId, index: -1 });
    } else {
      const created = await this.api.windows.create({
        tabId: id,
        type: "normal",
        focused: false,
        ...(current.incognito ? { incognito: true } : {}),
      });
      destinationId = created?.id;
      if (destinationId !== undefined) this.userWindows.push(destinationId);
    }
    // Moving a background tab must not activate Chrome or switch user tabs.
    // If the user is viewing the external link, follow it unless they have
    // already switched to another window/application during the move.
    if (
      show &&
      destinationId !== undefined &&
      !this.disposed &&
      focusRevision === this.focusRevision
    ) {
      await this.api.tabs.update(id, { active: true });
      if (focusRevision === this.focusRevision)
        await this.api.windows.update(destinationId, { focused: true });
    }
  }
}
