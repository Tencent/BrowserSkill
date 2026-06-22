/**
 * Wrapper around `chrome.windows.*` for creating / closing the
 * dedicated Agent Window each session owns.
 *
 * Kept behind an interface so the SessionManager can be unit-tested
 * with a fake chrome.windows implementation (see
 * `__tests__/manager.test.ts`).
 */

export interface AgentWindowApi {
  create(url: string): Promise<number>;
  remove(windowId: number): Promise<void>;
  /**
   * Guarantee the Agent Window has an active, CDP-navigable tab.
   * `chrome://` pages (including the New Tab page) reject `Page.navigate`,
   * so sessions bootstrap with `about:blank` instead.
   */
  ensureActiveTab(windowId: number, url: string): Promise<void>;
}

/** Initial tab URL for every new session's Agent Window. */
export const AGENT_WINDOW_HOME = "about:blank";

export const chromeAgentWindowApi: AgentWindowApi = {
  async create(url: string): Promise<number> {
    const win = await chrome.windows.create({
      type: "normal",
      focused: true,
      url,
    });
    if (typeof win?.id !== "number") {
      throw new Error("[bh] chrome.windows.create returned no window id");
    }
    return win.id;
  },
  async remove(windowId: number): Promise<void> {
    try {
      await chrome.windows.remove(windowId);
    } catch (err) {
      // Window may have been closed by the user already; ignore.
      console.debug("[bh] chrome.windows.remove failed", err);
    }
  },
  async ensureActiveTab(windowId: number, url: string): Promise<void> {
    const tabs = await chrome.tabs.query({ windowId });
    const first = tabs.find((t) => typeof t.id === "number");
    if (first?.id) {
      if (!first.active) {
        await chrome.tabs.update(first.id, { active: true });
      }
      return;
    }
    await chrome.tabs.create({ windowId, url, active: true });
  },
};
