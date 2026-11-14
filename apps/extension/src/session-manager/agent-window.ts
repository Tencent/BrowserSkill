/**
 * Wrapper around `chrome.windows.*` for creating / closing the
 * dedicated Agent Window each session owns.
 *
 * Kept behind an interface so the SessionManager can be unit-tested
 * with a fake chrome.windows implementation (see
 * `__tests__/manager.test.ts`).
 */

export interface AgentWindowApi {
  create(url: string, opts?: AgentWindowCreateOptions): Promise<AgentWindowCreation>;
  remove(windowId: number): Promise<void>;
  /**
   * Guarantee the Agent Window has an active, CDP-navigable tab.
   * `chrome://` pages (including the New Tab page) reject `Page.navigate`,
   * so sessions bootstrap with `about:blank` instead.
   *
   * Resolves with the id of the activated (or newly created) tab, so callers
   * can track the session's home tab without re-querying Chrome.
   */
  ensureActiveTab(windowId: number, url: string, ownedTabIds: ReadonlySet<number>): Promise<number>;
}

/** Resource identities captured from the creation result, before initialization. */
export interface AgentWindowCreation {
  windowId: number;
  initialTabIds: number[];
  incognito?: boolean;
}

/** Creation hints for a new Agent Window. */
export interface AgentWindowCreateOptions {
  /** Optional outer size in CSS pixels. */
  size?: { width: number; height: number };
  /** Background by default; explicit viewing and human help may take focus. */
  focused?: boolean;
  /** Use Chrome's shared incognito browsing session. */
  incognito?: boolean;
  /** Live or initializing Agent Windows that must never donate a seed tab. */
  excludeWindowIds?: ReadonlySet<number>;
}

/** Initial tab URL for every new session's Agent Window. */
export const AGENT_WINDOW_HOME = "about:blank";

async function isLinuxPlatform(): Promise<boolean> {
  if (typeof chrome === "undefined" || typeof chrome.runtime?.getPlatformInfo !== "function") {
    return false;
  }
  const info = await chrome.runtime.getPlatformInfo().catch(() => undefined);
  return info?.os === "linux";
}

export const chromeAgentWindowApi: AgentWindowApi = {
  async create(url: string, opts: AgentWindowCreateOptions = {}): Promise<AgentWindowCreation> {
    if (opts.incognito && !(await chrome.extension.isAllowedIncognitoAccess())) {
      throw new Error(
        "Incognito access is disabled. Open chrome://extensions → BrowserSkill → Details → Allow in incognito, then retry.",
      );
    }
    const focused = opts.focused ?? false;
    const incognito = opts.incognito ?? false;
    const size = opts.size ? { width: opts.size.width, height: opts.size.height } : {};
    // On Linux/X11, `chrome.windows.create({ focused: false, url })` runs `Navigate()`
    // on an empty window (`kShowWindow` -> `X11Window::Show(false)`) before reaching
    // `ShowInactive()`, stealing X11 focus. Moving a pre-created inactive tab via
    // `tabId` skips `Navigate()` so `ShowInactive()` maps with `_NET_WM_USER_TIME=0`.
    let seedTabId: number | undefined;
    if (
      !focused &&
      typeof chrome.windows.getAll === "function" &&
      typeof chrome.tabs?.create === "function" &&
      (await isLinuxPlatform())
    ) {
      const windows = await chrome.windows.getAll({ windowTypes: ["normal"] }).catch(() => []);
      const candidates = windows.filter(
        (w) =>
          typeof w.id === "number" &&
          Boolean(w.incognito) === incognito &&
          !opts.excludeWindowIds?.has(w.id),
      );
      const donor = candidates.find((w) => w.focused) ?? candidates[0];
      if (typeof donor?.id === "number") {
        const seeded = await chrome.tabs
          .create({ windowId: donor.id, url, active: false })
          .catch(() => undefined);
        if (typeof seeded?.id === "number") seedTabId = seeded.id;
      }
    }
    let win: chrome.windows.Window | undefined;
    try {
      win = await chrome.windows.create({
        type: "normal",
        focused,
        incognito,
        ...(seedTabId !== undefined ? { tabId: seedTabId } : { url }),
        ...size,
      });
      if (typeof win?.id !== "number") {
        throw new Error("[bh] chrome.windows.create returned no window id");
      }
    } catch (err) {
      if (seedTabId !== undefined) {
        await chrome.tabs?.remove?.(seedTabId).catch(() => {});
      }
      throw err;
    }
    const tabIds = (win.tabs ?? []).flatMap((tab) => (typeof tab.id === "number" ? [tab.id] : []));
    return {
      windowId: win.id,
      incognito: win.incognito,
      initialTabIds: tabIds.length > 0 || seedTabId === undefined ? tabIds : [seedTabId],
    };
  },
  async remove(windowId: number): Promise<void> {
    // Callers decide whether a missing/failed removal is benign. In
    // particular, transactional session-start cleanup must be able to
    // surface a window it could not remove instead of reporting a false
    // cancellation success while the Agent Window remains open.
    await chrome.windows.remove(windowId);
  },
  async ensureActiveTab(
    windowId: number,
    url: string,
    ownedTabIds: ReadonlySet<number>,
  ): Promise<number> {
    const tabs = await chrome.tabs.query({ windowId });
    // A user may have opened a tab while window initialization was pending.
    // Reuse only a tab whose identity came from our creation result.
    const first = tabs.find((t) => t.id !== undefined && ownedTabIds.has(t.id));
    if (first?.id !== undefined) {
      if (!first.active) {
        await chrome.tabs.update(first.id, { active: true });
      }
      return first.id;
    }
    // Creating an active tab directly in a background window steals OS window focus on macOS Chromium.
    const created = await chrome.tabs.create({ windowId, url, active: false });
    if (typeof created?.id !== "number") {
      throw new Error("[bh] chrome.tabs.create returned no tab id");
    }
    try {
      await chrome.tabs.update(created.id, { active: true });
    } catch (err) {
      await chrome.tabs.remove(created.id).catch(() => {});
      throw err;
    }
    return created.id;
  },
};
