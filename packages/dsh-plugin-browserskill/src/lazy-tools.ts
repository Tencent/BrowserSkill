/**
 * Lazy tool-schema injection ("progressive disclosure", final stage): with
 * `lazyTools` on (the default), the six browser tool schemas stay OUT of the
 * system prompt until the `browser-skill` skill has actually been invoked —
 * the skill catalog entry is the only advertisement. One successful
 * invocation (model tool call, or a user's `/browser-skill` gesture) reveals
 * the whole suite for the rest of the process lifetime; repeated invocations
 * are idempotent no-ops. Session resume is covered by scanning durable
 * session events for a past successful invocation (tool/call + tool/result
 * pair, or a skill-invocation sourced message) when a session is entered or
 * first observed after a reload. Later events are consumed incrementally.
 *
 * Verified against dsh 0.1 (recorded in the PR ticket):
 * - `tools/result(exec, result)`: exec carries normalized `name`/`arguments`,
 *   result is discriminated by `isError` — the model-invocation trigger.
 * - There is NO official global tool-visibility switch (`ctx.tools.restrict`
 *   is agent-scoped and throws from a plain host context), so conditional
 *   registration + this hook is the intended pattern; the registry supports
 *   mid-flight register/dispose with an unfiltered `tools/change` notice, and
 *   tool-skill's per-step catalog digest treats visibility changes as a
 *   first-class cache-invalidation input — the suite simply appears in the
 *   NEXT step's assembly.
 * - Durable results use message.source.callId and a tool-result content
 *   block. Older hosts stored callId/isError directly on the message.
 */

import type { Context } from "@deepseek-ai/cordis";
import { BSK_SKILL_NAME } from "./skill-content.generated";

/** Structural view of the pieces of the session seam we consume. */
interface SessionLike {
  events?: readonly SessionEventLike[];
  snapshotEvents?(): readonly SessionEventLike[];
}
interface SessionEventLike {
  type: string;
  data?: unknown;
}
interface SessionsLike {
  list(): SessionLike[];
}

interface ToolResultExecutionLike {
  name: string;
  arguments?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isCallId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Accept current DSH messages and the older flat tool-result shape. */
function toolResultOf(data: unknown): { callId: string; isError: boolean } | undefined {
  const message = record(record(data)?.message);
  if (message === undefined) return;
  const source = record(message.source);
  if (source?.kind === "tool") {
    const blocks = message.content;
    const block = Array.isArray(blocks) && blocks.length === 1 ? record(blocks[0]) : undefined;
    if (
      isCallId(source.callId) &&
      block?.type === "tool-result" &&
      block.toolCallId === source.callId &&
      typeof block.isError === "boolean"
    ) {
      return { callId: source.callId, isError: block.isError };
    }
    return;
  }
  if (isCallId(message.callId) && typeof message.isError === "boolean") {
    return { callId: message.callId, isError: message.isError };
  }
}

/** One session's append-only history fold; retain only unsettled skill calls. */
class SkillInvocationState {
  successful = false;
  private readonly pending = new Set<string>();

  consume(event: SessionEventLike): void {
    if (this.successful) return;
    if (event.type === "user/message" && isSkillInvocationMessage(event.data)) {
      this.successful = true;
    } else if (event.type === "tool/call") {
      const data = record(event.data);
      if (
        data?.name === "skill" &&
        skillNameOf(data.arguments) === BSK_SKILL_NAME &&
        isCallId(data.callId)
      ) {
        this.pending.add(data.callId);
      }
    } else if (event.type === "tool/result") {
      const result = toolResultOf(event.data);
      if (result !== undefined && this.pending.delete(result.callId)) {
        this.successful = !result.isError;
      }
    }
    if (this.successful) this.pending.clear();
  }
}

/** Parse a tool arguments payload that may be normalized (object) or raw JSON. */
function skillNameOf(args: unknown): string | undefined {
  if (typeof args === "string") {
    try {
      return skillNameOf(JSON.parse(args));
    } catch {
      return undefined;
    }
  }
  if (typeof args === "object" && args !== null && "name" in args) {
    const name = (args as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

function isSkillInvocationMessage(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const source = (data as { source?: unknown }).source;
  if (typeof source !== "object" || source === null) return false;
  const { kind, name } = source as { kind?: unknown; name?: unknown };
  return kind === "skill-invocation" && name === BSK_SKILL_NAME;
}

/**
 * A durable log proves the skill was successfully invoked when a successful
 * `tool/result` pairs a `tool/call` for skill/browser-skill — or when a
 * `/browser-skill` user gesture landed as a skill-invocation message.
 */
export function hasSuccessfulSkillInvocation(events: readonly SessionEventLike[]): boolean {
  const state = new SkillInvocationState();
  for (const event of events) {
    state.consume(event);
    if (state.successful) return true;
  }
  return false;
}

/**
 * Arm the lazy reveal. Returns a disposer tearing down listeners and — when
 * the reveal already happened — the tool suite itself.
 * @param registerSuite - registers the six browser tools and returns their disposer.
 */
export function armLazyTools(ctx: Context, registerSuite: () => () => void): () => void {
  let disposed = false;
  let revealPending = false;
  let sessionStates = new WeakMap<SessionLike, SkillInvocationState>();
  let suiteDisposer: (() => void) | undefined;
  const disposers: (() => void)[] = [];
  const ensureSuite = (): void => {
    if (disposed || suiteDisposer !== undefined) return;
    try {
      suiteDisposer = registerSuite();
      revealPending = false;
      sessionStates = new WeakMap();
    } catch (error) {
      // Keep successful invocation proof, but retry only at a lifecycle
      // boundary or a new invocation, never on every streaming chunk.
      suiteDisposer = undefined;
      revealPending = true;
      console.warn(
        `[dsh-plugin-browserskill] lazy tool registration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  // Live trigger: a successful model invocation of skill/browser-skill.
  const onToolResult = (exec: ToolResultExecutionLike, result: { isError: boolean }): void => {
    if (result.isError !== false) return;
    if (exec.name !== "skill") return;
    if (skillNameOf(exec.arguments) === BSK_SKILL_NAME) ensureSuite();
  };
  disposers.push(ctx.on("tools/result" as never, onToolResult as never));

  const stateFor = (session: SessionLike): SkillInvocationState | undefined => {
    const known = sessionStates.get(session);
    if (known !== undefined) return known;
    try {
      const state = new SkillInvocationState();
      // Newer hosts expose an immutable snapshot method; earlier 0.1 hosts
      // expose an events getter. Both are read only once per live session.
      const history =
        typeof session.snapshotEvents === "function" ? session.snapshotEvents() : session.events;
      if (history === undefined) return undefined;
      for (const event of history) {
        state.consume(event);
        if (state.successful) break;
      }
      // A failed read is not a completed scan: retry on the next event.
      sessionStates.set(session, state);
      return state;
    } catch {
      return undefined;
    }
  };

  const scanSession = (session: SessionLike): void => {
    if (disposed || suiteDisposer !== undefined) return;
    if (revealPending || stateFor(session)?.successful) ensureSuite();
  };

  // Live gesture/append feed: covers /browser-skill user gestures (no tool
  // call happens on that path) landing as skill-invocation messages.
  const onSessionEvent = (session: SessionLike, event: SessionEventLike): void => {
    if (disposed || suiteDisposer !== undefined) return;
    if (
      (revealPending && event?.type === "turn/start") ||
      (event?.type === "user/message" && isSkillInvocationMessage(event.data))
    ) {
      ensureSuite();
      return;
    }
    if (session == null || event == null) return;
    // The first event can expose a session missed during startup. Scan its
    // existing history once; never read/copy the log on subsequent tokens.
    const state = stateFor(session);
    state?.consume(event);
    if (state?.successful && !revealPending) ensureSuite();
  };
  disposers.push(ctx.on("session/event" as never, onSessionEvent as never));

  // History restore: sessions entered from now on, plus any already live.
  const onSessionCreated = (session: SessionLike): void => scanSession(session);
  disposers.push(ctx.on("session/created" as never, onSessionCreated as never));
  const scanExisting = (context: Context): void => {
    if (disposed || suiteDisposer !== undefined) return;
    // Invocation proof is already retained: retry once for this discovery,
    // independently of how many sessions the registry currently contains.
    if (revealPending) {
      ensureSuite();
      return;
    }
    try {
      const sessions = context.get("sessions") as SessionsLike | null | undefined;
      if (sessions != null && typeof sessions.list === "function") {
        for (const session of sessions.list()) {
          scanSession(session);
          // A failed attempt also ends this batch; later lifecycle events retry.
          if (revealPending || suiteDisposer !== undefined) break;
        }
      }
    } catch {
      // An unavailable registry must not prevent later session/event recovery.
    }
  };
  scanExisting(ctx);
  // Also restore as soon as a late sessions service is available, before the
  // next tool lookup. Cordis owns this watcher's lifetime with the plugin.
  const watcher = ctx.inject(["sessions"], scanExisting);
  disposers.push(() => {
    void watcher.dispose();
  });

  return () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers.splice(0)) dispose();
    suiteDisposer?.();
    sessionStates = new WeakMap();
  };
}
