/**
 * Tracks the bsk sessions this plugin created and the "current" session
 * pointer used when a tool call omits its optional `session` arg. The pointer
 * moves to whatever session was most recently started, stopped, or operated
 * on, so a model can run several browsers side by side without repeating the
 * id on every call.
 *
 * Strict ownership boundary (the bsk daemon may be shared with other agents,
 * terminals, or dsh instances): the registry ONLY ever holds sessions created
 * by this plugin's browser_session_start. Tools cannot see or act on any
 * other session — an explicit `session` argument naming a foreign id is an
 * error, the list tool shows owned sessions only, and stop/unload cleanup
 * can never touch a session this plugin did not create.
 */

export interface TrackedSession {
  sessionId: string;
  browserInstanceId?: string;
  startedAtMs: number;
  /** Always true: only plugin-created sessions enter the registry at all. */
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
   * Register a freshly started session, consuming its reservation, and make
   * it current.
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

  /** Mark an owned session as most recently used (recency order refresh). */
  private touch(sessionId: string): void {
    const existing = this.sessions.get(sessionId);
    if (existing === undefined) return;
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, existing);
    this.currentId = sessionId;
  }

  /** The current session id, if any. */
  current(): string | undefined {
    return this.currentId;
  }

  /** Owned sessions in least- to most-recently-used order. */
  list(): TrackedSession[] {
    return [...this.sessions.values()];
  }

  /** Ids of owned sessions — the exact set unload cleanup is allowed to stop. */
  ownedIds(): string[] {
    return this.list()
      .filter((session) => session.owned)
      .map((session) => session.sessionId);
  }

  /** Whether the session was created by this plugin. */
  isOwned(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.owned === true;
  }

  size(): number {
    return this.sessions.size;
  }

  /** Shared not-yours error for foreign or unknown session ids. */
  private foreignError(sessionId: string, toolName: string): Error {
    return new Error(
      `${toolName}: session "${sessionId}" does not belong to this plugin — only sessions ` +
        "created by browser_session_start are visible and operable here",
    );
  }

  /**
   * Resolve the session a tool call acts on: an explicit `session` argument
   * must name an owned session (and becomes current); omitted falls back to
   * the current session. Foreign ids are rejected, never adopted.
   * @throws on foreign/unknown ids, or when no session exists.
   */
  resolve(explicit: string | undefined, toolName: string): string {
    if (explicit !== undefined && explicit.trim().length > 0) {
      if (!this.isOwned(explicit)) throw this.foreignError(explicit, toolName);
      this.touch(explicit);
      return explicit;
    }
    const current = this.current();
    if (current === undefined) {
      throw new Error(
        `${toolName} needs a session but none is active — start one with browser_session_start`,
      );
    }
    this.touch(current);
    return current;
  }

  /**
   * Resolve the session a STOP call acts on. Same ownership rule as every
   * other tool; a rejected stop never moves the current pointer.
   */
  resolveForStop(explicit: string | undefined): string {
    const candidate =
      explicit !== undefined && explicit.trim().length > 0 ? explicit : this.current();
    if (candidate === undefined) {
      throw new Error(
        "browser_session_stop needs a session but none is active — start one with browser_session_start",
      );
    }
    if (!this.isOwned(candidate)) throw this.foreignError(candidate, "browser_session_stop");
    return candidate;
  }
}
