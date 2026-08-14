/**
 * Tracks the bsk sessions started through this plugin and the "current"
 * session pointer used when a tool call omits its optional `session` arg.
 * The pointer moves to whatever session was most recently started, stopped,
 * or operated on, so a model can run several browsers side by side without
 * repeating the id on every call.
 *
 * Ownership discipline (the bsk daemon may be shared with other agents,
 * terminals, or dsh instances): a session is **owned** only when it was
 * created by this plugin's browser_session_start; an explicit `session`
 * argument naming a foreign session is tracked as a **reference** so the
 * current-session pointer keeps working, but referenced sessions are never
 * stopped — not by browser_session_stop and not by unload cleanup.
 */

export interface TrackedSession {
  sessionId: string;
  browserInstanceId?: string;
  startedAtMs: number;
  /** True only for sessions this plugin created (and therefore may stop). */
  owned: boolean;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, TrackedSession>();
  private currentId: string | undefined;
  /**
   * Slots reserved by in-flight starts. reserveStart/completeStart/abandonStart
   * run synchronously around the async spawn, so concurrent starts can never
   * both pass the capacity check (check-and-reserve is atomic on the event loop).
   */
  private pendingStarts = 0;

  constructor(private readonly maxSessions: number) {}

  /**
   * Reserve a start slot synchronously, BEFORE spawning.
   * @throws when the configured concurrency cap (tracked + in-flight) is reached.
   */
  reserveStart(): void {
    if (this.sessions.size + this.pendingStarts >= this.maxSessions) {
      throw new Error(
        `session limit reached (${this.maxSessions} concurrent sessions); ` +
          "stop one with browser_session_stop before starting another",
      );
    }
    this.pendingStarts += 1;
  }

  /** Give back a reservation after a start that never produced a session. */
  abandonStart(): void {
    this.pendingStarts = Math.max(0, this.pendingStarts - 1);
  }

  /**
   * Register a freshly started (owned) session, consuming its reservation,
   * and make it current.
   */
  completeStart(session: Omit<TrackedSession, "owned">): void {
    this.pendingStarts = Math.max(0, this.pendingStarts - 1);
    // Backstop only: with the reservation protocol above this never fires.
    if (!this.sessions.has(session.sessionId) && this.sessions.size >= this.maxSessions) {
      throw new Error(
        `session limit reached (${this.maxSessions} concurrent sessions); ` +
          "stop one with browser_session_stop before starting another",
      );
    }
    this.sessions.set(session.sessionId, { ...session, owned: true });
    this.currentId = session.sessionId;
  }

  /** Forget a session; falls back to the most recent remaining one. */
  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
    if (this.currentId === sessionId) {
      const rest = [...this.sessions.values()];
      this.currentId = rest.length > 0 ? rest[rest.length - 1].sessionId : undefined;
    }
  }

  /** Mark a session as most recently used. Unknown ids are adopted as references (never owned). */
  touch(sessionId: string): void {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      // Re-insert to refresh recency order.
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, existing);
    } else {
      this.sessions.set(sessionId, { sessionId, startedAtMs: Date.now(), owned: false });
    }
    this.currentId = sessionId;
  }

  /** The current session id, if any. */
  current(): string | undefined {
    return this.currentId;
  }

  /** Tracked sessions in least- to most-recently-used order. */
  list(): TrackedSession[] {
    return [...this.sessions.values()];
  }

  /** Ids of owned sessions — the exact set unload cleanup is allowed to stop. */
  ownedIds(): string[] {
    return this.list()
      .filter((session) => session.owned)
      .map((session) => session.sessionId);
  }

  /** Whether the session was created by this plugin and may be stopped by it. */
  isOwned(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.owned === true;
  }

  size(): number {
    return this.sessions.size;
  }

  /**
   * Resolve the session an operation tool call acts on: an explicit `session`
   * argument wins (and becomes current); otherwise fall back to the current
   * session. Foreign ids are adopted as references.
   * @throws when neither is available.
   */
  resolve(explicit: string | undefined, toolName: string): string {
    if (explicit !== undefined && explicit.trim().length > 0) {
      this.touch(explicit);
      return explicit;
    }
    const current = this.current();
    if (current === undefined) {
      throw new Error(
        `${toolName} needs a session but none is active — start one with browser_session_start ` +
          "or pass an explicit `session` id",
      );
    }
    this.touch(current);
    return current;
  }

  /**
   * Resolve the session a STOP call acts on, without adopting foreign ids:
   * only owned sessions may be stopped, and the current pointer is not moved
   * by a rejected stop.
   * @throws when the target is unknown, foreign, or no session exists.
   */
  resolveForStop(explicit: string | undefined): string {
    const candidate =
      explicit !== undefined && explicit.trim().length > 0 ? explicit : this.current();
    if (candidate === undefined) {
      throw new Error(
        "browser_session_stop needs a session but none is active — start one with browser_session_start " +
          "or pass an explicit `session` id",
      );
    }
    if (!this.isOwned(candidate)) {
      throw new Error(
        `browser_session_stop refuses to stop session "${candidate}": it was not created by this plugin. ` +
          "Only sessions returned by browser_session_start can be stopped (use `bsk session stop` yourself for others).",
      );
    }
    return candidate;
  }
}
