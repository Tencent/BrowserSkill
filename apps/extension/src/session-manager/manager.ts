import { AGENT_WINDOW_HOME, type AgentWindowApi, chromeAgentWindowApi } from "./agent-window";
import { RefStore } from "./ref-store";

export interface SessionContext {
  sessionId: string;
  agentWindowId: number;
  refStore: RefStore;
  borrowedTabs: Map<number, BorrowedTab>;
  /**
   * Tabs created by the agent via `tool.tab_create` in this session's
   * Agent Window. Tracked so `session_stop` can close them before
   * releasing the window (design §3.1). User-created tabs (via Chrome UI)
   * never enter this set.
   */
  agentCreatedTabs: Set<number>;
  /**
   * Tabs the user opened themselves inside the Agent Window via Chrome UI
   * (new-tab button, Cmd+T, right-click → open in new tab, …). These must
   * NOT be controlled by the agent overlay and must be left free for the
   * user to operate. Distinguishing them from agent-created tabs is done
   * by the `chrome.tabs.onCreated` listener in background.ts, which consults
   * `pendingAgentTabCount` to tell "opened via tool.tab_create" apart from
   * "opened by the user".
   */
  userTabs: Set<number>;
  /**
   * Number of agent tabs currently being created via `tool.tab_create` but
   * whose `onCreated` event has not yet been observed. `handleTabCreate`
   * increments this *before* calling `chrome.tabs.create`; the
   * `onCreated` listener decrements it once per new tab in the Agent Window.
   * This lets us tell agent-created tabs from user-created tabs even though
   * both fire `onCreated` (design §3.1, user-tab freedom fix).
   */
  pendingAgentTabCount: number;
  /**
   * Id of the home tab created/activated when the session started
   * (`ensureActiveTab`). Used to clean up the home tab precisely on
   * stop instead of matching by URL (design §3.2).
   */
  homeTabId: number | null;
  createdAtMs: number;
}

export interface BorrowedTab {
  tabId: number;
  originalWindowId: number;
  originalIndex: number;
}

export interface BorrowReservation {
  release(): void;
  commit(entry: BorrowedTab): void;
}

export interface SessionManagerOptions {
  agentWindow?: AgentWindowApi;
  now?: () => number;
}

/** Options for starting a session's Agent Window. */
export interface SessionStartOptions {
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
  private readonly sessions = new Map<string, SessionContext>();
  private readonly windowIndex = new Map<number, string>();
  private readonly borrowReservations = new Map<number, string>();
  private readonly agentWindow: AgentWindowApi;
  private readonly now: () => number;

  constructor(options: SessionManagerOptions = {}) {
    this.agentWindow = options.agentWindow ?? chromeAgentWindowApi;
    this.now = options.now ?? Date.now;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get(sessionId: string): SessionContext | null {
    return this.sessions.get(sessionId) ?? null;
  }

  findByWindowId(windowId: number): SessionContext | null {
    const id = this.windowIndex.get(windowId);
    return id ? (this.sessions.get(id) ?? null) : null;
  }

  list(): SessionContext[] {
    return Array.from(this.sessions.values());
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
    const borrowedBy = this.findBorrowingSession(tabId, sessionId);
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
        ctx.borrowedTabs.set(tabId, entry);
        release();
      },
    };
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
    try {
      const { signal: _signal, ...createOptions } = opts;
      windowId = await this.agentWindow.create(AGENT_WINDOW_HOME, createOptions);
      throwIfSessionStartAborted(opts.signal);
      const homeTabId = await this.agentWindow.ensureActiveTab(windowId, AGENT_WINDOW_HOME);
      throwIfSessionStartAborted(opts.signal);

      const ctx: SessionContext = {
        sessionId,
        agentWindowId: windowId,
        refStore: new RefStore(),
        borrowedTabs: new Map(),
        agentCreatedTabs: new Set(),
        userTabs: new Set(),
        pendingAgentTabCount: 0,
        homeTabId,
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
          throw new SessionStartCleanupError(windowId, startupError, cleanupError);
        }
      }
      throw startupError;
    }
  }

  /**
   * Record that a `tool.tab_create` is about to open a tab. Called *before*
   * `chrome.tabs.create` so the pending count is visible to the
   * `onCreated` listener that will fire for the new tab.
   */
  markAgentTabPending(windowId: number): void {
    const ctx = this.findByWindowId(windowId);
    if (!ctx) return;
    ctx.pendingAgentTabCount += 1;
  }

  /**
   * Release a pending `tool.tab_create` slot when the create itself failed
   * and no `chrome.tabs.onCreated` event will arrive to consume it. Without
   * this the counter leaks and the *next* tab the user opens is misclassified
   * as agent-created — the exact confusion this counter exists to prevent.
   */
  releaseAgentTabPending(windowId: number): void {
    const ctx = this.findByWindowId(windowId);
    if (!ctx || ctx.pendingAgentTabCount === 0) return;
    ctx.pendingAgentTabCount -= 1;
  }

  /**
   * Called by the `onCreated` listener for each new tab in an Agent Window.
   * Returns `"agent"` when the tab is the window's home tab or corresponds to
   * a pending `tool.tab_create` (and registers it), `"user"` when the user
   * opened it via Chrome UI.
   */
  classifyNewTab(tabId: number, windowId: number): "agent" | "user" | "unknown" {
    const ctx = this.findByWindowId(windowId);
    if (!ctx) return "unknown";
    // The home tab is agent-owned. Its `onCreated` fires before any
    // window-initialising flag would be observable, so we match it by home
    // tab id rather than by boot timing (which left the branch unreachable).
    if (tabId === ctx.homeTabId || ctx.pendingAgentTabCount > 0) {
      if (ctx.pendingAgentTabCount > 0) ctx.pendingAgentTabCount -= 1;
      ctx.agentCreatedTabs.add(tabId);
      return "agent";
    }
    ctx.userTabs.add(tabId);
    return "user";
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
    this.sessions.delete(sessionId);
    this.windowIndex.delete(ctx.agentWindowId);
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
