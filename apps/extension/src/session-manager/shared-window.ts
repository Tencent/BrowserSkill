/** A shared session owns tabs, never its host window. */
export interface SharedWindowApi {
  host(): Promise<chrome.windows.Window>;
  window?(windowId: number): Promise<chrome.windows.Window>;
  active?(windowId: number): Promise<chrome.tabs.Tab>;
  create(windowId: number, focused: boolean): Promise<number>;
  get(tabId: number): Promise<chrome.tabs.Tab>;
  remove(tabId: number): Promise<void>;
  focus?(windowId: number): Promise<void>;
}

export const chromeSharedWindowApi: SharedWindowApi = {
  host: () => chrome.windows.getLastFocused({ windowTypes: ["normal"] }),
  window: (windowId) => chrome.windows.get(windowId),
  async active(windowId) {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (!tab || tab.id === undefined) throw new Error("Could not find the active tab");
    return tab;
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
