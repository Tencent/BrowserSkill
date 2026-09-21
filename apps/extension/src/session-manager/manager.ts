import { AGENT_WINDOW_HOME, type AgentWindowApi, chromeAgentWindowApi } from "./agent-window";
import { RefStore } from "./ref-store";
import { chromeSharedWindowApi, type SharedWindowApi } from "./shared-window";

export interface SessionContext {
  /** Remote connections retain dedicated windows, with explicit page ownership. */
  remote?: boolean;
  sessionId: string;
  container:
    | { mode: "window"; agentWindowId: number }
    | { mode: "in_window"; hostWindowId: number };
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
  return ctx.container.mode === "in_window";
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
  now?: () => number;
}

/** Options for starting a session's Agent Window. */
export interface SessionStartOptions {
  inWindow?: boolean;
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
  private readonly now: () => number;
  private readonly sharedWindow: SharedWindowApi;
  private readonly starting = new Set<string>();
  private readonly emptyListeners = new Set<(ctx: SessionContext) => void>();

  constructor(options: SessionManagerOptions = {}) {
    this.remote = options.remote ?? (() => false);
    this.agentWindow = options.agentWindow ?? chromeAgentWindowApi;
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
      ctx.agentCreatedTabs.delete(tabId);
      if (!isWindowClosing) ctx.borrowedTabs.delete(tabId);
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

    if (opts.inWindow) return this.startShared(sessionId, opts);

    let windowId: number | null = null;
    const agentCreatedTabs = new Set<number>();
    try {
      const { signal: _signal, ...createOptions } = opts;
      const created = await this.agentWindow.create(AGENT_WINDOW_HOME, createOptions);
      windowId = created.windowId;
      for (const tabId of created.initialTabIds) agentCreatedTabs.add(tabId);
      throwIfSessionStartAborted(opts.signal);
      const homeTabId = await this.agentWindow.ensureActiveTab(
        windowId,
        AGENT_WINDOW_HOME,
        agentCreatedTabs,
      );
      agentCreatedTabs.add(homeTabId);
      throwIfSessionStartAborted(opts.signal);

      const ctx: SessionContext = {
        ...(this.remote() ? { remote: true } : {}),
        sessionId,
        container: { mode: "window", agentWindowId: windowId },
        refStore: new RefStore(),
        borrowedTabs: new Map(),
        // Capture ownership at creation, before initialization can fail.
        // Later tabs remain free until `tab_create` or `tab_borrow` identifies
        // them by their concrete Chrome tab id.
        agentCreatedTabs,
        createdAtMs: this.now(),
      };
      this.sessions.set(sessionId, ctx);
      this.windowIndex.set(windowId, sessionId);
      return ctx;
    } catch (startupError) {
      if (windowId !== null) {
        try {
          await this.agentWindow.remove(windowId);
        } catch (cleanupError) {
          // The daemon may retry stop after a failed startup rollback. Retain
          // the exact window handle until closure is confirmed.
          const pending: SessionContext = {
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
          throw new SessionStartCleanupError(windowId, startupError, cleanupError);
        }
      }
      throw startupError;
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
      this.sessions.set(sessionId, ctx);
      return ctx;
    } catch (error) {
      if (tabId !== undefined && !reclaimed) {
        try {
          await this.sharedWindow.remove(tabId);
        } catch (cleanup) {
          if (/No tab with id|Invalid tab ID|not found/i.test(String(cleanup))) throw error;
          // Keep a retryable claim, never use window removal as a fallback.
          if (ctx) this.sessions.set(sessionId, ctx);
          throw new SharedSessionStartCleanupError(tabId, error, cleanup);
        }
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
    if (!options.dropOnly) {
      if (ctx.container.mode === "window")
        await this.agentWindow.remove(ctx.container.agentWindowId);
      else {
        if (ctx.pendingOperations) throw new Error("Session has pending tab operations");
        // Borrowed pages must be returned by the tool-level teardown first.
        if (ctx.borrowedTabs.size)
          throw new Error("Return borrowed tabs before stopping this session");
        ctx.stopping = true;
        try {
          for (const tabId of [...ctx.agentCreatedTabs]) {
            try {
              const tab = await this.sharedWindow.get(tabId);
              // Moving a shared session page out is a user reclaim, including
              // when onAttached has not yet reached the service worker.
              if (tab.windowId === ctx.container.hostWindowId)
                await this.sharedWindow.remove(tabId);
            } catch (err) {
              if (!/No tab with id|Invalid tab ID|not found/i.test(String(err))) throw err;
            }
            ctx.agentCreatedTabs.delete(tabId);
          }
        } catch (err) {
          ctx.stopping = false;
          throw err;
        }
      }
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
