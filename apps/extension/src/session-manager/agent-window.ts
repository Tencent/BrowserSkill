/**
 * Wrapper around `chrome.windows.*` for creating / closing the
 * dedicated Agent Window each session owns.
 *
 * Kept behind an interface so the SessionManager can be unit-tested
 * with a fake chrome.windows implementation (see
 * `__tests__/manager.test.ts`).
 */

export interface AgentWindowApi {
  create(url: string, opts?: AgentWindowCreateOptions): Promise<number>;
  remove(windowId: number): Promise<void>;
  /**
   * Guarantee the Agent Window has an active, CDP-navigable tab.
   * `chrome://` pages (including the New Tab page) reject `Page.navigate`,
   * so sessions bootstrap with `about:blank` instead.
   *
   * Resolves with the id of the activated (or newly created) tab, so callers
   * can track the session's home tab without re-querying Chrome.
   */
  ensureActiveTab(windowId: number, url: string): Promise<number>;
}

/** Creation hints for a new Agent Window. */
export interface AgentWindowCreateOptions {
  /** Optional outer size in CSS pixels. */
  size?: { width: number; height: number };
  /** Defaults to true so existing sessions keep visible Agent Windows. */
  focused?: boolean;
}

/** Initial tab URL for every new session's Agent Window. */
export const AGENT_WINDOW_HOME = "about:blank";

export const chromeAgentWindowApi: AgentWindowApi = {
  async create(url: string, opts: AgentWindowCreateOptions = {}): Promise<number> {
    const win = await chrome.windows.create({
      type: "normal",
      focused: opts.focused ?? true,
      url,
      ...(opts.size ? { width: opts.size.width, height: opts.size.height } : {}),
    });
    if (typeof win?.id !== "number") {
      throw new Error("[bh] chrome.windows.create returned no window id");
    }
    return win.id;
  },
  async remove(windowId: number): Promise<void> {
    // Callers decide whether a missing/failed removal is benign. In
    // particular, transactional session-start cleanup must be able to
    // surface a window it could not remove instead of reporting a false
    // cancellation success while the Agent Window remains open.
    await chrome.windows.remove(windowId);
  },
  async ensureActiveTab(windowId: number, url: string): Promise<number> {
    const tabs = await chrome.tabs.query({ windowId });
    const first = tabs.find((t) => typeof t.id === "number");
    if (first?.id !== undefined) {
      if (!first.active) {
        await chrome.tabs.update(first.id, { active: true });
      }
      return first.id;
    }
    const created = await chrome.tabs.create({ windowId, url, active: true });
    if (typeof created?.id !== "number") {
      throw new Error("[bh] chrome.tabs.create returned no tab id");
    }
    return created.id;
  },
};
