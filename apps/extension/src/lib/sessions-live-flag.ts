/**
 * Boolean flag that mirrors "is at least one session live right now?"
 * into `chrome.storage.session`. Read by the all-urls content script
 * as a cheap pre-flight before issuing the `who_am_i` runtime message
 * (review M4/M5 I3): when no session is live we never wake the SW on
 * routine page loads.
 *
 * `chrome.storage.session` defaults to TRUSTED_CONTEXTS only, so we
 * explicitly opt the area into TRUSTED_AND_UNTRUSTED_CONTEXTS the
 * first time we touch it. The stored value is a single boolean and
 * carries no user data.
 */

import type { SessionManager } from "@/session-manager/manager";

export const SESSIONS_LIVE_FLAG_KEY = "bh.sessions_live";

/** Subset of `chrome.storage.session` we use; lets tests inject a fake. */
export interface SessionStorageApi {
  setAccessLevel?(options: { accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" }): Promise<void>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

function defaultSessionStorage(): SessionStorageApi | null {
  if (typeof chrome === "undefined") return null;
  if (!chrome.storage?.session?.set || !chrome.storage?.session?.remove) return null;
  return {
    setAccessLevel: chrome.storage.session.setAccessLevel?.bind(chrome.storage.session),
    set: (items) => chrome.storage.session.set(items),
    remove: (keys) => chrome.storage.session.remove(keys),
  };
}

export interface SessionsLiveFlagOptions {
  manager: SessionManager;
  storage?: SessionStorageApi;
  /** Override the storage key (tests). */
  flagKey?: string;
}

export interface SessionsLiveFlagHandle {
  /** Push current state to storage; useful right after attaching. */
  refresh(): Promise<void>;
  /** Call when SessionManager changes (start/stop/stopAll). */
  syncFromManager(): Promise<void>;
}

/**
 * Bind a SessionManager to a `chrome.storage.session` boolean so the
 * content-script overlay can short-circuit before sending a runtime
 * message. SessionManager does not currently emit change events so the
 * caller is expected to invoke `syncFromManager()` after every
 * start/stop. (M6 will move this to an event-driven hook.)
 */
export function attachSessionsLiveFlag(options: SessionsLiveFlagOptions): SessionsLiveFlagHandle {
  const storage = options.storage ?? defaultSessionStorage();
  const key = options.flagKey ?? SESSIONS_LIVE_FLAG_KEY;
  let lastWritten: boolean | null = null;

  const ensureAccessLevel = async () => {
    if (!storage?.setAccessLevel) return;
    try {
      await storage.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
    } catch (err) {
      console.debug("[bh] storage.session.setAccessLevel failed (continuing)", err);
    }
  };
  void ensureAccessLevel();

  const write = async (live: boolean) => {
    if (!storage) return;
    if (lastWritten === live) return;
    try {
      if (live) {
        await storage.set({ [key]: true });
      } else {
        await storage.remove(key);
      }
      lastWritten = live;
    } catch (err) {
      console.debug("[bh] sessions-live flag write failed", err);
    }
  };

  const syncFromManager = async () => {
    const live = options.manager.list().length > 0;
    await write(live);
  };

  return {
    refresh: syncFromManager,
    syncFromManager,
  };
}
