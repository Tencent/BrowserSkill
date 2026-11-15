export const ORPHAN_AGENT_WINDOWS_STORAGE_KEY = "bsk.orphan_agent_windows";

export interface OrphanAgentWindowEntry {
  ownedTabIds: number[];
  updatedAtMs: number;
}

export type OrphanAgentWindowRecordMap = Record<string, OrphanAgentWindowEntry>;

export interface SessionStorageAreaLike {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface OrphanWindowReapDeps {
  isActiveAgentWindow: (windowId: number) => boolean;
  queryWindowTabs?: (windowId: number) => Promise<Array<{ id?: number }>>;
  removeWindow?: (windowId: number) => Promise<void>;
}

export interface OrphanWindowReapReport {
  closedWindowIds: number[];
  preservedWindowIds: number[];
}

function defaultSessionStorage(): SessionStorageAreaLike | null {
  if (
    typeof chrome === "undefined" ||
    typeof chrome.storage?.session?.get !== "function" ||
    typeof chrome.storage?.session?.set !== "function"
  ) {
    return null;
  }
  return chrome.storage.session;
}

function normalizeMap(raw: unknown): OrphanAgentWindowRecordMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: OrphanAgentWindowRecordMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const windowId = Number(key);
    if (!Number.isSafeInteger(windowId) || windowId <= 0) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const candidate = value as Partial<OrphanAgentWindowEntry>;
    if (!Array.isArray(candidate.ownedTabIds)) continue;
    const ownedTabIds = candidate.ownedTabIds.filter(
      (id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0,
    );
    result[String(windowId)] = {
      ownedTabIds,
      updatedAtMs: typeof candidate.updatedAtMs === "number" ? candidate.updatedAtMs : 0,
    };
  }
  return result;
}

/**
 * Tracks dedicated Agent Windows created by this extension in `chrome.storage.session`
 * so a restarted MV3 Service Worker can close orphaned Agent Windows left behind
 * when a previous worker died after its daemon sessions ended.
 *
 * Safety invariant: a window is closed ONLY when every tab currently inside it
 * is provably in `ownedTabIds` (tabs created by the agent itself). Any window
 * containing user-created, borrowed, or human-preserved tabs is NEVER closed.
 */
export class OrphanAgentWindowLedger {
  readonly #storage: () => SessionStorageAreaLike | null;
  readonly #now: () => number;
  #queue: Promise<void> = Promise.resolve();
  #pendingOps = 0;

  constructor(
    options: {
      storage?: () => SessionStorageAreaLike | null;
      now?: () => number;
    } = {},
  ) {
    this.#storage = options.storage ?? defaultSessionStorage;
    this.#now = options.now ?? Date.now;
  }

  isAvailable(): boolean {
    return this.#storage() !== null;
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.#pendingOps += 1;
    const run = this.#queue.then(task, task).finally(() => {
      this.#pendingOps -= 1;
    });
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async readAll(): Promise<Map<number, OrphanAgentWindowEntry>> {
    if (!this.isAvailable() && this.#pendingOps === 0) return new Map();
    return this.#enqueue(async () => {
      const storage = this.#storage();
      if (!storage) return new Map();
      const stored = await storage.get(ORPHAN_AGENT_WINDOWS_STORAGE_KEY);
      const map = normalizeMap(stored[ORPHAN_AGENT_WINDOWS_STORAGE_KEY]);
      return new Map(Object.entries(map).map(([key, entry]) => [Number(key), entry]));
    });
  }

  upsertWindow(windowId: number, ownedTabIds: Iterable<number>): Promise<void> {
    if (!Number.isSafeInteger(windowId) || windowId <= 0) return Promise.resolve();
    if (!this.isAvailable() && this.#pendingOps === 0) return Promise.resolve();
    const snapshot = [...new Set(ownedTabIds)].filter(
      (id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0,
    );
    return this.#enqueue(async () => {
      const storage = this.#storage();
      if (!storage) return;
      const stored = await storage.get(ORPHAN_AGENT_WINDOWS_STORAGE_KEY);
      const map = normalizeMap(stored[ORPHAN_AGENT_WINDOWS_STORAGE_KEY]);
      map[String(windowId)] = {
        ownedTabIds: snapshot,
        updatedAtMs: this.#now(),
      };
      await storage.set({ [ORPHAN_AGENT_WINDOWS_STORAGE_KEY]: map });
    }).catch((error) => {
      console.debug("[bsk orphan-ledger] upsertWindow failed", error);
    });
  }

  removeWindow(windowId: number): Promise<void> {
    if (!Number.isSafeInteger(windowId) || windowId <= 0) return Promise.resolve();
    if (!this.isAvailable() && this.#pendingOps === 0) return Promise.resolve();
    return this.#enqueue(async () => {
      const storage = this.#storage();
      if (!storage) return;
      const stored = await storage.get(ORPHAN_AGENT_WINDOWS_STORAGE_KEY);
      const map = normalizeMap(stored[ORPHAN_AGENT_WINDOWS_STORAGE_KEY]);
      const key = String(windowId);
      if (!(key in map)) return;
      delete map[key];
      await storage.set({ [ORPHAN_AGENT_WINDOWS_STORAGE_KEY]: map });
    }).catch((error) => {
      console.debug("[bsk orphan-ledger] removeWindow failed", error);
    });
  }

  async reapOrphans(deps: OrphanWindowReapDeps): Promise<OrphanWindowReapReport> {
    const report: OrphanWindowReapReport = {
      closedWindowIds: [],
      preservedWindowIds: [],
    };
    const queryWindowTabs =
      deps.queryWindowTabs ??
      (async (windowId: number) => {
        if (typeof chrome === "undefined" || typeof chrome.tabs?.query !== "function") return [];
        return chrome.tabs.query({ windowId });
      });
    const removeWindow =
      deps.removeWindow ??
      (async (windowId: number) => {
        if (typeof chrome === "undefined" || typeof chrome.windows?.remove !== "function") return;
        await chrome.windows.remove(windowId);
      });

    const entries = await this.readAll();
    if (entries.size === 0) return report;

    const retiredWindowIds: number[] = [];
    for (const [windowId, entry] of entries) {
      if (deps.isActiveAgentWindow(windowId)) continue;

      let tabs: Array<{ id?: number }>;
      try {
        tabs = await queryWindowTabs(windowId);
      } catch {
        // Window no longer exists.
        retiredWindowIds.push(windowId);
        continue;
      }

      if (deps.isActiveAgentWindow(windowId)) continue;
      if (tabs.length === 0) {
        retiredWindowIds.push(windowId);
        continue;
      }

      const ownedSet = new Set(entry.ownedTabIds);
      const allOwnedByAgent =
        ownedSet.size > 0 &&
        tabs.every((tab) => typeof tab.id === "number" && ownedSet.has(tab.id));

      if (!allOwnedByAgent) {
        // Never close a window containing any uncontrolled user tab, borrowed
        // user tab, or human-preserved tab.
        report.preservedWindowIds.push(windowId);
        retiredWindowIds.push(windowId);
        continue;
      }

      if (deps.isActiveAgentWindow(windowId)) continue;
      try {
        await removeWindow(windowId);
        report.closedWindowIds.push(windowId);
      } catch {
        // Window was closed concurrently by the user.
      }
      retiredWindowIds.push(windowId);
    }

    if (retiredWindowIds.length > 0) {
      await this.#enqueue(async () => {
        const storage = this.#storage();
        if (!storage) return;
        const stored = await storage.get(ORPHAN_AGENT_WINDOWS_STORAGE_KEY);
        const map = normalizeMap(stored[ORPHAN_AGENT_WINDOWS_STORAGE_KEY]);
        let mutated = false;
        for (const windowId of retiredWindowIds) {
          if (deps.isActiveAgentWindow(windowId)) continue;
          const key = String(windowId);
          if (key in map) {
            delete map[key];
            mutated = true;
          }
        }
        if (mutated) {
          await storage.set({ [ORPHAN_AGENT_WINDOWS_STORAGE_KEY]: map });
        }
      }).catch((error) => {
        console.debug("[bsk orphan-ledger] reap cleanup failed", error);
      });
    }

    return report;
  }
}

export const defaultOrphanAgentWindowLedger = new OrphanAgentWindowLedger();
