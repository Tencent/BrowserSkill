import type { BorrowedTab, BorrowedTabGroupMetadata } from "./manager";

export const ORPHAN_AGENT_WINDOWS_STORAGE_KEY = "bsk.orphan_agent_windows";

export interface OrphanAgentWindowEntry {
  sessionId?: string;
  ownedTabIds: number[];
  borrowedTabs?: BorrowedTab[];
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
  returnBorrowedTab?: (
    windowId: number,
    borrowed: BorrowedTab,
    entry: OrphanAgentWindowEntry,
    orphanWindowIds: ReadonlySet<number>,
  ) => Promise<boolean>;
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

function positiveIntArray(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids = raw.filter(
    (id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0,
  );
  return ids.length > 0 ? ids : undefined;
}

function normalizeBorrowedGroup(raw: unknown): BorrowedTabGroupMetadata | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const candidate = raw as Record<string, unknown>;
  const group: BorrowedTabGroupMetadata = {
    ...(typeof candidate.title === "string" ? { title: candidate.title } : {}),
    ...(typeof candidate.color === "string"
      ? { color: candidate.color as chrome.tabGroups.ColorEnum }
      : {}),
    ...(typeof candidate.collapsed === "boolean" ? { collapsed: candidate.collapsed } : {}),
  };
  return Object.keys(group).length > 0 ? group : undefined;
}

function normalizeBorrowedTab(raw: unknown): BorrowedTab | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Partial<BorrowedTab>;
  if (
    typeof candidate.tabId !== "number" ||
    !Number.isSafeInteger(candidate.tabId) ||
    candidate.tabId <= 0 ||
    typeof candidate.originalWindowId !== "number" ||
    !Number.isSafeInteger(candidate.originalWindowId) ||
    candidate.originalWindowId <= 0 ||
    typeof candidate.originalIndex !== "number" ||
    !Number.isSafeInteger(candidate.originalIndex) ||
    candidate.originalIndex < 0
  ) {
    return null;
  }
  const leftNeighborTabIds = positiveIntArray(candidate.leftNeighborTabIds);
  const rightNeighborTabIds = positiveIntArray(candidate.rightNeighborTabIds);
  const originalGroup = normalizeBorrowedGroup(candidate.originalGroup);
  return {
    tabId: candidate.tabId,
    originalWindowId: candidate.originalWindowId,
    originalIndex: candidate.originalIndex,
    ...(typeof candidate.leftNeighborTabId === "number" &&
    Number.isSafeInteger(candidate.leftNeighborTabId) &&
    candidate.leftNeighborTabId > 0
      ? { leftNeighborTabId: candidate.leftNeighborTabId }
      : {}),
    ...(typeof candidate.rightNeighborTabId === "number" &&
    Number.isSafeInteger(candidate.rightNeighborTabId) &&
    candidate.rightNeighborTabId > 0
      ? { rightNeighborTabId: candidate.rightNeighborTabId }
      : {}),
    ...(leftNeighborTabIds ? { leftNeighborTabIds } : {}),
    ...(rightNeighborTabIds ? { rightNeighborTabIds } : {}),
    ...(typeof candidate.originalGroupId === "number" &&
    Number.isSafeInteger(candidate.originalGroupId) &&
    candidate.originalGroupId >= 0
      ? { originalGroupId: candidate.originalGroupId }
      : {}),
    ...(originalGroup ? { originalGroup } : {}),
    ...(candidate.originalPinned === true ? { originalPinned: true } : {}),
  };
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
    const borrowedTabs = Array.isArray(candidate.borrowedTabs)
      ? candidate.borrowedTabs
          .map((item) => normalizeBorrowedTab(item))
          .filter((item): item is BorrowedTab => item !== null)
      : [];
    result[String(windowId)] = {
      ...(typeof candidate.sessionId === "string" && candidate.sessionId.length > 0
        ? { sessionId: candidate.sessionId }
        : {}),
      ownedTabIds,
      ...(borrowedTabs.length > 0 ? { borrowedTabs } : {}),
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

  upsertWindow(
    windowId: number,
    ownedTabIds: Iterable<number>,
    options: {
      borrowedTabs?: Iterable<BorrowedTab>;
      sessionId?: string;
      throwOnError?: boolean;
    } = {},
  ): Promise<void> {
    if (!Number.isSafeInteger(windowId) || windowId <= 0) return Promise.resolve();
    if (!this.isAvailable() && this.#pendingOps === 0) return Promise.resolve();
    const snapshot = [...new Set(ownedTabIds)].filter(
      (id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0,
    );
    const borrowedById = new Map<number, BorrowedTab>();
    for (const item of options.borrowedTabs ?? []) {
      const normalized = normalizeBorrowedTab(item);
      if (normalized) borrowedById.set(normalized.tabId, normalized);
    }
    const borrowedSnapshot = [...borrowedById.values()];
    const sessionId =
      typeof options.sessionId === "string" && options.sessionId.length > 0
        ? options.sessionId
        : undefined;
    const write = this.#enqueue(async () => {
      const storage = this.#storage();
      if (!storage) return;
      const stored = await storage.get(ORPHAN_AGENT_WINDOWS_STORAGE_KEY);
      const map = normalizeMap(stored[ORPHAN_AGENT_WINDOWS_STORAGE_KEY]);
      map[String(windowId)] = {
        ...(sessionId ? { sessionId } : {}),
        ownedTabIds: snapshot,
        ...(borrowedSnapshot.length > 0 ? { borrowedTabs: borrowedSnapshot } : {}),
        updatedAtMs: this.#now(),
      };
      await storage.set({ [ORPHAN_AGENT_WINDOWS_STORAGE_KEY]: map });
    });
    if (options.throwOnError) return write;
    return write.catch((error) => {
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

    const orphanWindowIds = new Set<number>();
    for (const windowId of entries.keys()) {
      if (!deps.isActiveAgentWindow(windowId)) orphanWindowIds.add(windowId);
    }

    const retiredWindowIds: number[] = [];
    const retainedEntries = new Map<number, BorrowedTab[]>();
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

      const liveTabIds = new Set(
        tabs.map((tab) => tab.id).filter((id): id is number => typeof id === "number"),
      );
      const liveBorrowed = (entry.borrowedTabs ?? []).filter((borrowed) =>
        liveTabIds.has(borrowed.tabId),
      );
      let unreturnedBorrowed: BorrowedTab[] = liveBorrowed;
      if (liveBorrowed.length > 0 && deps.returnBorrowedTab) {
        let returnedAny = false;
        const failedBorrowed: BorrowedTab[] = [];
        for (const borrowed of liveBorrowed) {
          if (deps.isActiveAgentWindow(windowId)) break;
          try {
            if (await deps.returnBorrowedTab(windowId, borrowed, entry, orphanWindowIds)) {
              returnedAny = true;
            } else {
              failedBorrowed.push(borrowed);
            }
          } catch (error) {
            failedBorrowed.push(borrowed);
            console.debug("[bsk orphan-ledger] returnBorrowedTab failed", {
              windowId,
              tabId: borrowed.tabId,
              error,
            });
          }
        }
        if (deps.isActiveAgentWindow(windowId)) continue;
        unreturnedBorrowed = failedBorrowed;
        if (returnedAny) {
          try {
            tabs = await queryWindowTabs(windowId);
          } catch {
            // Chrome closes a window automatically once its last tab moves out.
            report.closedWindowIds.push(windowId);
            retiredWindowIds.push(windowId);
            continue;
          }
          if (deps.isActiveAgentWindow(windowId)) continue;
          if (tabs.length === 0) {
            report.closedWindowIds.push(windowId);
            retiredWindowIds.push(windowId);
            continue;
          }
        }
      }

      const ownedSet = new Set(entry.ownedTabIds);
      const allOwnedByAgent =
        ownedSet.size > 0 &&
        tabs.every((tab) => typeof tab.id === "number" && ownedSet.has(tab.id));

      if (!allOwnedByAgent) {
        // Never close a window containing any uncontrolled user tab, unreturned
        // borrowed user tab, or human-preserved tab. Retain remaining unreturned
        // borrowed-tab metadata so a future restart can still return them.
        report.preservedWindowIds.push(windowId);
        const remainingTabIds = new Set(
          tabs.map((tab) => tab.id).filter((id): id is number => typeof id === "number"),
        );
        const stillUnreturned = unreturnedBorrowed.filter((borrowed) =>
          remainingTabIds.has(borrowed.tabId),
        );
        if (stillUnreturned.length > 0) {
          retainedEntries.set(windowId, stillUnreturned);
        } else {
          retiredWindowIds.push(windowId);
        }
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

    if (retiredWindowIds.length > 0 || retainedEntries.size > 0) {
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
        for (const [windowId, remainingBorrowed] of retainedEntries) {
          if (deps.isActiveAgentWindow(windowId)) continue;
          const key = String(windowId);
          const existing = map[key];
          if (existing) {
            map[key] = {
              ...existing,
              borrowedTabs: remainingBorrowed,
              updatedAtMs: this.#now(),
            };
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
