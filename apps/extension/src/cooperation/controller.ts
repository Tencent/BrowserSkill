import { DEBUG_ACTIONS } from "@/debug/capabilities";
import {
  isAgentControlledTab,
  type SessionContext,
  type SessionManager,
} from "@/session-manager/manager";
import { resolveActionTarget } from "@/tools/interaction";
import { captureVomObservation, handleSnapshot } from "@/tools/observation";
import { type CdpRunner, chromeTabsApi, isRpcError, resolveTargetTab } from "@/tools/shared";
import type { DialogParams, RequestFrame, RpcError } from "@/transport/types";
import { guardedRunner } from "./action-guard";
import {
  type ObservationEvidence,
  observationEvidence,
  sameObservationEvidence,
} from "./observation-evidence";
import { pointerTargetValidator } from "./pointer-target";
import type { CooperationParams, CooperationView, FrameState, InputExpectation } from "./types";

type Frames = Map<number, FrameState>;
interface Context {
  id: string;
  epoch: number;
  refs: number;
  frames: Frames;
  evidence?: ObservationEvidence;
  activityCursor: number;
}
type Activity = FrameState["events"][number] & {
  frame_id: number;
  document: string;
  cursor: number;
};
interface TabState {
  lease: string;
  /** Only the untouched, agent-created blank tab may bootstrap without an observation. */
  bootstrap: boolean;
  /** Only actual human participation changes the original tab/idle cleanup policy. */
  intervened: boolean;
  target?: CooperationView["target"];
  sessionId: string;
  tabId: number;
  revision: number;
  epoch: number;
  held: boolean;
  stopped: boolean;
  working: boolean;
  interruption?: AbortController;
  /** Ordinary input revocation must not discard an already accepted download receipt. */
  completion?: AbortController;
  unavailable: boolean;
  frames: Frames;
  context?: Context;
  baseline?: Context;
  activity: Activity[];
  activitySequence: number;
  activitySeen: Map<string, number>;
  historyGap: boolean;
  controlRevision: number;
}
export interface CooperationDeps {
  sessions: SessionManager;
  readFrames(tabId: number, input: InputExpectation | undefined, lease: string): Promise<Frames>;
  resumeFrames(tabId: number, lease: string): Promise<void>;
  releaseFrames?(tabId: number, lease: string): Promise<void>;
  changed(tabId: number): void;
  sessionActivity?(sessionId: string, idleProtected: boolean): void;
  now?: () => number;
}
const READS = new Set([
  "tool.snapshot",
  "tool.observe",
  "tool.get_html",
  "tool.screenshot",
  "tool.console",
  "tool.network",
  "tool.extract",
  "tool.wait_for_element",
  "tool.wait_for_navigation",
  "tool.record_start",
]);
const SESSION_TOOLS = new Set([
  "tool.session_start",
  "tool.session_stop",
  "tool.tab_list",
  "tool.screenshot_read",
  "tool.screenshot_release",
  "tool.record_stop",
  "tool.record_await",
]);
const PASSIVE_DEBUG = new Set<string>(
  DEBUG_ACTIONS.filter(
    (action) =>
      !["rule_add", "rule_enable", "rule_disable", "rule_remove", "replay"].includes(action),
  ),
);
const QUIET_MS = 650;

function isInitialBlank(tab: { url?: string; pendingUrl?: string }): boolean {
  // Chrome can report the agent-created blank page before its initial load commits.
  return (
    (tab.url || tab.pendingUrl) === "about:blank" &&
    (!tab.pendingUrl || tab.pendingUrl === "about:blank")
  );
}

function sameFrames(a: Frames, b: Frames, field: "revision" | "structure" | "human"): boolean {
  return (
    a.size === b.size &&
    [...a].every(([id, state]) => {
      const other = b.get(id);
      return other?.document === state.document && other[field] === state[field];
    })
  );
}
function sameFields(a: Frames, b: Frames): boolean {
  return (
    a.size === b.size &&
    [...a].every(
      ([id, frame]) => JSON.stringify(frame.fields) === JSON.stringify(b.get(id)?.fields),
    )
  );
}
function failure(message: string, effect: "none" | "unknown" = "none"): RpcError {
  return {
    code: "permission_denied",
    message,
    data: {
      reason: "cooperation_sync_required",
      effect_state: effect,
      recovery:
        "Use cooperate wait, then cooperate sync. Keep the assigned goal; reconcile the live result before issuing a new action. Never replay an uncertain submission.",
    },
  };
}
function stopped(effect: "none" | "unknown" = "none"): RpcError {
  return {
    code: "user_aborted",
    message: "The user stopped this task. Do not automatically wait, replan, or resume.",
    data: { effect_state: effect },
  };
}

/** One authority for per-tab ownership, immutable observations, and dispatch fences. */
export class CooperationController {
  private readonly tabs = new Map<number, TabState>();
  /** Keep a lost task target until explicit replacement; never fall back to the active tab. */
  private readonly defaultTabs = new Map<string, number>();
  private readonly now: () => number;
  constructor(private readonly deps: CooperationDeps) {
    this.now = deps.now ?? Date.now;
  }

  enabled(tabId: number): boolean {
    return this.tabs.has(tabId);
  }
  hasSession(sessionId: string): boolean {
    return this.defaultTabs.has(sessionId);
  }

  /** Resolve modal reporting from the task binding, without consulting the renderer. */
  taskTab(sessionId: string, contextId?: string): number | undefined {
    if (contextId) {
      const observed = [...this.tabs.values()].find(
        (state) =>
          state.sessionId === sessionId &&
          (state.context?.id === contextId || state.baseline?.id === contextId),
      );
      if (observed) return observed.tabId;
    }
    return this.defaultTabs.get(sessionId);
  }
  /** Called by the common dispatcher before returning a successful session start. */
  startSession(sessionId: string) {
    if (this.hasSession(sessionId)) return;
    const session = this.deps.sessions.get(sessionId);
    const tabId = session?.agentCreatedTabs.values().next().value;
    if (session && tabId !== undefined) {
      this.track(session, tabId, true);
      this.defaultTabs.set(sessionId, tabId);
    }
  }
  private track(session: SessionContext, tabId: number, bootstrap = false): TabState {
    const existing = this.tabs.get(tabId);
    if (existing) return existing;
    const state: TabState = {
      lease: crypto.randomUUID(),
      bootstrap,
      intervened: false,
      sessionId: session.sessionId,
      tabId,
      revision: 0,
      epoch: 0,
      held: false,
      stopped: false,
      working: false,
      unavailable: true,
      frames: new Map(),
      activity: [],
      activitySequence: 0,
      activitySeen: new Map(),
      historyGap: false,
      controlRevision: 0,
    };
    this.tabs.set(tabId, state);
    this.changed(state);
    return state;
  }
  private preserve(state: TabState) {
    const session = this.deps.sessions.get(state.sessionId);
    if (!session || state.intervened) return;
    state.bootstrap = false;
    state.intervened = true;
    // Preserve pages the person actually touched through the existing cleanup path.
    if (session.agentCreatedTabs.delete(state.tabId))
      (session.observedTabs ??= new Set()).add(state.tabId);
    this.sessionActivity(state.sessionId);
  }
  /** A renderer announces readiness after installing its listeners, including after navigation. */
  async observeTab(tabId: number): Promise<void> {
    const sessionId = this.deps.sessions.findControllingSession(tabId);
    const session = sessionId ? this.deps.sessions.get(sessionId) : null;
    if (!session || !this.hasSession(session.sessionId)) return;
    const previous = this.tabs.get(tabId);
    const tab = await chromeTabsApi.get(tabId).catch(() => undefined);
    if (
      !tab ||
      (previous !== undefined && this.tabs.get(tabId) !== previous) ||
      tab.windowId !== session.agentWindowId ||
      this.deps.sessions.get(session.sessionId) !== session ||
      !this.hasSession(session.sessionId) ||
      !isAgentControlledTab(session, tabId)
    )
      return;
    const state = this.track(
      session,
      tabId,
      isInitialBlank(tab) && session.agentCreatedTabs.has(tabId),
    );
    if (state.stopped) return;
    if (!isInitialBlank(tab)) state.bootstrap = false;
    if (state.bootstrap) return;
    try {
      await this.refresh(state);
    } catch {
      // A loading/inaccessible frame remains guarded; wait/sync retries collection.
    }
    if (this.tabs.get(tabId) === state) this.changed(state);
  }
  private sessionActivity(sessionId: string) {
    this.deps.sessionActivity?.(
      sessionId,
      [...this.tabs.values()].some((s) => s.sessionId === sessionId && !s.stopped && s.intervened),
    );
  }
  detachTab(tabId: number) {
    const state = this.tabs.get(tabId);
    // A page moved out of the task window must not remain in stop's close list.
    // Agent tab-return operates on borrowed pages, which already use their own cleanup.
    if (state) this.preserve(state);
    this.releaseTab(tabId);
  }
  releaseTab(tabId: number) {
    const state = this.tabs.get(tabId);
    if (!state) return;
    const reason = new Error("The task tab closed or left its window");
    state.interruption?.abort(reason);
    state.completion?.abort(reason);
    this.tabs.delete(tabId);
    void this.deps.releaseFrames?.(tabId, state.lease).catch(() => {});
    this.deps.changed(tabId);
    this.sessionActivity(state.sessionId);
  }
  view(tabId: number): CooperationView | undefined {
    const state = this.tabs.get(tabId);
    if (!state) return;
    return {
      target: !state.held && !this.humanActive(state) ? state.target : undefined,
      revision: state.revision,
      mode: state.unavailable
        ? "unavailable"
        : state.working && (state.held || this.humanActive(state))
          ? "yielding"
          : state.held
            ? "held"
            : this.humanActive(state)
              ? "human"
              : state.working
                ? "acting"
                : state.context
                  ? "ready"
                  : "syncing",
      editing: [...state.frames.values()].some((frame) => frame.editing),
    };
  }
  private humanActive(state: TabState): boolean {
    return [...state.frames.values()].some(
      (f) => f.busy || f.editing || this.now() - f.lastInput < QUIET_MS,
    );
  }
  private changed(state: TabState) {
    state.revision++;
    this.deps.changed(state.tabId);
  }
  receive(tabId: number, frameId: number, frame: FrameState, lease?: string) {
    const state = this.tabs.get(tabId);
    const old = state?.frames.get(frameId);
    if (state && lease === state.lease) this.remember(state, frameId, frame);
    // Late messages from a replaced document cannot restore ownership.
    if (
      !state ||
      (lease !== undefined && lease !== state.lease) ||
      !old ||
      old.document !== frame.document ||
      frame.revision < old.revision
    )
      return;
    if (frame.human !== old.human) {
      if (frame.human > old.human) this.preserve(state);
      state.interruption?.abort(new Error("User activity revoked this action"));
      state.epoch++;
      state.context = undefined;
    }
    state.frames = new Map(state.frames).set(frameId, frame);
    this.changed(state);
  }
  private remember(state: TabState, frameId: number, frame: FrameState) {
    const key = `${frameId}:${frame.document}`;
    const seen = state.activitySeen.get(key) ?? 0;
    if ((frame.events[0]?.sequence ?? frame.human + 1) > seen + 1) state.historyGap = true;
    for (const event of frame.events) {
      if (event.sequence <= seen) continue;
      state.activity.push({
        ...event,
        frame_id: frameId,
        document: frame.document,
        cursor: ++state.activitySequence,
      });
    }
    state.activitySeen.set(key, Math.max(seen, frame.human));
    while (state.activitySeen.size > 128)
      state.activitySeen.delete(state.activitySeen.keys().next().value!);
    if (state.activity.length > 128) {
      const removed = state.activity.splice(0, state.activity.length - 128);
      if (removed.some((event) => event.cursor > (state.baseline?.activityCursor ?? 0)))
        state.historyGap = true;
    }
  }
  invalidate(tabId: number) {
    const state = this.tabs.get(tabId);
    if (!state) return;
    state.epoch++;
    state.context = undefined;
    state.unavailable = true;
    this.changed(state);
  }
  async control(tabId: number, revision: number, action: "hold" | "resume") {
    const state = this.tabs.get(tabId);
    if (!state || state.revision !== revision) return { ok: false, state: this.view(tabId) };
    this.preserve(state);
    state.epoch++;
    state.context = undefined;
    // Reserve the transition before awaiting a renderer. A newer hold wins.
    state.held = action === "hold";
    if (state.held) state.interruption?.abort(new Error("The user is holding control"));
    state.controlRevision++;
    if (action === "resume") state.stopped = false;
    this.sessionActivity(state.sessionId);
    const epoch = state.epoch;
    this.changed(state);
    if (action === "resume") {
      await this.deps.resumeFrames(tabId, state.lease);
      if (state.epoch === epoch) await this.refresh(state);
    }
    return { ok: true, state: this.view(tabId) };
  }
  release(sessionId: string) {
    for (const [id, state] of this.tabs) if (state.sessionId === sessionId) this.releaseTab(id);
    this.defaultTabs.delete(sessionId);
  }
  stopSession(sessionId: string) {
    for (const state of this.tabs.values())
      if (state.sessionId === sessionId) {
        this.preserve(state);
        state.held = true;
        state.stopped = true;
        const reason = new Error("The user stopped this task");
        state.interruption?.abort(reason);
        state.completion?.abort(reason);
        state.epoch++;
        state.context = undefined;
        this.changed(state);
      }
    this.sessionActivity(sessionId);
  }
  syncSessions() {
    for (const sessionId of this.defaultTabs.keys())
      if (!this.deps.sessions.has(sessionId)) this.release(sessionId);
  }
  private async refresh(state: TabState, input?: InputExpectation): Promise<Frames> {
    const live = () =>
      this.tabs.get(state.tabId) === state && this.deps.sessions.has(state.sessionId);
    if (!live()) throw new Error("Shared-tab control has ended");
    let frames: Frames;
    try {
      frames = await this.deps.readFrames(state.tabId, input, state.lease);
    } catch (error) {
      state.unavailable = true;
      state.context = undefined;
      this.changed(state);
      throw error;
    }
    if (!live()) throw new Error("Shared-tab control ended during collection");
    if (!frames.size || !frames.has(0)) throw new Error("Page interaction coverage is unavailable");
    for (const [id, old] of state.frames) {
      const next = frames.get(id);
      if (next?.document === old.document) {
        if (next.revision < old.revision) frames.set(id, old);
        else if (next.human > old.human) this.preserve(state);
      }
    }
    if (state.frames.size && !sameFrames(state.frames, frames, "human")) {
      state.epoch++;
      state.context = undefined;
    }
    for (const [id, frame] of frames) this.remember(state, id, frame);
    state.frames = frames;
    state.unavailable = false;
    return frames;
  }
  async command(params: CooperationParams, cdp: CdpRunner, signal: AbortSignal): Promise<unknown> {
    const session = this.deps.sessions.get(params.session_id);
    if (!session) return { code: "not_found", message: "Unknown session" };
    this.startSession(session.sessionId);
    const target = await resolveTargetTab(
      this.deps.sessions,
      session,
      params.tab_id ?? this.defaultTabs.get(session.sessionId),
      chromeTabsApi,
    );
    if (isRpcError(target)) return target;
    if (!isAgentControlledTab(session, target.tabId))
      return failure("Cooperation requires an owned tab");
    if (!["enable", "status", "sync", "wait"].includes(params.action))
      return { code: "invalid_params", message: "Unknown cooperation action" };
    const state = this.track(session, target.tabId);
    if (state.sessionId !== session.sessionId)
      return failure("This tab belongs to another session");
    if (state.stopped && params.action !== "status") return stopped();
    if (!isInitialBlank(target)) state.bootstrap = false;
    if (params.action === "enable" || (params.action === "sync" && params.tab_id !== undefined))
      this.defaultTabs.set(session.sessionId, state.tabId);
    try {
      if (params.action === "enable")
        await cdp.releaseBackgroundExecution?.(session.sessionId, state.tabId);
      const refresh = async () => {
        try {
          await this.refresh(state);
        } catch (error) {
          if (params.action !== "wait" || signal.aborted) throw error;
          state.unavailable = true;
        }
      };
      await refresh();
      if (params.action === "wait") {
        const timeout = Math.min(Math.max(params.timeout_ms ?? 15000, 0), 25000);
        const deadline = this.now() + timeout;
        while (
          (state.unavailable || state.held || this.humanActive(state) || state.working) &&
          this.now() < deadline
        ) {
          if (state.stopped) return stopped();
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer);
              reject(signal.reason);
            };
            const timer = setTimeout(() => {
              signal.removeEventListener("abort", abort);
              resolve();
            }, 100);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          });
          await refresh();
        }
      }
      if (state.stopped && params.action !== "status") return stopped();
      if (params.action !== "sync" && params.action !== "enable")
        return {
          tab_id: state.tabId,
          stopped: state.stopped,
          activity: state.activity.filter(
            (event) => event.cursor > (state.baseline?.activityCursor ?? 0),
          ),
          state: this.view(state.tabId),
          ready: !state.unavailable && !state.held && !state.working && !this.humanActive(state),
        };
      if (state.held || state.working || this.humanActive(state))
        return failure("The user is still operating this tab; wait for hand-back");
      state.working = true;
      state.context = undefined;
      this.changed(state);
      try {
        const before = state.frames;
        const epoch = state.epoch;
        const baseline = state.baseline;
        let evidence = baseline?.evidence;
        const delta =
          baseline &&
          [...before.values()].every((frame) => frame.fieldsComplete !== false) &&
          baseline.refs === session.refStore.revision &&
          sameFrames(baseline.frames, before, "structure");
        // A delta updates the model's field values. Refresh private semantic
        // evidence too, without replacing refs or repeating page text to the model.
        if (delta && !sameFields(baseline.frames, before))
          await captureVomObservation(guardedRunner(cdp), state.tabId, target.url, {
            signal,
            conditionalSurfaceProbe: false,
            onScene: (scene) => {
              evidence = observationEvidence(scene);
            },
          });
        const observation = delta
          ? undefined
          : await handleSnapshot(
              this.deps.sessions,
              { session_id: params.session_id, tab_id: state.tabId, max_tokens: params.max_tokens },
              {
                cdp: guardedRunner(cdp),
                tabsApi: chromeTabsApi,
                onScene: (scene) => {
                  evidence = observationEvidence(scene);
                },
              },
              signal,
            );
        if (observation && isRpcError(observation)) return observation;
        const after = await this.refresh(state);
        if (state.stopped) return stopped();
        if (
          signal.aborted ||
          state.epoch !== epoch ||
          !sameFrames(before, after, "human") ||
          !sameFields(before, after) ||
          (delta && !sameFrames(before, after, "structure")) ||
          this.humanActive(state) ||
          state.held
        )
          return failure("Page changed while synchronizing; sync again after it settles");
        const context: Context = {
          id: crypto.randomUUID(),
          epoch,
          refs: session.refStore.revision,
          frames: before,
          evidence,
          activityCursor: state.activitySequence,
        };
        state.context = context;
        state.baseline = context;
        const activity = state.activity.filter(
          (event) => event.cursor > (baseline?.activityCursor ?? 0),
        );
        const historyGap = state.historyGap;
        state.historyGap = false;
        return {
          tab_id: state.tabId,
          context_id: context.id,
          kind: delta
            ? sameFrames(baseline.frames, after, "revision")
              ? "unchanged"
              : "delta"
            : "baseline",
          ...(delta
            ? {
                previous_context_id: baseline.id,
                changes: [...after].flatMap(([frameId, frame]) =>
                  frame.fields.flatMap((field) => {
                    const previous = baseline.frames
                      .get(frameId)
                      ?.fields.find((old) =>
                        field.id ? old.id === field.id : old.label === field.label,
                      );
                    return previous?.value === field.value
                      ? []
                      : [
                          {
                            frame_id: frameId,
                            ...field,
                            ...(previous ? { previous_value: previous.value } : {}),
                          },
                        ];
                  }),
                ),
              }
            : { observation }),
          activity,
          history_complete:
            !historyGap &&
            !!baseline &&
            [...after].every(([id, f]) => {
              const old = baseline.frames.get(id);
              return (
                old?.document === f.document &&
                (f.events[0]?.sequence ?? f.human + 1) <= old.human + 1
              );
            }),
          state: { ...this.view(state.tabId), mode: "ready" },
          guidance:
            "Continue toward the assigned goal using this current state. Incorporate helpful progress and correct recoverable mistakes. Page activity is not a change of goal. Each context authorizes one action; sync after it. By default the whole page is checked. To tolerate unrelated updates, declare all observed decision regions with --depends-on refs/selectors (plugin: dependsOn); the target region and form values remain protected. Verify completion and prior submissions from application evidence.",
        };
      } finally {
        state.working = false;
        this.changed(state);
      }
    } catch (error) {
      if (state.stopped) return stopped();
      if (signal.aborted) return { code: "cancelled", message: "Cooperation wait cancelled" };
      state.unavailable = true;
      state.context = undefined;
      this.changed(state);
      return failure(error instanceof Error ? error.message : String(error));
    }
  }

  private async bootstrap<T extends CdpRunner>(
    state: TabState,
    method: string,
    cdp: T,
    signal: AbortSignal,
    invoke: (cdp: T) => Promise<unknown>,
  ): Promise<unknown> {
    if (state.working) return failure("Another operation is settling on this tab");
    const epoch = state.epoch;
    let sent = false;
    let revoked: string | undefined;
    const assert = () => {
      signal.throwIfAborted();
      if (
        this.tabs.get(state.tabId) !== state ||
        state.stopped ||
        state.held ||
        state.epoch !== epoch
      )
        throw new Error((revoked = "The initial task tab changed; synchronize before acting"));
    };
    state.working = true;
    try {
      const result = await invoke(
        guardedRunner(cdp, {
          prepare: async () => {
            assert();
            const tab = await chromeTabsApi.get(state.tabId);
            const session = this.deps.sessions.get(state.sessionId);
            if (!session || tab.windowId !== session.agentWindowId || !isInitialBlank(tab))
              throw new Error(
                (revoked = "The initial task tab changed; synchronize before acting"),
              );
            assert();
          },
          dispatch: (_input, nativeMethod) => {
            assert();
            sent = true;
            if (nativeMethod === "Page.navigate") state.bootstrap = false;
          },
        }),
      );
      return revoked ? failure(revoked, sent ? "unknown" : "none") : result;
    } catch (error) {
      if (state.stopped) return stopped(sent ? "unknown" : "none");
      if (signal.aborted) return { code: "cancelled", message: "Initial page operation cancelled" };
      return failure(
        error instanceof Error ? error.message : String(error),
        sent ? "unknown" : "none",
      );
    } finally {
      state.working = false;
      if (method === "tool.navigate") await this.observeTab(state.tabId);
      this.changed(state);
    }
  }

  /** Tab activation/movement affects the whole task window, not just its destination. */
  private async manageTabs<T extends CdpRunner>(
    session: SessionContext,
    cdp: T,
    signal: AbortSignal,
    invoke: (cdp: T, signal?: AbortSignal) => Promise<unknown>,
  ): Promise<unknown> {
    const states = [...this.tabs.values()].filter((state) => state.sessionId === session.sessionId);
    if (states.some((state) => state.working))
      return failure("Another operation is settling on this tab");
    const epochs = new Map(states.map((state) => [state, state.epoch]));
    let sent = false;
    let revoked: string | undefined;
    const assert = () => {
      signal.throwIfAborted();
      if (
        this.deps.sessions.get(session.sessionId) !== session ||
        states.some(
          (state) =>
            this.tabs.get(state.tabId) !== state ||
            state.stopped ||
            state.held ||
            this.humanActive(state) ||
            state.epoch !== epochs.get(state),
        )
      )
        throw new Error(
          (revoked = "Task window control changed; wait and synchronize before changing tabs"),
        );
    };
    const prepare = async () => {
      assert();
      // Blank tabs have no collector. Other owned pages must confirm that no
      // human input was missed while a browser lookup/borrow approval was pending.
      try {
        for (const state of states) if (!state.bootstrap) await this.refresh(state);
        assert();
      } catch (error) {
        revoked ??= error instanceof Error ? error.message : String(error);
        throw error;
      }
    };
    for (const state of states) {
      state.working = true;
      state.context = undefined;
      this.changed(state);
    }
    try {
      await prepare();
      const result = await invoke(
        guardedRunner(cdp, {
          prepare,
          dispatch: () => {
            assert();
            sent = true;
          },
        }),
        signal,
      );
      // Existing handlers may convert a guard rejection into their own RPC error.
      if (states.some((state) => state.stopped)) return stopped(sent ? "unknown" : "none");
      if (signal.aborted) signal.throwIfAborted();
      if (revoked) return failure(revoked, sent ? "unknown" : "none");
      return result;
    } catch (error) {
      if (states.some((state) => state.stopped)) return stopped(sent ? "unknown" : "none");
      if (signal.aborted)
        return {
          code: "cancelled",
          message: "Tab operation cancelled",
          data: { effect_state: sent ? "unknown" : "none" },
        };
      return failure(
        error instanceof Error ? error.message : String(error),
        sent ? "unknown" : "none",
      );
    } finally {
      for (const state of states) {
        state.working = false;
        if (this.tabs.get(state.tabId) === state) this.changed(state);
      }
    }
  }

  /** A modal prevents fresh DOM collection. Its observed ID authorizes only
   * that decision; cached human-control fences still apply at native dispatch. */
  private async dialog<T extends CdpRunner>(
    req: RequestFrame,
    session: SessionContext,
    cdp: T,
    signal: AbortSignal,
    invoke: (cdp: T, signal?: AbortSignal) => Promise<unknown>,
  ): Promise<unknown> {
    const params = req.params as DialogParams;
    if (!["status", "accept", "dismiss"].includes(params.action))
      return { code: "invalid_params", message: "Unknown dialog action" };
    const target = await resolveTargetTab(
      this.deps.sessions,
      session,
      params.tab_id ?? this.defaultTabs.get(session.sessionId),
      chromeTabsApi,
    );
    if (isRpcError(target)) return target;
    if (target.windowId !== session.agentWindowId || !isAgentControlledTab(session, target.tabId))
      return failure("Dialog control requires an owned task tab");
    req.params = { ...params, tab_id: target.tabId };
    const state = this.track(session, target.tabId);
    if (state.sessionId !== session.sessionId)
      return failure("This tab belongs to another session");
    if (params.action === "status") return invoke(guardedRunner(cdp), signal);
    if ([...this.tabs.values()].some((s) => s.sessionId === session.sessionId && s.stopped))
      return stopped();
    if (typeof params.dialog_id !== "string" || !params.dialog_id)
      return {
        code: "invalid_params",
        message: "Shared dialog decisions require dialog_id from dialog status",
      };
    const epoch = state.epoch;
    let sent = false;
    let revoked: string | undefined;
    const assert = () => {
      signal.throwIfAborted();
      if (
        this.deps.sessions.get(session.sessionId) !== session ||
        this.tabs.get(state.tabId) !== state ||
        !isAgentControlledTab(session, state.tabId) ||
        state.stopped ||
        state.held ||
        this.humanActive(state) ||
        state.epoch !== epoch
      )
        throw new Error(
          (revoked =
            "Shared-tab control changed; the user must finish or release control before a dialog decision"),
        );
    };
    try {
      assert();
      const result = await invoke(
        guardedRunner(cdp, {
          prepare: async () => assert(),
          dispatch: () => {
            assert();
            sent = true;
            state.context = undefined;
            // The old observation cannot authorize input after the page resumes.
            state.epoch++;
            this.changed(state);
          },
        }),
        signal,
      );
      if (state.stopped) return stopped(sent ? "unknown" : "none");
      signal.throwIfAborted();
      return revoked ? failure(revoked, sent ? "unknown" : "none") : result;
    } catch (error) {
      if (state.stopped) return stopped(sent ? "unknown" : "none");
      if (signal.aborted)
        return {
          code: "cancelled",
          message: "Dialog decision cancelled",
          data: { effect_state: sent ? "unknown" : "none" },
        };
      return failure(
        error instanceof Error ? error.message : String(error),
        sent ? "unknown" : "none",
      );
    }
  }

  async run<T extends CdpRunner>(
    req: RequestFrame,
    cdp: T,
    signal: AbortSignal,
    invoke: (cdp: T, signal?: AbortSignal, completionSignal?: AbortSignal) => Promise<unknown>,
  ): Promise<unknown> {
    const params = req.params as
      | {
          session_id?: string;
          tab_id?: number;
          context_id?: string;
          probe_hover?: boolean;
          ref?: string;
          selector?: string;
          depends_on?: string[];
        }
      | undefined;
    if (req.method === "tool.session_start") {
      const result = await invoke(cdp);
      if (!isRpcError(result) && params?.session_id) this.startSession(params.session_id);
      return result;
    }
    if (req.method === "tool.cooperate")
      return this.command(params as CooperationParams, cdp, signal);
    if (!params?.session_id || SESSION_TOOLS.has(req.method)) return invoke(cdp);
    const session = this.deps.sessions.get(params.session_id);
    if (!session) return invoke(cdp);
    this.startSession(session.sessionId);
    if (req.method === "tool.dialog") return this.dialog(req, session, cdp, signal, invoke);
    if (
      !READS.has(req.method) &&
      [...this.tabs.values()].some((s) => s.sessionId === params.session_id && s.stopped)
    )
      return stopped();
    if (
      ["tool.tab_create", "tool.tab_borrow", "tool.tab_select", "tool.tab_return"].includes(
        req.method,
      )
    ) {
      if (
        req.method === "tool.tab_select" &&
        (params.tab_id === undefined || !isAgentControlledTab(session, params.tab_id))
      )
        return failure("Select an owned task tab; borrow user tabs explicitly");
      // Shared tabs never acquire background focus emulation. Keep an unspecified
      // new tab navigable, as the initial session tab is.
      if (req.method === "tool.tab_create" && (req.params as { url?: string }).url === undefined)
        req.params = { ...params, url: "about:blank" };
      const result = await this.manageTabs(session, cdp, signal, invoke);
      if (req.method === "tool.tab_return") {
        if (!isRpcError(result) && params.tab_id !== undefined) this.releaseTab(params.tab_id);
        return result;
      }
      if (
        !isRpcError(result) &&
        result &&
        typeof result === "object" &&
        "tab_id" in result &&
        typeof result.tab_id === "number" &&
        isAgentControlledTab(session, result.tab_id)
      ) {
        this.defaultTabs.set(session.sessionId, result.tab_id);
        await this.observeTab(result.tab_id);
      }
      return result;
    }
    if (req.method === "tool.request_help") {
      const target = await resolveTargetTab(
        this.deps.sessions,
        session,
        params.tab_id ?? this.defaultTabs.get(session.sessionId),
        chromeTabsApi,
      );
      if (isRpcError(target)) return target;
      if (!isAgentControlledTab(session, target.tabId))
        return failure("Help requires an owned task tab");
      const state = this.track(session, target.tabId);
      if (state.working) return failure("Another operation is settling on this tab");
      req.params = { ...params, tab_id: target.tabId };
      const held = state.held;
      const controlRevision = state.controlRevision;
      state.held = true;
      state.working = true;
      state.context = undefined;
      state.epoch++;
      this.changed(state);
      try {
        const result = await invoke(cdp);
        const outcome = (result as { outcome?: string } | undefined)?.outcome;
        if (outcome === "cancelled") this.stopSession(state.sessionId);
        if (outcome === "continued" || outcome === "completed") {
          this.preserve(state);
          await this.deps.resumeFrames(state.tabId, state.lease);
        }
        return result;
      } finally {
        if (!state.stopped && state.controlRevision === controlRevision) state.held = held;
        state.working = false;
        this.changed(state);
      }
    }
    const read = READS.has(req.method) && !params.probe_hover;
    // History/status remain usable after a task tab closes; their handlers enforce ownership.
    const action = (req.params as { action?: string }).action;
    if (
      (req.method === "tool.debug" && PASSIVE_DEBUG.has(action ?? "")) ||
      (req.method === "tool.video" &&
        ["start", "stop", "status", "read", "list", "capabilities"].includes(action ?? ""))
    ) {
      req.params = { ...params, tab_id: params.tab_id ?? this.defaultTabs.get(session.sessionId) };
      return invoke(guardedRunner(cdp));
    }
    const bound = params.context_id
      ? [...this.tabs.values()].find(
          (state) =>
            state.sessionId === params.session_id &&
            (state.context?.id === params.context_id || state.baseline?.id === params.context_id),
        )
      : undefined;
    if (
      params.context_id &&
      (!bound || (params.tab_id !== undefined && params.tab_id !== bound.tabId))
    )
      return failure("This context belongs to a different or superseded observation");
    const target = await resolveTargetTab(
      this.deps.sessions,
      session,
      bound?.tabId ?? params.tab_id ?? this.defaultTabs.get(session.sessionId),
      chromeTabsApi,
    );
    if (isRpcError(target)) return target;
    req.params = { ...params, tab_id: target.tabId };
    if (!isAgentControlledTab(session, target.tabId)) {
      if (read) return invoke(guardedRunner(cdp));
      return failure("Actions require an owned task tab; borrow user tabs explicitly");
    }
    const state = this.track(session, target.tabId);
    if (state.bootstrap && !isInitialBlank(target)) state.bootstrap = false;
    if (
      state.bootstrap &&
      ["tool.navigate", "tool.emulate", "tool.window_resize", "tool.tab_close"].includes(
        req.method,
      ) &&
      !params.context_id
    )
      return this.bootstrap(state, req.method, cdp, signal, invoke);
    if (read) return invoke(guardedRunner(cdp));
    if (state.working) return failure("Another operation is settling on this tab");
    let sent = false;
    let finished = false;
    let revoked: string | undefined;
    let nativeInputStarted = false;
    const context = state.context;
    const epoch = state.epoch;
    let verifiedFrames = context?.frames;
    let evidenceTargets: { backendNodeId: number; frameId?: string }[] | undefined;
    state.working = true;
    const intervention = new AbortController();
    state.interruption = intervention;
    const completion = new AbortController();
    state.completion = completion;
    const completionSignal = AbortSignal.any([signal, completion.signal]);
    const operationSignal = AbortSignal.any([completionSignal, intervention.signal]);
    const interruption = (settledNavigation = false): string | undefined => {
      if (finished) return "The action has already settled";
      if (intervention.signal.aborted) return String(intervention.signal.reason.message);
      if (this.tabs.get(state.tabId) !== state) return "Shared-tab control has ended";
      if (!settledNavigation && state.unavailable)
        return "Page interaction coverage changed; wait and synchronize";
      if (state.held) return "The user is holding control of this tab";
      if (this.humanActive(state)) return "User activity revoked this action";
      if (!settledNavigation && state.epoch !== epoch)
        return "The observed page or control state changed; synchronize";
    };
    const assert = () => {
      signal.throwIfAborted();
      const reason = interruption();
      if (reason) throw new Error((revoked = reason));
    };
    const verifyEvidence = async () => {
      if (!context || !verifiedFrames) throw new Error((revoked = "Synchronize before acting"));
      if (sameFrames(verifiedFrames, state.frames, "revision")) return;
      if (!context.evidence)
        throw new Error((revoked = "Page changed; synchronize before choosing an action"));
      const before = state.frames;
      let evidence: ObservationEvidence | undefined;
      await captureVomObservation(guardedRunner(cdp), state.tabId, target.url, {
        signal,
        conditionalSurfaceProbe: false,
        onScene: (scene) => {
          evidence = observationEvidence(scene);
        },
      });
      await this.refresh(state);
      assert();
      if (
        !evidence ||
        !(evidenceTargets ?? [undefined]).every((dependency) =>
          sameObservationEvidence(context.evidence!, evidence!, dependency),
        )
      )
        throw new Error(
          (revoked = "The action's observed content changed; synchronize and replan"),
        );
      // Keep the pre-capture revision: later mutations must be checked again.
      verifiedFrames = before;
    };
    try {
      await this.refresh(state);
      assert();
      if (
        !context ||
        params.context_id !== context.id ||
        context.epoch !== state.epoch ||
        context.refs !== session.refStore.revision
      )
        return failure("This action requires the context returned by the latest cooperate sync");
      if (params.ref || params.selector) {
        const resolved = await resolveActionTarget(
          guardedRunner(cdp),
          session,
          target,
          params,
          "shared action",
        );
        if (isRpcError(resolved)) return resolved;
        if (params.depends_on?.length) evidenceTargets = [resolved];
      }
      if (params.depends_on !== undefined) {
        if (
          !Array.isArray(params.depends_on) ||
          params.depends_on.length > 16 ||
          params.depends_on.some(
            (value) => typeof value !== "string" || !value || value.length > 1024,
          )
        )
          return {
            code: "invalid_params",
            message: "depends_on requires at most 16 observed refs/selectors",
          };
        if (evidenceTargets)
          for (const dependency of params.depends_on) {
            const resolved = await resolveActionTarget(
              guardedRunner(cdp),
              session,
              target,
              /^@?e\d+$/.test(dependency) ? { ref: dependency } : { selector: dependency },
              "action dependency",
            );
            if (isRpcError(resolved)) return resolved;
            evidenceTargets.push(resolved);
          }
      }
      await verifyEvidence();
      state.context = undefined; // Consume before execution, including failed/unknown replies.
      this.changed(state);
      const result = await invoke(
        guardedRunner(cdp, {
          scriptedEffect: req.method === "tool.evaluate",
          prepare: async (input) => {
            await this.refresh(state, input);
            assert();
            if (
              input?.type === "pointerdown" &&
              Number.isFinite(input.x) &&
              Number.isFinite(input.y)
            ) {
              state.target = { x: input.x!, y: input.y!, expires: this.now() + 650 };
              this.changed(state);
            }
            if (!nativeInputStarted) await verifyEvidence();
          },
          dispatch: (startsInput) => {
            assert();
            sent = true;
            nativeInputStarted ||= startsInput;
          },
          verifyPointerTarget: async (node, point) => {
            try {
              await pointerTargetValidator(cdp)(node, point);
            } catch (error) {
              revoked = error instanceof Error ? error.message : String(error);
              throw error;
            }
          },
          beginDomMutation: async () => {
            await this.refresh(state);
            assert();
            if (!nativeInputStarted) await verifyEvidence();
            nativeInputStarted = true;
          },
        }),
        operationSignal,
        completionSignal,
      );
      // A completed download transfers cleanup ownership to the daemon. Keep its
      // receipt even if control changed during final cleanup; dropping it would
      // orphan the file. The consumed context still requires a fresh next step.
      if (["tool.tab_close", "tool.download"].includes(req.method) && !isRpcError(result))
        return result;
      // Even a successful CDP reply does not authorize a stale next step.
      if (state.stopped) return stopped(sent ? "unknown" : "none");
      if (signal.aborted)
        return {
          code: "cancelled",
          message: "Shared-tab action cancelled",
          data: { effect_state: sent ? "unknown" : "none" },
        };
      if (["tool.evaluate", "tool.upload"].includes(req.method)) await this.refresh(state);
      // Navigation replaces its observed document. Return the handler's completed
      // receipt without restoring that context or allowing any further input.
      // Human intervention, cancellation and failed dispatch still take priority.
      const settledNavigation =
        sent &&
        !isRpcError(result) &&
        ["tool.navigate", "tool.navigate_back", "tool.navigate_forward", "tool.reload"].includes(
          req.method,
        );
      const reason = revoked ?? interruption(settledNavigation);
      if (reason) return failure(reason, sent ? "unknown" : "none");
      return result;
    } catch (error) {
      if (state.stopped) return stopped(sent ? "unknown" : "none");
      if (signal.aborted)
        return {
          code: "cancelled",
          message: "Shared-tab action cancelled",
          data: { effect_state: sent ? "unknown" : "none" },
        };
      return failure(
        error instanceof Error ? error.message : String(error),
        sent ? "unknown" : "none",
      );
    } finally {
      finished = true;
      if (state.interruption === intervention) state.interruption = undefined;
      if (state.completion === completion) state.completion = undefined;
      state.working = false;
      this.changed(state);
    }
  }
}
