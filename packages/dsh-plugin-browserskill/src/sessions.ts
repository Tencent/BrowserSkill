/**
 * Tracks the bsk sessions started through this plugin and the "current"
 * session pointer used when a tool call omits its optional `session` arg.
 * The pointer moves to whatever session was most recently started, stopped,
 * or operated on, so a model can run several browsers side by side without
 * repeating the id on every call.
 */

export interface TrackedSession {
  sessionId: string;
  browserInstanceId?: string;
  startedAtMs: number;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, TrackedSession>();
  private currentId: string | undefined;

  constructor(private readonly maxSessions: number) {}

  /**
   * Register a freshly started session and make it current.
   * @throws when the configured concurrency cap is already reached.
   */
  add(session: TrackedSession): void {
    if (!this.sessions.has(session.sessionId)) this.assertCapacity();
    this.sessions.set(session.sessionId, session);
    this.currentId = session.sessionId;
  }

  /**
   * Throw when starting another session would exceed the concurrency cap.
   * Call BEFORE spawning a new session so a rejected start never leaks one.
   */
  assertCapacity(): void {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(
        `session limit reached (${this.maxSessions} concurrent sessions); ` +
          "stop one with browser_session_stop before starting another",
      );
    }
  }

  /** Forget a stopped session; falls back to the most recent remaining one. */
  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
    if (this.currentId === sessionId) {
      const rest = [...this.sessions.values()];
      this.currentId = rest.length > 0 ? rest[rest.length - 1].sessionId : undefined;
    }
  }

  /** Mark a session as most recently used. Unknown ids are adopted. */
  touch(sessionId: string): void {
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      // Re-insert to refresh recency order.
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, existing);
    } else {
      this.sessions.set(sessionId, { sessionId, startedAtMs: Date.now() });
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

  size(): number {
    return this.sessions.size;
  }

  /**
   * Resolve the session a tool call acts on: an explicit `session` argument
   * wins (and becomes current); otherwise fall back to the current session.
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
}
