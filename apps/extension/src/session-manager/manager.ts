import { type ControllerInfo, controllerColor } from "@/lib/controller-info";
import { AGENT_WINDOW_HOME, type AgentWindowApi, chromeAgentWindowApi } from "./agent-window";
import {
  defaultOrphanAgentWindowLedger,
  type OrphanAgentWindowLedger,
  type OrphanWindowReapDeps,
  type OrphanWindowReapReport,
} from "./orphan-window-ledger";
import { RefStore } from "./ref-store";

export interface SessionContext {
  controller?: ControllerInfo;
  /** Incognito sessions cannot borrow user tabs. Absent means a normal window. */
  incognito?: boolean;
  /** Remote connections retain dedicated windows, with explicit page ownership. */
  remote?: boolean;
  sessionId: string;
  agentWindowId: number;
  refStore: RefStore;
  /** Negotiated once per session; omitted clients retain strict observations. */
  controlPolicy?: "strict" | "target";
  borrowedTabs: Map<number, BorrowedTab>;
  /**
   * Tabs explicitly claimed by the agent because it created them. This
   * includes the Agent Window's home tab and tabs created by `tool.tab_create`.
   * Tabs opened through Chrome UI never enter this set.
   */
  agentCreatedTabs: Set<number>;
  /** Observed same-window popups: controllable, but preserved by session stop. */
  observedTabs?: Set<number>;
  /** Unclassified arrivals and failed external moves must not become implicit tool targets. */
  pendingRoutingTabs?: Set<number>;
  /** Temporary deselection tabs used to preserve Linux window focus during native pointer input. */
  temporaryInputTabs?: Set<number>;
  createdAtMs: number;
}

/** Whether this session has explicitly claimed control of `tabId`. */
export function isAgentControlledTab(ctx: SessionContext, tabId: number): boolean {
  return (
    ctx.agentCreatedTabs.has(tabId) ||
    ctx.borrowedTabs.has(tabId) ||
    (ctx.observedTabs?.has(tabId) ?? false)
  );
}

export interface BorrowedTabGroupMetadata {
  title?: string;
  color?: chrome.tabGroups.ColorEnum;
  collapsed?: boolean;
}

export interface BorrowedTab {
  tabId: number;
  originalWindowId: number;
  originalIndex: number;
  /** Left-hand neighbor tab ID in the original window at borrow time. */
  leftNeighborTabId?: number;
  /** Right-hand neighbor tab ID in the original window at borrow time. */
  rightNeighborTabId?: number;
  /** Ordered left-hand neighbor tab IDs (closest to farthest) in the original window. */
  leftNeighborTabIds?: number[];
  /** Ordered right-hand neighbor tab IDs (closest to farthest) in the original window. */
  rightNeighborTabIds?: number[];
  /** Original Chrome Tab Group ID (>= 0 when grouped). */
  originalGroupId?: number;
  /** Snapshot of the original Tab Group's properties for recreating single-tab groups. */
  originalGroup?: BorrowedTabGroupMetadata;
  /** Whether the tab was pinned in the original window before borrowing. */
  originalPinned?: boolean;
}

export interface BorrowReservation {
  release(): void;
  commit(entry: BorrowedTab): void;
}

export interface SessionManagerOptions {
  remote?: () => boolean;
  agentWindow?: AgentWindowApi;
  orphanLedger?: OrphanAgentWindowLedger;
  now?: () => number;
}

/** Options for starting a session's Agent Window. */
export interface SessionStartOptions {
  controller?: ControllerInfo;
  /** Use Chrome's shared incognito browsing session. */
  incognito?: boolean;
  /** Optional Agent Window outer size in CSS pixels. */
  size?: { width: number; height: number };
  /** Background by default; true explicitly opens the window in front. */
  focused?: boolean;
  /** Start background Agent Windows minimized when unfocused. */
  minimized?: boolean;
  /** Cancellation for the transactional Agent Window startup sequence. */
  signal?: AbortSignal;
}

export class SessionStartCleanupError extends Error {
  readonly windowId: number;
  readonly startupError: unknown;
  readonly cleanupError: unknown;

  constructor(windowId: number, startupError: unknown, cleanupError: unknown) {
    const startupMessage =
      startupError instanceof Error ? startupError.message : String(startupError);
    const cleanupMessage =
      cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    super(
      `session_start failed (${startupMessage}) and cleanup of Agent Window ${windowId} failed: ${cleanupMessage}`,
    );
    this.name = "SessionStartCleanupError";
    this.windowId = windowId;
    this.startupError = startupError;
    this.cleanupError = cleanupError;
  }
}

function sessionStartAbortError(): Error {
  const error = new Error("session_start aborted");
  error.name = "AbortError";
  return error;
}

function throwIfSessionStartAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw sessionStartAbortError();
}

/**
 * Owner of all live agent sessions inside the extension.
 *
 * The daemon side has its own `SessionRegistry`; this class is the
 * extension-side mirror that holds the per-session Agent Window id,
 * ref-store, and borrowed-tab table. Tool implementations (M6+) read
 * from here to map a `session_id` back to "which Chrome window /
 * which ref / which borrowed tab".
 *
 * Designed to be unit-testable: chrome.* is injected via `AgentWindowApi`
 * so vitest never touches a real `chrome.windows` object.
 */
function createLedgerBackedTabSet(onMutated: () => void): Set<number> {
  const set = new Set<number>();
  Object.defineProperties(set, {
    add: {
      configurable: true,
      writable: true,
      enumerable: false,
      value(tabId: number) {
        const had = Set.prototype.has.call(set, tabId);
        Set.prototype.add.call(set, tabId);
        if (!had) onMutated();
        return set;
      },
    },
    delete: {
      configurable: true,
      writable: true,
      enumerable: false,
      value(tabId: number) {
        const deleted = Set.prototype.delete.call(set, tabId);
        if (deleted) onMutated();
        return deleted;
      },
    },
    clear: {
      configurable: true,
      writable: true,
      enumerable: false,
      value() {
        if (set.size === 0) return;
        Set.prototype.clear.call(set);
        onMutated();
      },
    },
  });
  return set;
}

function createLedgerBackedBorrowedMap(onMutated: () => void): Map<number, BorrowedTab> {
  const map = new Map<number, BorrowedTab>();
  Object.defineProperties(map, {
    set: {
      configurable: true,
      writable: true,
      enumerable: false,
      value(tabId: number, entry: BorrowedTab) {
        Map.prototype.set.call(map, tabId, entry);
        onMutated();
        return map;
      },
    },
    delete: {
      configurable: true,
      writable: true,
      enumerable: false,
      value(tabId: number) {
        const deleted = Map.prototype.delete.call(map, tabId);
        if (deleted) onMutated();
        return deleted;
      },
    },
    clear: {
      configurable: true,
      writable: true,
      enumerable: false,
      value() {
        if (map.size === 0) return;
        Map.prototype.clear.call(map);
        onMutated();
      },
    },
  });
  return map;
}

export class SessionManager {
  private readonly remote: () => boolean;
  private readonly sessions = new Map<string, SessionContext>();
  private readonly windowIndex = new Map<number, string>();
  private readonly activeAgentWindowIds = new Set<number>();
  private readonly borrowReservations = new Map<number, string>();
  private readonly stagedBorrowedTabs = new Map<string, Map<number, BorrowedTab>>();
  private readonly expectedWindowClosures = new WeakSet<SessionContext>();
  private readonly detachLedgerWatchers = new WeakMap<SessionContext, () => void>();
  private readonly agentWindow: AgentWindowApi;
  private readonly orphanLedger: OrphanAgentWindowLedger;
  private readonly now: () => number;

  constructor(options: SessionManagerOptions = {}) {
    this.remote = options.remote ?? (() => false);
    this.agentWindow = options.agentWindow ?? chromeAgentWindowApi;
    this.orphanLedger = options.orphanLedger ?? defaultOrphanAgentWindowLedger;
    this.now = options.now ?? Date.now;
  }

  isTrackedAgentWindow(windowId: number): boolean {
    return this.windowIndex.has(windowId) || this.activeAgentWindowIds.has(windowId);
  }

  reapOrphanAgentWindows(
    deps: Omit<OrphanWindowReapDeps, "isActiveAgentWindow"> = {},
  ): Promise<OrphanWindowReapReport> {
    return this.orphanLedger.reapOrphans({
      ...deps,
      isActiveAgentWindow: (windowId) => this.isTrackedAgentWindow(windowId),
    });
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get(sessionId: string): SessionContext | null {
    return this.sessions.get(sessionId) ?? null;
  }

  isWindowCloseExpected(ctx: SessionContext): boolean {
    return this.expectedWindowClosures.has(ctx);
  }

  /** Mark only the committed window/tab removal stage of session.stop. */
  async withExpectedWindowClose<T>(ctx: SessionContext, close: () => Promise<T>): Promise<T> {
    this.expectedWindowClosures.add(ctx);
    try {
      return await close();
    } finally {
      // Failed teardown must not hide a later user-initiated close.
      this.expectedWindowClosures.delete(ctx);
    }
  }

  findByWindowId(windowId: number): SessionContext | null {
    const id = this.windowIndex.get(windowId);
    return id ? (this.sessions.get(id) ?? null) : null;
  }

  list(): SessionContext[] {
    return Array.from(this.sessions.values());
  }

  invalidateTabRefs(tabId: number): void {
    for (const ctx of this.sessions.values()) ctx.refStore.invalidateTab(tabId);
  }

  invalidateTabChildFrames(tabId: number, staleFrameIds: ReadonlySet<string>): void {
    for (const ctx of this.sessions.values()) {
      const ownsTab = isAgentControlledTab(ctx, tabId) || Boolean(ctx.observedTabs?.has(tabId));
      ctx.refStore.invalidateChildFrames(tabId, staleFrameIds, ownsTab);
    }
  }

  /**
   * Forget a tab Chrome has removed, including any uncommitted borrow.
   * Whole-window closures keep committed borrows until the window-removed
   * handler reports which user tabs could not be returned.
   */
  forgetClosedTab(tabId: number, { isWindowClosing = false } = {}): void {
    this.borrowReservations.delete(tabId);
    this.invalidateTabRefs(tabId);
    for (const ctx of this.sessions.values()) {
      ctx.agentCreatedTabs.delete(tabId);
      ctx.observedTabs?.delete(tabId);
      ctx.temporaryInputTabs?.delete(tabId);
      if (!isWindowClosing) ctx.borrowedTabs.delete(tabId);
    }
  }

  /**
   * Migrate tab ownership across Chrome Memory Saver / prerender tab replacement
   * (`chrome.tabs.onReplaced`) so replaced Agent tabs remain controlled, stay in
   * the Agent Window, and clean up properly on `tab_return` and `session.stop`.
   */
  replaceTab(addedTabId: number, removedTabId: number): SessionContext[] {
    if (addedTabId === removedTabId) return [];
    // Invalidate any uncommitted borrow reservation for `removedTabId` so its old
    // closure cannot leak a lock on `addedTabId`; the replacement can re-enter approval.
    this.borrowReservations.delete(removedTabId);
    for (const staged of this.stagedBorrowedTabs.values()) {
      staged.delete(removedTabId);
    }
    this.invalidateTabRefs(removedTabId);
    const affected: SessionContext[] = [];
    const replaceNeighbor = (id: number) => (id === removedTabId ? addedTabId : id);
    for (const ctx of this.sessions.values()) {
      let controlled = false;
      if (ctx.agentCreatedTabs.has(removedTabId)) {
        ctx.agentCreatedTabs.add(addedTabId);
        ctx.agentCreatedTabs.delete(removedTabId);
        controlled = true;
      }
      const borrowed = ctx.borrowedTabs.get(removedTabId);
      if (borrowed) {
        ctx.borrowedTabs.set(addedTabId, { ...borrowed, tabId: addedTabId });
        ctx.borrowedTabs.delete(removedTabId);
        controlled = true;
      }
      for (const [id, entry] of ctx.borrowedTabs) {
        const leftChanged = entry.leftNeighborTabId === removedTabId;
        const rightChanged = entry.rightNeighborTabId === removedTabId;
        const leftListChanged = entry.leftNeighborTabIds?.includes(removedTabId) ?? false;
        const rightListChanged = entry.rightNeighborTabIds?.includes(removedTabId) ?? false;
        if (leftChanged || rightChanged || leftListChanged || rightListChanged) {
          ctx.borrowedTabs.set(id, {
            ...entry,
            ...(leftChanged ? { leftNeighborTabId: addedTabId } : {}),
            ...(rightChanged ? { rightNeighborTabId: addedTabId } : {}),
            ...(leftListChanged
              ? { leftNeighborTabIds: entry.leftNeighborTabIds!.map(replaceNeighbor) }
              : {}),
            ...(rightListChanged
              ? { rightNeighborTabIds: entry.rightNeighborTabIds!.map(replaceNeighbor) }
              : {}),
          });
        }
      }
      if (ctx.observedTabs?.has(removedTabId)) {
        ctx.observedTabs.add(addedTabId);
        ctx.observedTabs.delete(removedTabId);
        controlled = true;
      }
      if (ctx.pendingRoutingTabs?.has(removedTabId)) {
        ctx.pendingRoutingTabs.add(addedTabId);
        ctx.pendingRoutingTabs.delete(removedTabId);
      }
      if (ctx.temporaryInputTabs?.has(removedTabId)) {
        ctx.temporaryInputTabs.add(addedTabId);
        ctx.temporaryInputTabs.delete(removedTabId);
      }
      if (controlled) affected.push(ctx);
    }
    return affected;
  }

  /** All kinds of committed control, not just borrowed tabs. */
  findControllingSession(tabId: number): string | null {
    return this.list().find((ctx) => isAgentControlledTab(ctx, tabId))?.sessionId ?? null;
  }

  /** Observation does not follow a page moved out by the browser user. */
  releaseObservedTab(tabId: number): string[] {
    const released: string[] = [];
    for (const ctx of this.sessions.values()) {
      if (ctx.observedTabs?.delete(tabId)) {
        ctx.refStore.invalidateTab(tabId);
        released.push(ctx.sessionId);
      }
    }
    return released;
  }

  /**
   * Look up whether `tabId` is currently borrowed by some *other*
   * session than the one calling. Used by M8 `tab_borrow` to refuse
   * a second borrow on the same Chrome tab, and by `tab_close` to
   * tell apart "user tab" from "another session's borrowed tab"
   * (which we must not allow direct access to).
   *
   * Returns the borrowing session id when applicable, otherwise null.
   */
  findBorrowingSession(tabId: number, currentSessionId: string | null): string | null {
    for (const ctx of this.sessions.values()) {
      if (ctx.sessionId === currentSessionId) continue;
      if (ctx.borrowedTabs.has(tabId)) return ctx.sessionId;
    }
    const reservedBy = this.borrowReservations.get(tabId);
    if (reservedBy && reservedBy !== currentSessionId) return reservedBy;
    return null;
  }

  /**
   * Reserve a tab for `tool.tab_borrow` before the handler performs any
   * awaited Chrome work. This closes the cross-session race between the
   * "is anyone borrowing this tab?" check and the eventual borrowedTabs
   * write after `chrome.tabs.move`.
   */
  tryReserveBorrow(tabId: number, sessionId: string): BorrowReservation | { borrowedBy: string } {
    const borrowedBy =
      this.borrowReservations.get(tabId) ??
      this.findControllingSession(tabId) ??
      this.findBorrowingSession(tabId, sessionId);
    if (borrowedBy) return { borrowedBy };
    this.borrowReservations.set(tabId, sessionId);
    let closed = false;
    const release = () => {
      if (closed) return;
      closed = true;
      if (this.borrowReservations.get(tabId) === sessionId) {
        this.borrowReservations.delete(tabId);
      }
    };
    return {
      release,
      commit: (entry) => {
        if (closed) return;
        const ctx = this.sessions.get(sessionId);
        if (!ctx) {
          release();
          throw new Error(`session ${sessionId} disappeared during tab_borrow`);
        }
        if (this.borrowReservations.get(tabId) !== sessionId) {
          throw new Error(`tab ${tabId} borrow reservation disappeared before commit`);
        }
        this.stagedBorrowedTabs.get(sessionId)?.delete(tabId);
        ctx.borrowedTabs.set(tabId, entry);
        release();
      },
    };
  }

  private mergedLedgerBorrowedTabs(ctx: SessionContext): BorrowedTab[] {
    const merged = new Map<number, BorrowedTab>();
    const staged = this.stagedBorrowedTabs.get(ctx.sessionId);
    if (staged) {
      for (const [id, entry] of staged) merged.set(id, entry);
    }
    for (const [id, entry] of ctx.borrowedTabs) merged.set(id, entry);
    return [...merged.values()];
  }

  /**
   * Persist return destination metadata into the orphan Agent Window ledger *before*
   * moving a user tab into the Agent Window so a Service Worker restart mid-borrow
   * cannot strand the tab without return metadata.
   */
  async stageBorrowedTab(sessionId: string, entry: BorrowedTab): Promise<void> {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) throw new Error(`session ${sessionId} disappeared during tab_borrow`);
    let staged = this.stagedBorrowedTabs.get(sessionId);
    if (!staged) {
      staged = new Map();
      this.stagedBorrowedTabs.set(sessionId, staged);
    }
    staged.set(entry.tabId, entry);
    try {
      await this.orphanLedger.upsertWindow(ctx.agentWindowId, ctx.agentCreatedTabs, {
        borrowedTabs: this.mergedLedgerBorrowedTabs(ctx),
        sessionId,
        throwOnError: true,
      });
    } catch (err) {
      staged.delete(entry.tabId);
      if (staged.size === 0) this.stagedBorrowedTabs.delete(sessionId);
      throw err;
    }
  }

  /** Remove a staged (uncommitted) borrow record after a failed move or rollback. */
  async unstageBorrowedTab(sessionId: string, tabId: number): Promise<void> {
    const staged = this.stagedBorrowedTabs.get(sessionId);
    if (!staged?.delete(tabId)) return;
    if (staged.size === 0) this.stagedBorrowedTabs.delete(sessionId);
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return;
    await this.orphanLedger.upsertWindow(ctx.agentWindowId, ctx.agentCreatedTabs, {
      borrowedTabs: this.mergedLedgerBorrowedTabs(ctx),
      sessionId,
    });
  }

  /**
   * Spin up a fresh session: open a new Agent Window with an
   * `about:blank` tab and register the context.
   *
   * Returns the created window id so callers can echo it back to the
   * daemon in the `tool.session_start` reply.
   */
  async start(sessionId: string, opts: SessionStartOptions = {}): Promise<SessionContext> {
    if (this.sessions.has(sessionId)) {
      throw new Error(`[bh] session ${sessionId} already exists`);
    }
    throwIfSessionStartAborted(opts.signal);

    let windowId: number | null = null;
    let ledgerSyncEnabled = false;
    const syncLedger = () => {
      if (!ledgerSyncEnabled || windowId === null) return;
      const merged = new Map<number, BorrowedTab>();
      const staged = this.stagedBorrowedTabs.get(sessionId);
      if (staged) {
        for (const [id, entry] of staged) merged.set(id, entry);
      }
      for (const [id, entry] of borrowedTabs) merged.set(id, entry);
      void this.orphanLedger.upsertWindow(windowId, agentCreatedTabs, {
        borrowedTabs: merged.values(),
        sessionId,
      });
    };
    const agentCreatedTabs = createLedgerBackedTabSet(syncLedger);
    const borrowedTabs = createLedgerBackedBorrowedMap(syncLedger);
    try {
      const { signal: _signal, controller: _controller, ...createOptions } = opts;
      const created = await this.agentWindow.create(AGENT_WINDOW_HOME, {
        ...createOptions,
        excludeWindowIds: this.activeAgentWindowIds,
      });
      windowId = created.windowId;
      this.activeAgentWindowIds.add(windowId);
      for (const tabId of created.initialTabIds) agentCreatedTabs.add(tabId);
      ledgerSyncEnabled = true;
      void this.orphanLedger.upsertWindow(windowId, agentCreatedTabs, {
        borrowedTabs: borrowedTabs.values(),
        sessionId,
      });
      if (opts.incognito && !created.incognito) {
        throw new Error(
          "The browser did not create an incognito Agent Window; session start refused.",
        );
      }
      throwIfSessionStartAborted(opts.signal);
      const homeTabId = await this.agentWindow.ensureActiveTab(
        windowId,
        AGENT_WINDOW_HOME,
        agentCreatedTabs,
      );
      agentCreatedTabs.add(homeTabId);
      throwIfSessionStartAborted(opts.signal);

      const ctx: SessionContext = {
        controller: this.controllerFor(sessionId, opts.controller),
        incognito: created.incognito ?? false,
        ...(this.remote() ? { remote: true } : {}),
        sessionId,
        agentWindowId: windowId,
        refStore: new RefStore(),
        borrowedTabs,
        // Capture ownership at creation, before initialization can fail.
        // Later tabs remain free until `tab_create` or `tab_borrow` identifies
        // them by their concrete Chrome tab id.
        agentCreatedTabs,
        createdAtMs: this.now(),
      };
      this.detachLedgerWatchers.set(ctx, () => {
        ledgerSyncEnabled = false;
      });
      this.sessions.set(sessionId, ctx);
      this.windowIndex.set(windowId, sessionId);
      if (this.orphanLedger.isAvailable()) {
        await this.orphanLedger.upsertWindow(windowId, agentCreatedTabs, {
          borrowedTabs: borrowedTabs.values(),
          sessionId,
        });
      }
      return ctx;
    } catch (startupError) {
      if (windowId !== null) {
        try {
          await this.agentWindow.remove(windowId);
          ledgerSyncEnabled = false;
          this.activeAgentWindowIds.delete(windowId);
          if (this.orphanLedger.isAvailable()) {
            await this.orphanLedger.removeWindow(windowId);
          }
        } catch (cleanupError) {
          // The daemon may retry stop after a failed startup rollback. Retain
          // the exact window handle until closure is confirmed.
          const pending: SessionContext = {
            controller: this.controllerFor(sessionId, opts.controller),
            incognito: opts.incognito ?? false,
            ...(this.remote() ? { remote: true } : {}),
            sessionId,
            agentWindowId: windowId,
            refStore: new RefStore(),
            borrowedTabs,
            agentCreatedTabs,
            createdAtMs: this.now(),
          };
          this.detachLedgerWatchers.set(pending, () => {
            ledgerSyncEnabled = false;
          });
          this.sessions.set(sessionId, pending);
          this.windowIndex.set(windowId, sessionId);
          throw new SessionStartCleanupError(windowId, startupError, cleanupError);
        }
      }
      throw startupError;
    }
  }

  private controllerFor(
    sessionId: string,
    controller?: ControllerInfo,
  ): ControllerInfo | undefined {
    if (!controller) return undefined;
    return {
      ...controller,
      color: controllerColor(
        sessionId,
        controller,
        Array.from(this.sessions.values(), (ctx) => ctx.controller?.color),
      ),
    };
  }

  /**
   * Tear down a session: close its Agent Window and drop the context.
   *
   * `dropOnly = true` skips closing the window — used when the user
   * already closed it manually (M5.4 path) so we don't accidentally
   * close a window that has been re-purposed.
   */
  async stop(
    sessionId: string,
    options: { dropOnly?: boolean } = {},
  ): Promise<SessionContext | null> {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return null;
    if (!options.dropOnly) {
      await this.agentWindow.remove(ctx.agentWindowId);
    }
    if (this.sessions.get(sessionId) === ctx) this.release(sessionId);
    if (this.orphanLedger.isAvailable()) {
      await this.orphanLedger.removeWindow(ctx.agentWindowId);
    }
    return ctx;
  }

  /** End ownership synchronously, without moving or closing any browser page. */
  release(sessionId: string): SessionContext | null {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return null;
    this.detachLedgerWatchers.get(ctx)?.();
    this.sessions.delete(sessionId);
    this.windowIndex.delete(ctx.agentWindowId);
    this.activeAgentWindowIds.delete(ctx.agentWindowId);
    this.stagedBorrowedTabs.delete(sessionId);
    for (const [tabId, owner] of this.borrowReservations) {
      if (owner === sessionId) this.borrowReservations.delete(tabId);
    }
    void this.orphanLedger.removeWindow(ctx.agentWindowId);
    return ctx;
  }

  /**
   * Best-effort cleanup of every live session (emergency brake / SW
   * shutdown). Returns the set of `session_id`s that were removed.
   */
  async stopAll(options: { dropOnly?: boolean } = {}): Promise<string[]> {
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) {
      await this.stop(id, options);
    }
    return ids;
  }
}
