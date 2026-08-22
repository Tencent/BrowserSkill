/**
 * Lazy tool-schema injection ("progressive disclosure", final stage): with
 * `lazyTools` on (the default), the 28 browser_* tool schemas stay OUT of the
 * system prompt until the `browser-skill` skill has actually been invoked —
 * the skill catalog entry is the only advertisement. One successful
 * invocation (model tool call, or a user's `/browser-skill` gesture) reveals
 * the whole suite for the rest of the process lifetime; repeated invocations
 * are idempotent no-ops. Session resume is covered by scanning durable
 * session events for a past successful invocation (tool/call + tool/result
 * pair, or a skill-invocation sourced message) when a session is entered.
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
 * - Durable events: `tool/call` {callId, name, arguments(JSON string)} pairs
 *   with `tool/result` {message: {callId, isError}} — the history signal.
 */

import type { Context } from "@deepseek-ai/cordis";
import { BSK_SKILL_NAME } from "./skill-content.generated";

/** Structural view of the pieces of the session seam we consume. */
interface SessionLike {
  events: readonly SessionEventLike[];
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
  const skillCallIds = new Set<unknown>();
  for (const event of events) {
    if (event.type !== "tool/call") continue;
    const data = event.data as { callId?: unknown; name?: unknown; arguments?: unknown };
    if (data?.name === "skill" && skillNameOf(data.arguments) === BSK_SKILL_NAME) {
      skillCallIds.add(data.callId);
    }
  }
  for (const event of events) {
    if (event.type === "tool/result") {
      const message = (event.data as { message?: unknown })?.message;
      if (typeof message !== "object" || message === null) continue;
      const { callId, isError } = message as { callId?: unknown; isError?: unknown };
      if (isError === false && skillCallIds.has(callId)) return true;
    }
    if (isSkillInvocationMessage(event.data)) return true;
  }
  return false;
}

/**
 * Arm the lazy reveal. Returns a disposer tearing down listeners and — when
 * the reveal already happened — the tool suite itself.
 * @param registerSuite - registers the 28 browser_* tools, returns their disposer.
 */
export function armLazyTools(ctx: Context, registerSuite: () => () => void): () => void {
  let suiteDisposer: (() => void) | undefined;
  const disposers: (() => void)[] = [];
  const ensureSuite = (): void => {
    if (suiteDisposer !== undefined) return;
    try {
      suiteDisposer = registerSuite();
    } catch (error) {
      // A failed reveal must not strand the plugin: stay hidden, log, retry on
      // the next trigger instead of latching a half-registered suite.
      suiteDisposer = undefined;
      console.warn(
        `[dsh-plugin-browserskill] lazy tool registration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  // Live trigger: a successful model invocation of skill/browser-skill.
  const onToolResult = (exec: ToolResultExecutionLike, result: { isError: boolean }): void => {
    if (result.isError) return;
    if (exec.name !== "skill") return;
    if (skillNameOf(exec.arguments) === BSK_SKILL_NAME) ensureSuite();
  };
  disposers.push(ctx.on("tools/result" as never, onToolResult as never));

  const scanSession = (session: SessionLike): void => {
    try {
      if (hasSuccessfulSkillInvocation(session.events)) ensureSuite();
    } catch {
      // A session object that cannot be read must never break plugin startup.
    }
  };

  // Live gesture/append feed: covers /browser-skill user gestures (no tool
  // call happens on that path) landing as skill-invocation messages.
  const onSessionEvent = (_session: SessionLike, event: SessionEventLike): void => {
    if (isSkillInvocationMessage(event?.data)) ensureSuite();
  };
  disposers.push(ctx.on("session/event" as never, onSessionEvent as never));

  // History restore: sessions entered from now on, plus any already live.
  const onSessionCreated = (session: SessionLike): void => scanSession(session);
  disposers.push(ctx.on("session/created" as never, onSessionCreated as never));
  const sessions = ctx.get("sessions") as SessionsLike | null | undefined;
  if (sessions != null && typeof sessions.list === "function") {
    for (const session of sessions.list()) scanSession(session);
  }

  return () => {
    for (const dispose of disposers.splice(0)) dispose();
    suiteDisposer?.();
  };
}
