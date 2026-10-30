import { isAgentControlledTab, type SessionContext, type SessionManager } from "./manager";

type TabGroupApi = Pick<typeof chrome, "tabs" | "tabGroups">;

/** Native window identification only; group membership never grants control. */
export class AgentWindowTabGroups {
  private readonly groups = new Map<number, number>();
  private readonly pending = new Set<number>();
  private running = false;
  private disposed = false;

  constructor(
    private readonly manager: SessionManager,
    private readonly api: TabGroupApi = chrome,
  ) {
    api.tabs.onUpdated.addListener(this.updated);
    api.tabs.onAttached.addListener(this.attached);
    api.tabs.onDetached.addListener(this.detached);
    api.tabs.onRemoved.addListener(this.removed);
    api.tabGroups.onRemoved.addListener(this.groupsChanged);
    api.tabGroups.onMoved.addListener(this.groupsChanged);
  }

  /** Called after session changes and after a concrete tab has been claimed. */
  sync(): void {
    if (this.disposed) return;
    for (const task of this.manager.list()) this.pending.add(task.agentWindowId);
    for (const windowId of this.groups.keys()) this.pending.add(windowId);
    void this.flush();
  }

  dispose(): void {
    this.disposed = true;
    this.pending.clear();
    const { tabs, tabGroups } = this.api;
    tabs.onUpdated.removeListener(this.updated);
    tabs.onAttached.removeListener(this.attached);
    tabs.onDetached.removeListener(this.detached);
    tabs.onRemoved.removeListener(this.removed);
    tabGroups.onRemoved.removeListener(this.groupsChanged);
    tabGroups.onMoved.removeListener(this.groupsChanged);
  }

  private groupsChanged = () => this.sync();
  private updated = (_id: number, change: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
    if (change.groupId !== undefined || change.pinned !== undefined || change.status === "complete")
      this.schedule(tab.windowId);
  };
  private attached = (_id: number, info: chrome.tabs.TabAttachInfo) => {
    this.schedule(info.newWindowId);
  };
  private detached = (_id: number, info: chrome.tabs.TabDetachInfo) => {
    this.schedule(info.oldWindowId);
  };
  private removed = (_id: number, info: chrome.tabs.TabRemoveInfo) => {
    this.schedule(info.windowId);
  };

  private schedule(windowId: number): void {
    if (!this.manager.findByWindowId(windowId) && !this.groups.has(windowId)) return;
    this.pending.add(windowId);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      // Serialize and coalesce browser events, including those raised by grouping.
      // A cosmetic failure must never fail or delay an agent tool request.
      for (const windowId of this.pending) {
        this.pending.delete(windowId);
        try {
          await this.reconcile(windowId);
        } catch (error) {
          console.debug("[bsk] Agent Window tab group update failed", error);
        }
        if (this.disposed) break;
      }
    } finally {
      this.running = false;
    }
  }

  private live(task: SessionContext): boolean {
    return (
      !this.disposed &&
      this.manager.get(task.sessionId) === task &&
      !this.manager.isWindowCloseExpected(task)
    );
  }

  private async reconcile(windowId: number): Promise<void> {
    const task = this.manager.findByWindowId(windowId);
    let groupId = this.groups.get(windowId);
    // Use a successful query to distinguish a deleted group from an API failure.
    // Never adopt a user-created group merely because its name matches ours.
    let group =
      groupId === undefined
        ? undefined
        : (await this.api.tabGroups.query({})).find((candidate) => candidate.id === groupId);
    if (this.disposed) return;
    if (!group) {
      this.groups.delete(windowId);
      groupId = undefined;
    } else if (!task || group.windowId !== windowId) {
      const members = await this.api.tabs.query({ groupId });
      const current = await this.currentTabs(members);
      if (this.disposed) return;
      const ids = current.flatMap((tab) => (tab && tab.groupId === groupId ? [tab.id!] : []));
      if (ids.length) await this.api.tabs.ungroup(ids);
      this.groups.delete(windowId);
      groupId = undefined;
      group = undefined;
    }
    if (!task || !this.live(task)) return;

    const tabs = await this.api.tabs.query({ windowId });
    if (!this.live(task)) return;
    // Leave pinned tabs and the user's own groups intact. A tab entering this
    // window is not necessarily controlled; wait for the existing claim hook.
    const eligible = (tab: chrome.tabs.Tab): boolean =>
      tab.id !== undefined &&
      tab.windowId === windowId &&
      !tab.pinned &&
      tab.groupId === -1 &&
      isAgentControlledTab(task, tab.id);
    const candidates = tabs.filter(eligible);
    if (groupId !== undefined && candidates.length) {
      const target = await this.api.tabGroups.get(groupId);
      if (!this.live(task)) return;
      if (target.windowId !== windowId) {
        this.pending.add(windowId);
        return;
      }
    }
    const current = await this.currentTabs(candidates);
    if (!this.live(task)) return;
    const ids = current.flatMap((tab) => (tab && eligible(tab) ? [tab.id!] : []));
    if (ids.length) {
      groupId = await this.api.tabs.group({
        tabIds: ids,
        ...(groupId === undefined ? { createProperties: { windowId } } : { groupId }),
      });
      this.groups.set(windowId, groupId);
      if (!this.live(task)) {
        this.pending.add(windowId);
        return;
      }
    }
    const title = task.taskName?.trim() || "BrowserSkill";
    if (groupId !== undefined && (group?.title !== title || group.color !== "orange")) {
      // Do not continually expand the group after the user has collapsed it.
      await this.api.tabGroups.update(groupId, {
        title,
        color: "orange",
        ...(!group ? { collapsed: false } : {}),
      });
    }
  }

  private currentTabs(tabs: chrome.tabs.Tab[]): Promise<(chrome.tabs.Tab | undefined)[]> {
    return Promise.all(
      tabs.flatMap((tab) =>
        tab.id === undefined ? [] : [this.api.tabs.get(tab.id).catch(() => undefined)],
      ),
    );
  }
}
