/**
 * Lazy tool-schema injection ("progressive disclosure", final stage): with
 * `lazyTools` on (the default), the six browser tool schemas stay OUT of the
 * system prompt until the `browser-skill` skill has actually been invoked —
 * the skill catalog entry is the only advertisement. A successful model
 * invocation or a claimed user `/browser-skill` gesture reveals
 * the whole suite for the rest of the process lifetime; repeated invocations
 * are idempotent no-ops. Session resume is covered by scanning durable
 * session events for a past successful invocation (tool/call + tool/result
 * pair, or a skill-invocation sourced message) when a session is entered or
 * first observed after a reload. Later events are consumed incrementally.
 *
 * Host lifecycle boundaries:
 * - `tools/post-execute` can turn a successful skill load into an actionable
 *   error before its result reaches the model. `tools/result` is too late.
 * - There is NO official global tool-visibility switch (`ctx.tools.restrict`
 *   is agent-scoped and throws from a plain host context), so conditional
 *   registration + this hook is the intended pattern; the registry supports
 *   mid-flight register/dispose with an unfiltered `tools/change` notice, and
 *   tool-skill's per-step catalog digest treats visibility changes as a
 *   first-class cache-invalidation input. Model tool calls reveal the suite
 *   for the next step; user gestures must reveal it at agent/inbox/claimed,
 *   before assembly, so instructions and schemas reach the same request.
 * - DSH 0.2 stores toolCallId/isError on the message; DSH 0.1 uses a
 *   tool-result content block. Both carry message.source.callId. Older hosts
 *   stored callId/isError directly on the message.
 */

import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { disposeAll } from "./disposables";
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
    if (message.role === "tool" && "toolCallId" in message) {
      if (
        isCallId(source.callId) &&
        message.toolCallId === source.callId &&
        typeof message.isError === "boolean"
      ) {
        return { callId: source.callId, isError: message.isError };
      }
      return;
    }
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
  // Live activation intent is not proof that the model received the skill body.
  requested = false;
  lastGesture: unknown;
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

/** Match the official gesture grammar only in user-authored text blocks. */
function isSkillGesture(message: unknown): boolean {
  const value = record(message);
  return (
    value?.role === "user" &&
    record(value.source)?.kind === "user" &&
    Array.isArray(value.content) &&
    value.content.some((block: unknown) => {
      const content = record(block);
      return (
        content?.type === "text" &&
        typeof content.text === "string" &&
        /(^|\s)\/browser-skill(?=\s|$)/.test(content.text)
      );
    })
  );
}

function gestureIdentity(message: unknown): unknown {
  return record(message)?.id ?? message;
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
  // Idle -> registering -> active. Failure returns to idle with intent retained;
  // disposal is terminal. Registration can synchronously publish tools/change,
  // so guard reentry without treating an incomplete suite as active.
  let disposed = false;
  let registering = false;
  let revealPending = false;
  let failure: string | undefined;
  let sessionStates = new WeakMap<SessionLike, SkillInvocationState>();
  const notices = new WeakMap<SessionLike, string>();
  let suiteDisposer: (() => void) | undefined;
  const disposers: (() => void)[] = [];
  const ensureSuite = (): boolean => {
    if (disposed || registering) return false;
    if (suiteDisposer !== undefined) return true;
    registering = true;
    try {
      const dispose = registerSuite();
      if (disposed) {
        dispose();
        return false;
      }
      suiteDisposer = dispose;
      revealPending = false;
      failure = undefined;
      return true;
    } catch (error) {
      revealPending = true;
      const detail = error instanceof Error ? error.message : String(error);
      if (detail !== failure) ctx.logger.error("BrowserSkill tool activation failed", error);
      failure = detail;
      return false;
    } finally {
      registering = false;
    }
  };
  const unavailableMessage = () =>
    `BrowserSkill tools are unavailable: ${failure}. ` +
    "Resolve the registration error, then invoke browser-skill again or start a new turn to retry. " +
    "Do not substitute another plugin's browser tools for the bsk_* tools.";

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

  const requestState = (session: SessionLike): SkillInvocationState => {
    const state = stateFor(session) ?? new SkillInvocationState();
    state.requested = true;
    sessionStates.set(session, state);
    return state;
  };

  const attemptGesture = (session: SessionLike, message: unknown): void => {
    const state = requestState(session);
    const identity = gestureIdentity(message);
    if (state.lastGesture === identity) return;
    state.lastGesture = identity;
    // A new explicit retry may report the same failure again. On success keep
    // the previous notice until pre-step acknowledges recovery to this session.
    if (!ensureSuite()) notices.delete(session);
  };

  // Wrap other post-execute decisions so an existing block/error/cancellation
  // stays authoritative. Never advertise a partial suite as a successful load.
  disposers.push(
    ctx.on(
      "tools/post-execute",
      async (exec, result, next) => {
        const decision = await next();
        if (
          disposed ||
          exec.signal.aborted ||
          result.isError ||
          decision.kind === "block" ||
          exec.name !== "skill" ||
          skillNameOf(exec.arguments) !== BSK_SKILL_NAME
        )
          return decision;
        const session = exec.agent?.session;
        if (session !== undefined) requestState(session);
        if (ensureSuite()) return decision;
        // This blocked tool result is already the session's failure notice.
        if (session !== undefined && failure !== undefined) notices.set(session, failure);
        return {
          kind: "block",
          feedback: [{ type: "text", text: unavailableMessage() }],
          additionalContexts: decision.additionalContexts,
        };
      },
      { prepend: true },
    ),
  );

  // Inbox claims run synchronously before systemPrompt.assemble(). Pre-step
  // is too late to add schemas to the current request's immutable assembly.
  disposers.push(
    ctx.on("agent/inbox/claimed", ({ agent, message }) => {
      if (disposed || suiteDisposer !== undefined || !isSkillGesture(message)) return;
      attemptGesture(agent.session, message);
    }),
  );

  disposers.push(
    ctx.on(
      "agent/pre-step",
      async ({ agent, messages = [], signal }, next) => {
        const decision = await next();
        if (disposed || signal.aborted || decision.kind === "reject") return decision;
        const session = agent.session;
        const claimed = messages.some(
          (message) =>
            isSkillGesture(message) &&
            sessionStates.get(session)?.lastGesture === gestureIdentity(message),
        );
        for (const message of decision.messages) {
          if (!isSkillInvocationMessage(message)) continue;
          const state = requestState(session);
          state.successful = true;
          // The raw claim and official injection have different message IDs.
          // Treat them, and the later durable append, as one activation attempt.
          if (claimed) state.lastGesture = gestureIdentity(message);
          else attemptGesture(session, message);
        }
        let text: string;
        if (suiteDisposer !== undefined) {
          if (!notices.has(session)) return decision;
          notices.delete(session);
          text = sessionStates.get(session)?.successful
            ? "BrowserSkill tools are now available. Use the bsk_* tools described by browser-skill."
            : 'BrowserSkill tools are now available. Call skill({ name: "browser-skill" }) to load the instructions before using bsk_* tools.';
        } else {
          // Do not inject diagnostics into conversations that never requested this
          // skill, or repeat the same notice on every model step.
          if (
            failure === undefined ||
            !(stateFor(session)?.successful || sessionStates.get(session)?.requested) ||
            notices.get(session) === failure
          ) {
            return decision;
          }
          notices.set(session, failure);
          text = unavailableMessage();
        }
        return {
          ...decision,
          messages: [
            ...decision.messages,
            createUserMessage({
              content: [{ type: "text", text }],
              source: {
                kind: "plugin",
                plugin: "@wxg-prc-cpg/browser-skill-dsh-plugin",
                form: "notice",
                summary:
                  suiteDisposer === undefined
                    ? "BrowserSkill tools unavailable"
                    : "BrowserSkill tools available",
              },
            }),
          ],
        };
      },
      { prepend: true },
    ),
  );

  const scanSession = (session: SessionLike): void => {
    if (disposed || suiteDisposer !== undefined) return;
    if (revealPending || stateFor(session)?.successful) ensureSuite();
  };

  // Live gesture/append feed: covers /browser-skill user gestures (no tool
  // call happens on that path) landing as skill-invocation messages.
  const onSessionEvent = (session: SessionLike, event: SessionEventLike): void => {
    if (disposed || session == null || event == null) return;
    if (suiteDisposer !== undefined) {
      // A successful skill result can settle after registration. Keep its proof
      // for recovery guidance without rescanning history or retrying per token.
      sessionStates.get(session)?.consume(event);
      return;
    }
    if (event.type === "user/message" && isSkillInvocationMessage(event.data)) {
      requestState(session).successful = true;
      attemptGesture(session, event.data);
      return;
    }
    if (revealPending && event.type === "turn/start") {
      ensureSuite();
      return;
    }
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
    if (suiteDisposer !== undefined) disposers.push(suiteDisposer);
    suiteDisposer = undefined;
    sessionStates = new WeakMap();
    disposeAll(disposers);
  };
}
