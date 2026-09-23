import { AGENT_WINDOW_HOME, type AgentWindowApi, chromeAgentWindowApi } from "./agent-window";
import { RefStore } from "./ref-store";
import type { SessionResourceJournal, SessionResourceRecord } from "./resource-journal";
import { chromeSharedWindowApi, type SharedWindowApi } from "./shared-window";

export interface SessionContext {
  /** Remote connections retain dedicated windows, with explicit page ownership. */
  remote?: boolean;
  sessionId: string;
  container:
    | { mode: "window"; agentWindowId: number }
    | { mode: "in_window"; hostWindowId: number }
    | { mode: "existing_tab"; hostWindowId: number; rootTabId: number };
  activeTabId?: number;
  pendingOperations?: number;
  stopping?: boolean;
  refStore: RefStore;
  borrowedTabs: Map<number, BorrowedTab>;
  /**
   * Tabs explicitly claimed by the agent because it created them. This
   * includes the Agent Window's home tab and tabs created by `tool.tab_create`.
   * Tabs opened through Chrome UI never enter this set.
   */
  agentCreatedTabs: Set<number>;
  createdAtMs: number;
}

export function sessionWindowId(ctx: SessionContext): number {
  return ctx.container.mode === "window" ? ctx.container.agentWindowId : ctx.container.hostWindowId;
}

export function isSharedSession(ctx: SessionContext): boolean {
  return ctx.container.mode !== "window";
}

/** Whether this session has explicitly claimed control of `tabId`. */
export function isAgentControlledTab(ctx: SessionContext, tabId: number): boolean {
  return ctx.agentCreatedTabs.has(tabId) || ctx.borrowedTabs.has(tabId);
}

export interface BorrowedTab {
  tabId: number;
  originalWindowId: number;
  originalIndex: number;
  stationary?: boolean;
}

export interface BorrowReservation {
  release(): void;
  commit(entry: BorrowedTab): void;
}

export interface SessionManagerOptions {
  remote?: () => boolean;
  agentWindow?: AgentWindowApi;
  sharedWindow?: SharedWindowApi;
  journal?: SessionResourceJournal;
  now?: () => number;
}

/** Options for starting a session's Agent Window. */
export interface SessionStartOptions {
  inWindow?: boolean;
  existingTab?: {
    tabId?: number;
    current?: boolean;
    approve(tabId: number): Promise<void>;
  };
  /** Optional Agent Window outer size in CSS pixels. */
  size?: { width: number; height: number };
  /** Defaults to true so existing clients keep visible Agent Windows. */
  focused?: boolean;
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

export class SharedSessionStartCleanupError extends Error {
  constructor(
    readonly tabId: number,
    startupError: unknown,
    cleanupError: unknown,
  ) {
    super(
      `Session startup failed: ${String(startupError)}; cleanup of tab ${tabId} failed: ${String(cleanupError)}`,
    );
    this.name = "SharedSessionStartCleanupError";
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

export function isMissingChromeResourceError(error: unknown): boolean {
  return /No (?:tab|window) with id|Invalid (?:tab|window) ID|not found/i.test(String(error));
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
export class SessionManager {
  private readonly remote: () => boolean;
  private readonly sessions = new Map<string, SessionContext>();
  private readonly windowIndex = new Map<number, string>();
  private readonly borrowReservations = new Map<number, string>();
  private readonly expectedWindowClosures = new WeakSet<SessionContext>();
  private readonly agentWindow: AgentWindowApi;
  private readonly journal?: SessionResourceJournal;
  private readonly now: () => number;
  private readonly sharedWindow: SharedWindowApi;
  private readonly starting = new Set<string>();
  private readonly emptyListeners = new Set<(ctx: SessionContext) => void>();

  constructor(options: SessionManagerOptions = {}) {
    this.remote = options.remote ?? (() => false);
    this.agentWindow = options.agentWindow ?? chromeAgentWindowApi;
    this.journal = options.journal;
    this.now = options.now ?? Date.now;
    this.sharedWindow = options.sharedWindow ?? chromeSharedWindowApi;
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
    const alreadyExpected = this.expectedWindowClosures.has(ctx);
    this.expectedWindowClosures.add(ctx);
    try {
      return await close();
    } finally {
      // Failed teardown must not hide a later user-initiated close.
      if (!alreadyExpected) this.expectedWindowClosures.delete(ctx);
    }
  }

  findByWindowId(windowId: number): SessionContext | null {
    const id = this.windowIndex.get(windowId);
    return id ? (this.sessions.get(id) ?? null) : null;
  }

  list(): SessionContext[] {
    return Array.from(this.sessions.values());
  }

  /** Restore a context whose resources were journaled by an earlier MV3 worker. */
  restore(record: SessionResourceRecord): SessionContext {
    const existing = this.sessions.get(record.sessionId);
    if (existing) return existing;
    const ctx: SessionContext = {
      sessionId: record.sessionId,
      container: record.container,
      ...(record.remote !== undefined ? { remote: record.remote } : {}),
      ...(record.activeTabId !== undefined ? { activeTabId: record.activeTabId } : {}),
      ...(record.phase !== "active" ? { stopping: true } : {}),
      refStore: new RefStore(),
      borrowedTabs: new Map(record.borrowedTabs.map((tab) => [tab.tabId, tab])),
      agentCreatedTabs: new Set(record.agentCreatedTabIds),
      createdAtMs: record.createdAtMs,
    };
    this.sessions.set(ctx.sessionId, ctx);
    if (ctx.container.mode === "window") {
      this.windowIndex.set(ctx.container.agentWindowId, ctx.sessionId);
    }
    return ctx;
  }

  persist(ctx: SessionContext): Promise<void> {
    return this.journal?.save(ctx) ?? Promise.resolve();
  }

  schedulePersist(ctx: SessionContext): void {
    void this.persist(ctx).catch((error) => {
      console.warn(`[bh] failed to persist session ${ctx.sessionId} resources`, error);
    });
  }

  isRemote(): boolean {
    return this.remote();
  }

  findByTabId(tabId: number): SessionContext | null {
    return this.list().find((ctx) => isAgentControlledTab(ctx, tabId)) ?? null;
  }

  canAutoAcceptDialog(tabId: number, windowId: number): boolean {
    const ctx = this.findByTabId(tabId) ?? this.findByWindowId(windowId);
    return (
      ctx !== null &&
      !ctx.stopping &&
      sessionWindowId(ctx) === windowId &&
      ((!ctx.remote && ctx.container.mode === "window") || isAgentControlledTab(ctx, tabId))
    );
  }

  sessionsInWindow(windowId: number): SessionContext[] {
    return this.list().filter((ctx) => sessionWindowId(ctx) === windowId);
  }

  onEmpty(listener: (ctx: SessionContext) => void): () => void {
    this.emptyListeners.add(listener);
    return () => this.emptyListeners.delete(listener);
  }

  checkEmpty(ctx: SessionContext): void {
    if (
      this.get(ctx.sessionId) !== ctx ||
      !isSharedSession(ctx) ||
      ctx.stopping ||
      ctx.pendingOperations ||
      this.isWindowCloseExpected(ctx) ||
      ctx.agentCreatedTabs.size ||
      ctx.borrowedTabs.size
    )
      return;
    for (const listener of this.emptyListeners) listener(ctx);
  }

  async withTabOperation<T>(ctx: SessionContext, action: () => Promise<T>): Promise<T> {
    if (ctx.stopping || this.get(ctx.sessionId) !== ctx) throw new Error("Session is stopping");
    ctx.pendingOperations = (ctx.pendingOperations ?? 0) + 1;
    try {
      return await action();
    } finally {
      ctx.pendingOperations--;
      this.checkEmpty(ctx);
    }
  }

  invalidateTabRefs(tabId: number): void {
    for (const ctx of this.sessions.values()) ctx.refStore.invalidateTab(tabId);
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
      const agentChanged = ctx.agentCreatedTabs.delete(tabId);
      const borrowChanged = !isWindowClosing && ctx.borrowedTabs.delete(tabId);
      if (agentChanged || borrowChanged) this.schedulePersist(ctx);
      if (!isWindowClosing) this.checkEmpty(ctx);
    }
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
      if (isAgentControlledTab(ctx, tabId)) return ctx.sessionId;
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
      this.borrowReservations.get(tabId) ?? this.findBorrowingSession(tabId, sessionId);
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
        if (!ctx || ctx.stopping) {
          release();
          throw new Error(`session ${sessionId} disappeared during tab_borrow`);
        }
        if (this.borrowReservations.get(tabId) !== sessionId) {
          throw new Error(`tab ${tabId} borrow reservation disappeared before commit`);
        }
        ctx.borrowedTabs.set(tabId, entry);
        release();
      },
    };
  }

  /**
   * Create a dedicated window or a shared-host tab and register the context.
   *
   * The context records window location separately from resource ownership.
   */
  async start(sessionId: string, opts: SessionStartOptions = {}): Promise<SessionContext> {
    if (this.sessions.has(sessionId) || this.starting.has(sessionId)) {
      throw new Error(`[bh] session ${sessionId} already exists`);
    }
    throwIfSessionStartAborted(opts.signal);

    if (opts.existingTab) return this.startExistingTab(sessionId, opts);
    if (opts.inWindow) return this.startShared(sessionId, opts);

    this.starting.add(sessionId);
    let windowId: number | null = null;
    const agentCreatedTabs = new Set<number>();
    let ctx: SessionContext | undefined;
    try {
      const { signal: _signal, ...createOptions } = opts;
      const created = await this.agentWindow.create(AGENT_WINDOW_HOME, createOptions);
      windowId = created.windowId;
      for (const tabId of created.initialTabIds) agentCreatedTabs.add(tabId);
      ctx = {
        ...(this.remote() ? { remote: true } : {}),
        sessionId,
        container: { mode: "window", agentWindowId: windowId },
        refStore: new RefStore(),
        borrowedTabs: new Map(),
        agentCreatedTabs,
        createdAtMs: this.now(),
      };
      // Checkpoint immediately after Chrome returns the physical window id.
      // Any later MV3 worker restart can now recover and close this resource.
      this.sessions.set(sessionId, ctx);
      this.windowIndex.set(windowId, sessionId);
      await this.persist(ctx);
      throwIfSessionStartAborted(opts.signal);
      const homeTabId = await this.agentWindow.ensureActiveTab(
        windowId,
        AGENT_WINDOW_HOME,
        agentCreatedTabs,
      );
      agentCreatedTabs.add(homeTabId);
      await this.persist(ctx);
      throwIfSessionStartAborted(opts.signal);
      return ctx;
    } catch (startupError) {
      if (windowId !== null) {
        try {
          await this.agentWindow.remove(windowId);
        } catch (cleanupError) {
          // The daemon may retry stop after a failed startup rollback. Retain
          // the exact window handle until closure is confirmed.
          const pending: SessionContext =
            ctx ??
            {
              ...(this.remote() ? { remote: true } : {}),
              sessionId,
              container: { mode: "window", agentWindowId: windowId },
              refStore: new RefStore(),
              borrowedTabs: new Map(),
              agentCreatedTabs,
              createdAtMs: this.now(),
            };
          this.sessions.set(sessionId, pending);
          this.windowIndex.set(windowId, sessionId);
          await this.journal?.save(pending, "cleanup_failed", String(cleanupError));
          throw new SessionStartCleanupError(windowId, startupError, cleanupError);
        }
        this.sessions.delete(sessionId);
        this.windowIndex.delete(windowId);
        await this.journal?.remove(sessionId);
      }
      throw startupError;
    } finally {
      this.starting.delete(sessionId);
    }
  }

  private async startExistingTab(
    sessionId: string,
    opts: SessionStartOptions,
  ): Promise<SessionContext> {
    if (this.remote()) throw new Error("Existing tabs are unsupported for remote connections");
    if (opts.size) throw new Error("Window dimensions cannot be used with an existing tab");
    const target = opts.existingTab;
    if (!target || (target.current === true) === (target.tabId !== undefined)) {
      throw new Error("Choose exactly one existing-tab target");
    }
    this.starting.add(sessionId);
    let reservation: BorrowReservation | undefined;
    let registered = false;
    try {
      let tab: chrome.tabs.Tab;
      if (target.current) {
        const host = await this.sharedWindow.host();
        if (host.id === undefined || host.incognito || host.type !== "normal") {
          throw new Error("Focus a normal user tab before starting an existing-tab session");
        }
        if (!this.sharedWindow.active) throw new Error("Active-tab lookup is unavailable");
        tab = await this.sharedWindow.active(host.id);
      } else {
        tab = await this.sharedWindow.get(target.tabId!);
      }
      if (tab.id === undefined || tab.windowId === undefined || tab.incognito) {
        throw new Error("The selected tab is unavailable or ineligible");
      }
      if (this.sharedWindow.window) {
        const host = await this.sharedWindow.window(tab.windowId);
        if (host.incognito || host.type !== "normal") {
          throw new Error("The selected tab must belong to a normal user window");
        }
      }
      if (
        this.findByTabId(tab.id) ||
        this.list().some(
          (session) =>
            session.container.mode === "window" && session.container.agentWindowId === tab.windowId,
        )
      ) {
        throw new Error("The selected tab is already controlled by another session");
      }
      const claimed = this.tryReserveBorrow(tab.id, sessionId);
      if ("borrowedBy" in claimed) {
        throw new Error(`The selected tab is already controlled by session ${claimed.borrowedBy}`);
      }
      reservation = claimed;
      throwIfSessionStartAborted(opts.signal);
      await target.approve(tab.id);
      throwIfSessionStartAborted(opts.signal);

      const current = await this.sharedWindow.get(tab.id);
      if (
        current.id !== tab.id ||
        current.windowId === undefined ||
        current.incognito ||
        this.findByTabId(tab.id)
      ) {
        throw new Error("The selected tab changed while approval was pending");
      }
      if (this.sharedWindow.window) {
        const currentHost = await this.sharedWindow.window(current.windowId);
        if (currentHost.incognito || currentHost.type !== "normal") {
          throw new Error("The selected tab moved out of a normal user window");
        }
      }
      const ctx: SessionContext = {
        sessionId,
        container: {
          mode: "existing_tab",
          hostWindowId: current.windowId,
          rootTabId: tab.id,
        },
        activeTabId: tab.id,
        refStore: new RefStore(),
        borrowedTabs: new Map(),
        agentCreatedTabs: new Set(),
        createdAtMs: this.now(),
      };
      this.sessions.set(sessionId, ctx);
      registered = true;
      reservation.commit({
        tabId: tab.id,
        originalWindowId: current.windowId,
        originalIndex: typeof current.index === "number" ? current.index : 0,
        stationary: true,
      });
      await this.persist(ctx);
      return ctx;
    } catch (error) {
      if (registered) {
        this.sessions.delete(sessionId);
        await this.journal?.remove(sessionId).catch(() => {});
      }
      throw error;
    } finally {
      reservation?.release();
      this.starting.delete(sessionId);
    }
  }

  private async startShared(sessionId: string, opts: SessionStartOptions): Promise<SessionContext> {
    if (this.remote()) throw new Error("Shared windows are unsupported for remote connections");
    if (opts.size) throw new Error("Window dimensions cannot be used with in_window");
    this.starting.add(sessionId);
    let tabId: number | undefined;
    let ctx: SessionContext | undefined;
    let reclaimed = false;
    try {
      const host = await this.sharedWindow.host();
      if (
        host.id === undefined ||
        host.incognito ||
        host.type !== "normal" ||
        this.findByWindowId(host.id)
      ) {
        throw new Error("Focus a normal user window before starting an in-window session");
      }
      throwIfSessionStartAborted(opts.signal);
      tabId = await this.sharedWindow.create(host.id, opts.focused !== false);
      ctx = {
        sessionId,
        container: { mode: "in_window", hostWindowId: host.id },
        activeTabId: tabId,
        refStore: new RefStore(),
        borrowedTabs: new Map(),
        agentCreatedTabs: new Set([tabId]),
        createdAtMs: this.now(),
      };
      // Persist the concrete tab id before any post-create validation awaits.
      this.sessions.set(sessionId, ctx);
      await this.persist(ctx);
      throwIfSessionStartAborted(opts.signal);
      const tab = await this.sharedWindow.get(tabId);
      if (tab.windowId !== host.id) {
        reclaimed = true;
        throw new Error("Session tab moved during startup");
      }
      if (opts.focused !== false) await this.sharedWindow.focus?.(host.id);
      const finalTab = await this.sharedWindow.get(tabId);
      if (finalTab.windowId !== host.id) {
        reclaimed = true;
        throw new Error("Session tab moved during startup");
      }
      throwIfSessionStartAborted(opts.signal);
      return ctx;
    } catch (error) {
      if (tabId !== undefined && !reclaimed) {
        try {
          await this.sharedWindow.remove(tabId);
        } catch (cleanup) {
          if (isMissingChromeResourceError(cleanup)) throw error;
          // Keep a retryable claim, never use window removal as a fallback.
          if (ctx) {
            this.sessions.set(sessionId, ctx);
            await this.journal?.save(ctx, "cleanup_failed", String(cleanup));
          }
          throw new SharedSessionStartCleanupError(tabId, error, cleanup);
        }
        this.sessions.delete(sessionId);
        await this.journal?.remove(sessionId);
      } else if (reclaimed) {
        this.sessions.delete(sessionId);
        await this.journal?.remove(sessionId);
      }
      throw error;
    } finally {
      this.starting.delete(sessionId);
    }
  }

  /**
   * Tear down owned resources and drop the context. Shared hosts are never removed.
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
    if (!options.dropOnly && isSharedSession(ctx)) {
      // These are normal refusal conditions, not attempted cleanup failures.
      // Leave the journal in its healthy active phase so recovery does not
      // resurrect a session as permanently stopping.
      if (ctx.pendingOperations) throw new Error("Session has pending tab operations");
      if (ctx.borrowedTabs.size)
        throw new Error("Return borrowed tabs before stopping this session");
    }
    try {
      if (!options.dropOnly) {
        ctx.stopping = true;
        await this.journal?.save(ctx, "stopping");
        if (ctx.container.mode === "window") {
          try {
            await this.agentWindow.remove(ctx.container.agentWindowId);
          } catch (err) {
            // A user may close an Agent Window while the MV3 worker is asleep.
            // Normal/recovery stop is idempotent: a confirmed-missing window
            // is already cleaned. Transactional start rollback calls
            // agentWindow.remove directly and deliberately stays strict.
            if (!isMissingChromeResourceError(err)) throw err;
          }
        } else {
          for (const tabId of [...ctx.agentCreatedTabs]) {
            try {
              const tab = await this.sharedWindow.get(tabId);
              // Moving a shared session page out is a user reclaim, including
              // when onAttached has not yet reached the service worker.
              if (tab.windowId === ctx.container.hostWindowId)
                await this.sharedWindow.remove(tabId);
            } catch (err) {
              if (!isMissingChromeResourceError(err)) throw err;
            }
            ctx.agentCreatedTabs.delete(tabId);
            await this.persist(ctx);
          }
        }
      }
      await this.journal?.remove(sessionId);
    } catch (err) {
      ctx.stopping = false;
      await this.journal?.save(ctx, "cleanup_failed", String(err)).catch(() => {});
      throw err;
    }
    this.sessions.delete(sessionId);
    if (ctx.container.mode === "window") this.windowIndex.delete(ctx.container.agentWindowId);
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
