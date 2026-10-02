/** A shared session owns tabs, never its host window. */
export interface SharedWindowApi {
  host(): Promise<chrome.windows.Window>;
  create(windowId: number, focused: boolean): Promise<number>;
  get(tabId: number): Promise<chrome.tabs.Tab>;
  query(windowId: number): Promise<chrome.tabs.Tab[]>;
  remove(tabId: number): Promise<void>;
  focus?(windowId: number): Promise<void>;
}

/** Chrome closes the host when its final tab is removed or moved out. */
export async function preserveHostIfEmptied(
  api: Pick<SharedWindowApi, "query" | "create">,
  windowId: number,
  leavingTabIds: readonly number[],
): Promise<{ hostTabs: chrome.tabs.Tab[]; placeholderTabId: number | undefined }> {
  const hostTabs = await api.query(windowId);
  const leaving = new Set(leavingTabIds);
  const placeholderTabId =
    hostTabs.length > 0 && hostTabs.every((tab) => leaving.has(tab.id!))
      ? await api.create(windowId, false)
      : undefined;
  return { hostTabs, placeholderTabId };
}

/** Undo only this operation's blank survivor, without emptying its host. */
export async function removeUnusedSharedPlaceholder(
  api: Pick<SharedWindowApi, "query" | "remove">,
  windowId: number,
  tabId: number,
): Promise<void> {
  const tabs = await api.query(windowId);
  const placeholder = tabs.find((tab) => tab.id === tabId);
  if (tabs.length > 1 && (placeholder?.pendingUrl ?? placeholder?.url) === "about:blank")
    await api.remove(tabId);
}

export const chromeSharedWindowApi: SharedWindowApi = {
  host: () => chrome.windows.getLastFocused({ windowTypes: ["normal"] }),
  async create(windowId, focused) {
    const tab = await chrome.tabs.create({ windowId, url: "about:blank", active: focused });
    if (tab.id === undefined) throw new Error("Could not create session tab");
    return tab.id;
  },
  get: (tabId) => chrome.tabs.get(tabId),
  query: (windowId) => chrome.tabs.query({ windowId }),
  remove: (tabId) => chrome.tabs.remove(tabId),
  focus: async (windowId) => {
    await chrome.windows.update(windowId, { focused: true });
  },
};
