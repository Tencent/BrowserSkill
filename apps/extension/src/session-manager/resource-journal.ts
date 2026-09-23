import type { SessionContext } from "./manager";

export const SESSION_RESOURCE_JOURNAL_KEY = "bh.session_resources.v1";
export const BROWSER_RUN_ID_KEY = "bh.browser_run_id.v1";

export interface SessionResourceRecord {
  version: 1;
  browserRunId: string;
  sessionId: string;
  phase: "active" | "stopping" | "cleanup_failed";
  container: SessionContext["container"];
  remote?: boolean;
  activeTabId?: number;
  agentCreatedTabIds: number[];
  borrowedTabs: Array<{
    tabId: number;
    originalWindowId: number;
    originalIndex: number;
    stationary?: boolean;
  }>;
  createdAtMs: number;
  cleanupError?: string;
}

interface StorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface SessionResourceJournalOptions {
  local?: StorageArea;
  session?: StorageArea;
  randomId?: () => string;
}

function chromeStorage(name: "local" | "session"): StorageArea | null {
  if (typeof chrome === "undefined" || !chrome.storage?.[name]) return null;
  return chrome.storage[name];
}

function isRecord(value: unknown): value is SessionResourceRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SessionResourceRecord>;
  const container = record.container as Partial<SessionContext["container"]> | undefined;
  const validContainer =
    container?.mode === "window"
      ? Number.isInteger(container.agentWindowId) && Number(container.agentWindowId) > 0
      : container?.mode === "in_window"
        ? Number.isInteger(container.hostWindowId) && Number(container.hostWindowId) > 0
        : container?.mode === "existing_tab" &&
          Number.isInteger(container.hostWindowId) &&
          Number(container.hostWindowId) > 0 &&
          Number.isInteger(container.rootTabId) &&
          Number(container.rootTabId) > 0;
  const validBorrow = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return false;
    const tab = entry as SessionResourceRecord["borrowedTabs"][number];
    return (
      Number.isInteger(tab.tabId) &&
      tab.tabId > 0 &&
      Number.isInteger(tab.originalWindowId) &&
      tab.originalWindowId > 0 &&
      Number.isInteger(tab.originalIndex) &&
      tab.originalIndex >= 0 &&
      (tab.stationary === undefined || typeof tab.stationary === "boolean")
    );
  };
  return (
    record.version === 1 &&
    typeof record.browserRunId === "string" &&
    record.browserRunId.length > 0 &&
    typeof record.sessionId === "string" &&
    record.sessionId.length > 0 &&
    ["active", "stopping", "cleanup_failed"].includes(record.phase ?? "") &&
    validContainer &&
    (record.remote === undefined || typeof record.remote === "boolean") &&
    Array.isArray(record.agentCreatedTabIds) &&
    record.agentCreatedTabIds.every((id) => Number.isInteger(id) && id > 0) &&
    Array.isArray(record.borrowedTabs) &&
    record.borrowedTabs.every(validBorrow) &&
    Number.isFinite(record.createdAtMs)
  );
}

/** Write-through ownership journal for physical Chrome resources. */
export class SessionResourceJournal {
  private readonly local: StorageArea | null;
  private readonly session: StorageArea | null;
  private readonly randomId: () => string;
  private serial: Promise<void> = Promise.resolve();
  private runIdPromise: Promise<string> | null = null;

  constructor(options: SessionResourceJournalOptions = {}) {
    this.local = options.local ?? chromeStorage("local");
    this.session = options.session ?? chromeStorage("session");
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
  }

  private async runId(): Promise<string> {
    if (!this.runIdPromise) {
      this.runIdPromise = (async () => {
        // storage.session is the authority for whether persisted numeric
        // Chrome ids belong to this browser/extension epoch. It survives MV3
        // worker suspension, but Chrome clears it on browser restart and
        // extension reload/update. In either ambiguous case we deliberately
        // prefer a visible orphan over risking deletion of a newly-reused
        // user window/tab id. storage.local is only a diagnostic mirror.
        const existing = await this.session?.get(BROWSER_RUN_ID_KEY);
        const value = existing?.[BROWSER_RUN_ID_KEY];
        if (typeof value === "string" && value) {
          await this.local?.set({ [BROWSER_RUN_ID_KEY]: value });
          return value;
        }
        const created = this.randomId();
        await this.session?.set({ [BROWSER_RUN_ID_KEY]: created });
        await this.local?.set({ [BROWSER_RUN_ID_KEY]: created });
        return created;
      })();
    }
    return this.runIdPromise;
  }

  private async readAll(): Promise<Record<string, SessionResourceRecord>> {
    const stored = await this.local?.get(SESSION_RESOURCE_JOURNAL_KEY);
    const raw = stored?.[SESSION_RESOURCE_JOURNAL_KEY];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw).filter((entry): entry is [string, SessionResourceRecord] =>
        isRecord(entry[1]),
      ),
    );
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.serial.then(action, action);
    this.serial = next.catch(() => {});
    return next;
  }

  save(
    ctx: SessionContext,
    phase: SessionResourceRecord["phase"] = ctx.stopping ? "stopping" : "active",
    cleanupError?: string,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (!this.local) return;
      const records = await this.readAll();
      records[ctx.sessionId] = {
        version: 1,
        browserRunId: await this.runId(),
        sessionId: ctx.sessionId,
        phase,
        container: ctx.container,
        ...(ctx.remote !== undefined ? { remote: ctx.remote } : {}),
        ...(ctx.activeTabId !== undefined ? { activeTabId: ctx.activeTabId } : {}),
        agentCreatedTabIds: [...ctx.agentCreatedTabs],
        borrowedTabs: [...ctx.borrowedTabs.values()],
        createdAtMs: ctx.createdAtMs,
        ...(cleanupError ? { cleanupError } : {}),
      };
      await this.local.set({ [SESSION_RESOURCE_JOURNAL_KEY]: records });
    });
  }

  remove(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.local) return;
      const records = await this.readAll();
      if (!(sessionId in records)) return;
      delete records[sessionId];
      await this.local.set({ [SESSION_RESOURCE_JOURNAL_KEY]: records });
    });
  }

  async recoverable(): Promise<SessionResourceRecord[]> {
    await this.serial;
    const runId = await this.runId();
    return Object.values(await this.readAll()).filter((record) => record.browserRunId === runId);
  }

  async stale(): Promise<SessionResourceRecord[]> {
    await this.serial;
    const runId = await this.runId();
    return Object.values(await this.readAll()).filter((record) => record.browserRunId !== runId);
  }

  /** Drop records whose Chrome ids belong to an earlier browser process. */
  pruneStale(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.local) return;
      const runId = await this.runId();
      const records = await this.readAll();
      let changed = false;
      for (const [sessionId, record] of Object.entries(records)) {
        if (record.browserRunId === runId) continue;
        delete records[sessionId];
        changed = true;
      }
      if (changed) await this.local.set({ [SESSION_RESOURCE_JOURNAL_KEY]: records });
    });
  }
}
