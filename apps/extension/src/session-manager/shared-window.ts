/** A shared session owns tabs, never its host window. */
export interface SharedWindowApi {
  host(
    excludedWindowIds: ReadonlySet<number>,
    preferredWindowId?: number,
  ): Promise<chrome.windows.Window>;
  create(windowId: number, focused: boolean): Promise<number>;
  get(tabId: number): Promise<chrome.tabs.Tab>;
  remove(tabId: number): Promise<void>;
  focus?(windowId: number): Promise<void>;
}

export const chromeSharedWindowApi: SharedWindowApi = {
  async host(excludedWindowIds, preferredWindowId) {
    if (preferredWindowId !== undefined) return chrome.windows.get(preferredWindowId);
    const last = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (last.id !== undefined && !last.incognito && !excludedWindowIds.has(last.id)) return last;
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    return (
      windows.find(
        (window) =>
          window.id !== undefined && !window.incognito && !excludedWindowIds.has(window.id),
      ) ?? last
    );
  },
  async create(windowId, focused) {
    const tab = await chrome.tabs.create({ windowId, url: "about:blank", active: focused });
    if (tab.id === undefined) throw new Error("Could not create session tab");
    return tab.id;
  },
  get: (tabId) => chrome.tabs.get(tabId),
  remove: (tabId) => chrome.tabs.remove(tabId),
  focus: async (windowId) => {
    await chrome.windows.update(windowId, { focused: true });
  },
};
