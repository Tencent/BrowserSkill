import type { RecordingNavigationCursor } from "./step-buffer";

export interface TabActivation {
  tabId: number;
  revision: number;
}

export class RecordingTabCoordinator {
  readonly #navigationByTab = new Map<number, RecordingNavigationCursor>();
  #activeTabId: number;
  #currentTabId: number;
  #activationRevision = 0;

  constructor(initialTabId: number, initialUrl?: string) {
    this.#activeTabId = initialTabId;
    this.#currentTabId = initialTabId;
    this.#navigationByTab.set(initialTabId, {
      currentUrl: initialUrl,
      pendingNavigation: false,
    });
  }

  get activeTabId(): number {
    return this.#activeTabId;
  }

  get currentTabId(): number {
    return this.#currentTabId;
  }

  noteActivation(tabId: number): TabActivation {
    this.#activeTabId = tabId;
    this.#activationRevision += 1;
    return { tabId, revision: this.#activationRevision };
  }

  isLatest(activation: TabActivation): boolean {
    return (
      activation.tabId === this.#activeTabId && activation.revision === this.#activationRevision
    );
  }

  commit(tabId: number): number {
    const previousTabId = this.#currentTabId;
    this.#currentTabId = tabId;
    return previousTabId;
  }

  navigation(tabId: number, fallbackUrl?: string): RecordingNavigationCursor {
    const existing = this.#navigationByTab.get(tabId);
    if (existing) {
      if (!existing.currentUrl && fallbackUrl) existing.currentUrl = fallbackUrl;
      return existing;
    }
    const created: RecordingNavigationCursor = {
      currentUrl: fallbackUrl,
      pendingNavigation: false,
    };
    this.#navigationByTab.set(tabId, created);
    return created;
  }
}
