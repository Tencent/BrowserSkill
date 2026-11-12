import {
  isAgentControlledTab,
  type SessionContext,
  type SessionManager,
} from "@/session-manager/manager";
import { type ResolvedActionTarget, resolveActionTarget } from "@/tools/interaction";
import { captureVomObservation, handleSnapshot } from "@/tools/observation";
import { isPassiveDebugAction, toolPolicy } from "@/tools/policy";
import {
  type CdpRunner,
  cdpBlockedUrlReason,
  chromeTabsApi,
  isRpcError,
  resolveTargetTab,
  sessionCdpRunner,
} from "@/tools/shared";
import { lookupSnapshotRef } from "@/tools/snapshot-ref";
import { AccessibilityLease } from "@/tools/vom/capture-coordinator";
import type { DragTarget, RequestFrame, RpcError } from "@/transport/types";
import {
  ActionCheckError,
  actionError,
  checkActionTarget,
  checkExpectations,
  parseExpectations,
} from "./action-checks";
import { guardedRunner, isInternalActionStep } from "./action-guard";
import { type ControlAuthority, ControlAuthorityError } from "./control-authority";
import { FrameCollectionError, FrameUnresponsiveError } from "./frame-error";
import {
  contentChanges,
  type EvidenceTarget,
  type ObservationEvidence,
  type ObservedChange,
  type ObservedChanges,
  observationEvidence,
  observedChange,
  observedChanges,
  observedKeyboardTargets,
  observesTarget,
  preparationEvidence,
  sameObservationEvidence,
} from "./observation-evidence";
import { pointerTargetValidator } from "./pointer-target";
import { type HeldText, textDelta } from "./text-delta";
import type {
  CooperationFrames,
  CooperationParams,
  CooperationView,
  FrameGap,
  FrameIdentity,
  FrameRepairs,
  FrameState,
  HiddenFrames,
  InputExpectation,
} from "./types";

type Frames = Map<number, FrameState>;
interface Context {
  id: string;
  epoch: number;
  frameEpoch: number;
  refs: number;
  frames: Frames;
  evidence?: ObservationEvidence;
  activityCursor: number;
  observationId?: string;
  consumed?: boolean;
  /** Target control: the page text the agent holds, kept current by text deltas. */
  held?: HeldText;
}
type Activity = FrameState["events"][number] & {
  frame_id: number;
  document: string;
  cursor: number;
};
interface TabState {
  lease: string;
  accessibilityLease: AccessibilityLease;
  /** Only the untouched, agent-created blank tab may bootstrap without an observation. */
  bootstrap: boolean;
  /** Only actual human participation changes the original tab/idle cleanup policy. */
  intervened: boolean;
  target?: CooperationView["target"];
  sessionId: string;
  tabId: number;
  revision: number;
  epoch: number;
  /** Changes to the collected document set, including subframe navigations. */
  frameEpoch: number;
  held: boolean;
  stopped: boolean;
  working: boolean;
  interruption?: AbortController;
  /** Ordinary input revocation must not discard an already accepted download receipt. */
  completion?: AbortController;
  unavailable: boolean;
  /** Frames that did not answer the collection that made this tab unavailable. */
  unresponsive?: FrameIdentity[];
  frames: Frames;
  context?: Context;
  frameGaps: FrameGap[];
  frameRepairs: FrameRepairs;
  hiddenFrames: HiddenFrames;
  baseline?: Context;
  activity: Activity[];
  activitySequence: number;
  activitySeen: Map<string, number>;
  historyGap: boolean;
  controlRevision: number;
  /** Timestamp of the most recent explicit manual hold on this tab. */
  heldAt: number;
  /** Timestamp of the most recent agent or cooperation activity on this tab. */
  lastAgentActivity: number;
  /** Revokes permission guards on human intervention, independently of page revisions. */
  authorityRevision: number;
  /**
   * Nodes whose text changed by itself between a sync and an action (clocks,
   * counters, tickers), keyed to the documents they were observed in.
   */
  volatile?: Volatile;
  /** Changes learned from a refused action; active only after a fresh sync. */
  learned?: Volatile;
}
interface Volatile {
  documents: string;
  keys: Set<string>;
}
export interface CooperationDeps {
  sessions: SessionManager;
  readFrames(
    tabId: number,
    input: InputExpectation | undefined,
    lease: string,
    repairs: FrameRepairs,
    hidden: HiddenFrames,
  ): Promise<CooperationFrames>;
  resumeFrames(
    tabId: number,
    lease: string,
    repairs: FrameRepairs,
    hidden: HiddenFrames,
  ): Promise<void>;
  releaseFrames?(tabId: number, lease: string): Promise<void>;
  changed(tabId: number): void;
  sessionActivity?(sessionId: string, idleProtected: boolean): void;
  now?: () => number;
}
const QUIET_MS = 2_000;
/** Idle gap after which a fresh `cooperate sync`/`enable` automatically resumes a paused or editing tab. */
const IDLE_RESUME_MS = 3_000;
/** Upper bound on nodes whose self-changing text the default check tolerates. */
const MAX_VOLATILE = 256;
/** Effects that prepare input before native input starts. Only identified
 * focus/hover decorations may be excluded from a later DOM-targeted check. */
const PREPARATION_METHODS = new Set([
  "DOM.scrollIntoViewIfNeeded",
  "DOM.focus",
  "Input.dispatchMouseEvent",
  "Emulation.setFocusEmulationEnabled",
]);

function isInitialBlank(tab: { url?: string; pendingUrl?: string }): boolean {
  // Chrome can report the agent-created blank page before its initial load commits.
  return (
    (tab.url || tab.pendingUrl) === "about:blank" &&
    (!tab.pendingUrl || tab.pendingUrl === "about:blank")
  );
}

const UNOBSERVABLE_INITIAL_TAB_URLS = new Set([
  "about:blank",
  "about:newtab",
  "chrome://newtab/",
  "chrome://new-tab-page/",
  "chrome://new-tab-page-third-party/",
  "edge://newtab/",
  "brave://newtab/",
  "vivaldi://newtab/",
  "opera://startpage/",
]);

function normalizeInitialTabUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol === "about:") return `about:${parsed.pathname}`;
  const pathname = parsed.pathname || "/";
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

function isUnobservableInitialTab(tab: { url?: string; pendingUrl?: string }): boolean {
  const current = normalizeInitialTabUrl(tab.url || tab.pendingUrl);
  if (!current || !UNOBSERVABLE_INITIAL_TAB_URLS.has(current)) return false;
  if (!tab.pendingUrl) return true;
  const pending = normalizeInitialTabUrl(tab.pendingUrl);
  return !!pending && UNOBSERVABLE_INITIAL_TAB_URLS.has(pending);
}

function sameFrames(
  a: Frames,
  b: Frames,
  field: "revision" | "structure" | "human" | "document",
): boolean {
  return (
    a.size === b.size &&
    [...a].every(([id, state]) => {
      const other = b.get(id);
      return other?.document === state.document && other[field] === state[field];
    })
  );
}
function documents(frames: Frames): string {
  return JSON.stringify([...frames].map(([id, frame]) => [id, frame.document]));
}
function quote(text: string): string {
  const points = Array.from(text);
  return JSON.stringify(points.length > 40 ? `${points.slice(0, 39).join("")}…` : text);
}
function sameFields(a: Frames, b: Frames, ignoreMediaProgress = false): boolean {
  const stableFields = (frame: FrameState | undefined) =>
    frame?.fields.map((field) =>
      ignoreMediaProgress && field.kind === "media_progress"
        ? { ...field, value: undefined }
        : field,
    );
  return (
    a.size === b.size &&
    [...a].every(
      ([id, frame]) =>
        JSON.stringify(stableFields(frame)) === JSON.stringify(stableFields(b.get(id))),
    )
  );
}
function sameFocus(a: Frames, b: Frames): boolean {
  return (
    a.size === b.size &&
    [...a].every(([id, frame]) => {
      const other = b.get(id);
      return frame.focus === other?.focus && frame.focusIsDocument === other?.focusIsDocument;
    })
  );
}

function sameMedia(a: Frames, b: Frames): boolean {
  return (
    a.size === b.size &&
    [...a].every(
      ([id, frame]) => JSON.stringify(frame.media ?? []) === JSON.stringify(b.get(id)?.media ?? []),
    )
  );
}

/**
 * Ways out for a script refused because the page changed. Declaring comes
 * first: it keeps a real check. Running unverified is the last resort.
 */
const SCRIPT_CHANGE_RECOVERY = {
  target:
    "For data, use read/extract (fixed passive DOM queries) without another sync. For a script, read observed_changes and decide whether it touches what the script relies on. If those facts can be stated, pass them as explicit expect checks and omit observation_id: then only they are checked and the rest of the page may keep changing. Only if they cannot be stated, run evaluate with unverified, which compares nothing about the page; make the script check its own preconditions and throw when they do not hold. Do not resubmit the same script in a sync loop.",
  strict:
    "Read observed_changes and decide whether it touches what the script relies on. If those regions can be named, synchronize and pass them with --depends-on (plugin: dependsOn): then only they, form values and modal layers are checked, and the rest of the page may keep changing. Only if they cannot be named, synchronize and run evaluate with unverified, which compares nothing about the page; make the script check its own preconditions and throw when they do not hold. Do not resubmit the same script in a sync loop.",
};

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
/**
 * Names frames that did not answer collection. A busy frame can recover, so the
 * reason stays the retryable `cooperation_sync_required`; the recovery also says
 * how to leave a frame that keeps failing instead of looping.
 */
function withUnresponsiveFrames(
  result: RpcError,
  frames: (FrameIdentity & { tab_id?: number })[] | undefined,
): RpcError {
  if (!frames?.length) return result;
  return {
    ...result,
    data: {
      ...result.data,
      frames,
      ...(result.data?.effect_state === "unknown"
        ? {}
        : {
            recovery:
              "Use cooperate wait, then cooperate sync; a busy frame can recover. If the same frame keeps failing, use read-only commands such as get-html or snapshot, or stop the session, which also returns borrowed tabs. Never replay an uncertain submission.",
          }),
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

function authorityDenied(message: string): RpcError {
  return {
    code: "permission_denied",
    message,
    data: {
      reason: "control_authority_required",
      effect_state: "none",
      recovery:
        "Wait for the user to return control, then inspect the current operation or dialog before deciding again. Status and cancellation remain available; do not replay the original action.",
    },
  };
}

/** One authority for per-tab ownership, immutable observations, and dispatch fences. */
export class CooperationController implements ControlAuthority {
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

  private controlError(session: SessionContext, state: TabState): RpcError | undefined {
    if (
      this.deps.sessions.get(session.sessionId) !== session ||
      this.tabs.get(state.tabId) !== state ||
      state.sessionId !== session.sessionId ||
      !isAgentControlledTab(session, state.tabId)
    )
      return authorityDenied("Shared-tab control has ended");
    if ([...this.tabs.values()].some((s) => s.sessionId === session.sessionId && s.stopped))
      return stopped();
    if (state.held) return authorityDenied("The user is holding control of this tab");
    if (this.humanActive(state)) return authorityDenied("User activity revoked this action");
  }

  controlGuard(sessionId: string, tabId: number): () => void {
    const session = this.deps.sessions.get(sessionId);
    if (!session || !isAgentControlledTab(session, tabId))
      throw new ControlAuthorityError(authorityDenied("Actions require an owned task tab"));
    const state = this.track(session, tabId);
    const revision = state.authorityRevision;
    const check = () => {
      const error =
        this.controlError(session, state) ??
        (revision !== state.authorityRevision
          ? authorityDenied(
              "Control changed before dispatch; inspect the current state before deciding again",
            )
          : undefined);
      if (error) throw new ControlAuthorityError(error);
    };
    check();
    return check;
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
      accessibilityLease: new AccessibilityLease(tabId),
      bootstrap,
      intervened: false,
      sessionId: session.sessionId,
      tabId,
      revision: 0,
      epoch: 0,
      frameEpoch: 0,
      held: false,
      stopped: false,
      working: false,
      unavailable: true,
      frames: new Map(),
      frameGaps: [],
      frameRepairs: new Map(),
      hiddenFrames: new Set(),
      activity: [],
      activitySequence: 0,
      activitySeen: new Map(),
      historyGap: false,
      controlRevision: 0,
      heldAt: 0,
      lastAgentActivity: this.now(),
      authorityRevision: 0,
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
    void state.accessibilityLease.dispose();
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
      // Explicit human ownership survives navigation and unavailable collection.
      mode:
        state.unavailable && !state.held
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
  private humanBusyOrRecentInput(state: TabState): boolean {
    return [...state.frames.values()].some(
      (f) => f.busy || f.pending || this.now() - f.lastInput < QUIET_MS,
    );
  }
  private canAutoResumeIdle(state: TabState, now: number): boolean {
    if (
      state.stopped ||
      state.working ||
      this.humanBusyOrRecentInput(state) ||
      now - state.lastAgentActivity < IDLE_RESUME_MS ||
      (state.held && now - state.heldAt < QUIET_MS)
    )
      return false;
    return state.held || [...state.frames.values()].some((f) => f.editing);
  }
  private async resumeIdleControl(state: TabState) {
    const controlRevision = state.controlRevision;
    state.epoch++;
    state.context = undefined;
    state.held = false;
    state.controlRevision++;
    state.authorityRevision++;
    this.changed(state);
    await this.deps.resumeFrames(state.tabId, state.lease, state.frameRepairs, state.hiddenFrames);
    if (state.controlRevision === controlRevision + 1) await this.refresh(state);
  }
  private humanActive(state: TabState): boolean {
    return [...state.frames.values()].some(
      (f) => f.busy || f.editing || this.now() - f.lastInput < QUIET_MS,
    );
  }
  private async prepareFrames(
    state: TabState,
    signal: AbortSignal,
    input?: InputExpectation,
    method?: string,
    deadline = Date.now() + 25000,
  ) {
    // A press or a cancelled edit can finish without transferring control.
    // Wait at the dispatch boundary, retaining the action and its context.
    const coordinateInput =
      method === "DOM.getBoxModel" ||
      method === "DOM.scrollIntoViewIfNeeded" ||
      method === "Input.dispatchMouseEvent" ||
      method === "Input.dispatchDragEvent";
    const authorityRevision = state.authorityRevision;
    const epoch = state.epoch;
    const inputDeadline = Math.min(deadline, Date.now() + 25000);
    await this.refresh(state, input);
    let waited = false;
    while (
      !state.held &&
      !state.stopped &&
      !this.humanActive(state) &&
      !state.interruption?.signal.aborted &&
      [...state.frames.values()].some(
        (frame) => frame.pending || (coordinateInput && frame.scrolling),
      )
    ) {
      signal.throwIfAborted();
      if (Date.now() >= inputDeadline)
        throw new ActionCheckError({
          ...actionError(
            "input_not_ready",
            "The page input gesture has not finished",
            "precondition",
            "Wait for the gesture to finish before choosing another action.",
          ),
          code: "timeout",
        });
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(25, inputDeadline - Date.now())),
      );
      signal.throwIfAborted();
      await this.refresh(state);
      waited = true;
    }
    if (waited && input) {
      if (
        !this.humanActive(state) &&
        !state.held &&
        !state.stopped &&
        !signal.aborted &&
        !state.interruption?.signal.aborted &&
        state.authorityRevision === authorityRevision &&
        state.epoch === epoch
      )
        await this.refresh(state, input);
    }
  }
  private changed(state: TabState) {
    state.revision++;
    this.deps.changed(state.tabId);
  }
  private clearWindowObservations(sessionId: string) {
    // Window geometry can change every tab's layout without a DOM mutation.
    for (const tab of this.tabs.values()) if (tab.sessionId === sessionId) tab.baseline = undefined;
  }
  receive(tabId: number, frameId: number, frame: FrameState, lease?: string) {
    const state = this.tabs.get(tabId);
    if (!state || (lease !== undefined && lease !== state.lease)) return;
    const old = state.frames.get(frameId);
    const sameDocument = old?.document === frame.document;
    const seen = state.activitySeen.get(`${frameId}:${frame.document}`) ?? 0;
    if (lease === state.lease) this.remember(state, frameId, frame);
    if (sameDocument && frame.revision < old.revision) return;
    const humanChanged = sameDocument
      ? frame.human !== old.human
      : lease === state.lease && frame.human > seen && this.now() - frame.lastInput < QUIET_MS;
    if (humanChanged) {
      if (!sameDocument || frame.human > old.human) this.preserve(state);
      state.interruption?.abort(new Error("User activity revoked this action"));
      state.authorityRevision++;
      state.epoch++;
      state.context = undefined;
    }
    // New or late documents can revoke control, but only collection establishes
    // the current frame. Repeated notifications cannot revoke a newer decision.
    if (sameDocument) state.frames = new Map(state.frames).set(frameId, frame);
    if (sameDocument || humanChanged) this.changed(state);
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
    state.accessibilityLease.markNeedsEnable();
    state.epoch++;
    state.context = undefined;
    state.unavailable = true;
    state.unresponsive = undefined;
    this.changed(state);
  }
  invalidateChildFrames(tabId: number) {
    const state = this.tabs.get(tabId);
    if (!state) return;
    state.accessibilityLease.markNeedsEnable();
    state.frameEpoch++;
    this.changed(state);
  }
  markAccessibilityNeedsEnable(tabId: number) {
    this.tabs.get(tabId)?.accessibilityLease.takeEntries();
  }
  async control(tabId: number, revision: number, action: "hold" | "resume") {
    const state = this.tabs.get(tabId);
    if (!state || state.revision !== revision) return { ok: false, state: this.view(tabId) };
    this.preserve(state);
    state.epoch++;
    state.context = undefined;
    // Reserve the transition before awaiting a renderer. A newer hold wins.
    state.held = action === "hold";
    if (state.held) {
      state.heldAt = this.now();
      state.interruption?.abort(new Error("The user is holding control"));
    }
    state.controlRevision++;
    state.authorityRevision++;
    if (action === "resume") state.stopped = false;
    this.sessionActivity(state.sessionId);
    const epoch = state.epoch;
    this.changed(state);
    if (action === "resume") {
      await this.deps.resumeFrames(tabId, state.lease, state.frameRepairs, state.hiddenFrames);
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
        state.authorityRevision++;
        const reason = new Error("The user stopped this task");
        state.interruption?.abort(reason);
        state.completion?.abort(reason);
        void state.accessibilityLease.release();
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
      const collection = await this.deps.readFrames(
        state.tabId,
        input,
        state.lease,
        state.frameRepairs,
        state.hiddenFrames,
      );
      frames = collection.frames;
      if (!live()) throw new Error("Shared-tab control ended during collection");
      if (!frames.size || !frames.has(0))
        throw new Error("Page interaction coverage is unavailable");
      state.frameGaps = collection.gaps;
    } catch (error) {
      state.unavailable = true;
      state.unresponsive = error instanceof FrameUnresponsiveError ? error.frames : undefined;
      state.context = undefined;
      this.changed(state);
      throw error;
    }
    const authorityRevision = state.authorityRevision;
    for (const [id, next] of frames) {
      const old = state.frames.get(id);
      if (old?.document === next.document) {
        if (next.revision < old.revision) frames.set(id, old);
        else if (next.human !== old.human) {
          state.authorityRevision++;
          if (next.human > old.human) this.preserve(state);
        }
      } else if (
        next.human > (state.activitySeen.get(`${id}:${next.document}`) ?? 0) &&
        this.now() - next.lastInput < QUIET_MS
      ) {
        state.authorityRevision++;
        this.preserve(state);
      }
    }
    const documentsChanged = state.frames.size > 0 && !sameFrames(state.frames, frames, "document");
    if (documentsChanged) {
      state.frameEpoch++;
      state.accessibilityLease.markNeedsEnable();
    }
    const mainDocumentChanged =
      documentsChanged && state.frames.get(0)?.document !== frames.get(0)?.document;
    // Child documents revoke observation evidence through frameEpoch, rather
    // than control itself. An unverified script still needs the same main
    // document and uninterrupted authority, but does not use that evidence.
    if (state.authorityRevision !== authorityRevision || mainDocumentChanged) {
      state.epoch++;
      state.context = undefined;
    }
    for (const [id, frame] of frames) this.remember(state, id, frame);
    state.frames = frames;
    state.unavailable = false;
    state.unresponsive = undefined;
    return frames;
  }
  async command(params: CooperationParams, cdp: CdpRunner, signal: AbortSignal): Promise<unknown> {
    const session = this.deps.sessions.get(params.session_id);
    if (!session) return { code: "not_found", message: "Unknown session" };
    cdp = sessionCdpRunner(
      cdp,
      session.sessionId,
      () => this.deps.sessions.get(session.sessionId) === session,
    );
    this.startSession(session.sessionId);
    if (!["enable", "status", "sync", "wait"].includes(params.action))
      return { code: "invalid_params", message: "Unknown cooperation action" };
    if (
      params.control_policy !== undefined &&
      (!["auto", "strict", "target"].includes(params.control_policy) ||
        !["sync", "enable"].includes(params.action))
    )
      return {
        code: "invalid_params",
        message: "control_policy must be auto, strict or target on sync/enable",
      };
    const requestedPolicy =
      params.control_policy === "auto"
        ? (session.controlPolicy ?? "target")
        : params.control_policy;
    if (requestedPolicy && session.controlPolicy && requestedPolicy !== session.controlPolicy)
      return {
        code: "invalid_params",
        message: "Control policy is fixed for this session; start a new session to change it",
      };
    const target = await resolveTargetTab(
      this.deps.sessions,
      session,
      params.tab_id ?? this.defaultTabs.get(session.sessionId),
      chromeTabsApi,
    );
    if (isRpcError(target)) return target;
    if (!isAgentControlledTab(session, target.tabId))
      return failure("Cooperation requires an owned tab");
    const policy = session.controlPolicy ?? requestedPolicy ?? "strict";
    const targetPolicy = policy === "target";
    const state = this.track(session, target.tabId);
    if (state.sessionId !== session.sessionId)
      return failure("This tab belongs to another session");
    if (state.stopped && params.action !== "status") return stopped();
    if (!isInitialBlank(target)) state.bootstrap = false;
    const commandEnteredAt = this.now();
    if (params.action === "enable" || (params.action === "sync" && params.tab_id !== undefined))
      this.defaultTabs.set(session.sessionId, state.tabId);
    try {
      if (params.action === "enable")
        await cdp.releaseBackgroundExecution?.(session.sessionId, state.tabId);
      const refresh = async () => {
        try {
          await this.refresh(state);
        } catch (error) {
          if (params.action !== "wait" || signal.aborted || error instanceof FrameCollectionError)
            throw error;
          state.unavailable = true;
        }
      };
      await refresh();
      if (params.action === "wait") {
        const timeout = Math.min(Math.max(params.timeout_ms ?? 15000, 0), 25000);
        const deadline = this.now() + timeout;
        while (
          (state.unavailable ||
            state.held ||
            this.humanActive(state) ||
            state.working ||
            [...state.frames.values()].some((frame) => frame.pending)) &&
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
      if (params.action !== "sync" && params.action !== "enable") {
        if (
          params.action === "wait" &&
          !this.humanBusyOrRecentInput(state) &&
          (!state.held || this.now() - state.heldAt >= QUIET_MS)
        )
          state.lastAgentActivity = this.now();
        return {
          tab_id: state.tabId,
          stopped: state.stopped,
          activity: state.activity.filter(
            (event) => event.cursor > (state.baseline?.activityCursor ?? 0),
          ),
          state: this.view(state.tabId),
          ready:
            !state.unavailable &&
            !state.held &&
            !state.working &&
            !this.humanActive(state) &&
            ![...state.frames.values()].some((frame) => frame.pending),
          control_policy: session.controlPolicy ?? null,
          ...(state.frameGaps.length ? { frame_gaps: state.frameGaps } : {}),
        };
      }
      if (
        (state.held || this.humanActive(state)) &&
        this.canAutoResumeIdle(state, commandEnteredAt)
      ) {
        await this.resumeIdleControl(state);
        if (state.stopped) return stopped();
      }
      if (state.held || state.working || this.humanActive(state))
        return failure("The user is still operating this tab; wait for hand-back");
      await cdp.reconcileSoftDetachedFrames?.(state.tabId);
      if (state.stopped) return stopped();
      const previousRefs = session.refStore;
      const previousRefRevision = previousRefs.revision;
      const refStore = session.controlPolicy ? previousRefs : previousRefs.createObservationStore();
      if (targetPolicy) refStore.enableStableRefs();
      state.working = true;
      const previousContext = state.context;
      if (!targetPolicy) state.context = undefined;
      this.changed(state);
      try {
        const before = state.frames;
        const epoch = state.epoch;
        const frameEpoch = state.frameEpoch;
        const baseline = state.baseline;
        let evidence = baseline?.evidence;
        const fieldsComplete = [...before.values()].every(
          (frame) => frame.fieldsComplete !== false,
        );
        const comparable =
          baseline &&
          baseline.frameEpoch === frameEpoch &&
          fieldsComplete &&
          baseline.refs === session.refStore.revision &&
          sameMedia(baseline.frames, before);
        const exact =
          comparable &&
          (!targetPolicy || sameFrames(baseline.frames, before, "revision")) &&
          sameFrames(baseline.frames, before, "structure") &&
          sameFocus(baseline.frames, before);
        // Target control otherwise re-captures after any activity. When all of it
        // is text a frame logged in full, patch the text the agent already holds.
        const patched =
          baseline && comparable && !exact && targetPolicy
            ? textDelta(baseline.held, params.max_tokens, baseline.frames, before)
            : undefined;
        const text = typeof patched === "object" ? patched : undefined;
        const delta = baseline && (exact || !!text);
        const baselineReason = delta
          ? undefined
          : !baseline
            ? "no_previous_observation"
            : baseline.frameEpoch !== frameEpoch
              ? "frame_replaced"
              : !fieldsComplete
                ? "fields_incomplete"
                : baseline.refs !== session.refStore.revision
                  ? "refs_replaced"
                  : !sameMedia(baseline.frames, before)
                    ? "media_changed"
                    : (patched ??
                      (!sameFrames(baseline.frames, before, "structure")
                        ? "structure_changed"
                        : "focus_changed"));
        // The private evidence describes the text and focus as they were captured.
        if (text && (text.lines.length || text.focusMoved)) evidence = undefined;
        // A delta updates the model's field values. Refresh private semantic
        // evidence too, without replacing refs or repeating page text to the model.
        if (delta && !sameFields(baseline.frames, before))
          await captureVomObservation(guardedRunner(cdp), state.tabId, target.url, {
            signal,
            accessibilityLease: state.accessibilityLease,
            skipRender: true,
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
                refStore,
                accessibilityLease: state.accessibilityLease,
                onScene: (scene) => {
                  evidence = observationEvidence(scene);
                },
              },
              signal,
            );
        if (observation && isRpcError(observation)) return observation;
        const after = await this.refresh(state);
        if (state.stopped) return stopped();
        // A full target snapshot can publish main-document control during child
        // navigation. Its strict observation remains bound to the pre-capture frames.
        if (
          signal.aborted ||
          state.epoch !== epoch ||
          (state.frameEpoch !== frameEpoch && (!targetPolicy || delta)) ||
          (!targetPolicy &&
            (!sameFields(before, after, true) ||
              !sameMedia(before, after) ||
              (delta && !sameFrames(before, after, "structure")))) ||
          this.humanActive(state) ||
          state.held
        )
          return failure("Page changed while synchronizing; sync again after it settles");
        if (
          refStore !== previousRefs &&
          (session.refStore !== previousRefs || previousRefs.revision !== previousRefRevision)
        )
          return failure(
            session.controlPolicy
              ? `Another sync initialized this session with ${session.controlPolicy} control; synchronize again using that policy`
              : "The session observation changed during policy negotiation; synchronize again",
          );
        session.refStore = refStore;
        session.controlPolicy = policy;
        const context: Context = {
          id:
            targetPolicy && previousContext?.epoch === epoch
              ? previousContext.id
              : crypto.randomUUID(),
          epoch,
          frameEpoch,
          refs: session.refStore.revision,
          frames: before,
          evidence,
          activityCursor: state.activitySequence,
          observationId: crypto.randomUUID(),
          ...(targetPolicy
            ? {
                held: observation
                  ? {
                      text: observation.text,
                      truncated: observation.truncated,
                      maxTokens: params.max_tokens,
                    }
                  : text && baseline?.held
                    ? { ...baseline.held, text: text.text }
                    : baseline?.held,
              }
            : {}),
        };
        state.context = context;
        state.baseline = context;
        // The agent has now observed the refused change; tolerate it from here on.
        if (state.learned) {
          const pages = documents(before);
          if (state.learned.documents === pages)
            state.volatile = {
              documents: pages,
              keys: new Set([
                ...(state.volatile?.documents === pages ? state.volatile.keys : []),
                ...state.learned.keys,
              ]),
            };
          state.learned = undefined;
        }
        const activity = state.activity.filter(
          (event) => event.cursor > (baseline?.activityCursor ?? 0),
        );
        const historyGap = state.historyGap;
        state.historyGap = false;
        return {
          tab_id: state.tabId,
          context_id: context.id,
          control_policy: session.controlPolicy ?? "strict",
          ...(state.frameGaps.length ? { frame_gaps: state.frameGaps } : {}),
          ...(targetPolicy ? { observation_id: context.observationId } : {}),
          kind: delta
            ? !text && sameFrames(baseline.frames, after, "revision")
              ? "unchanged"
              : "delta"
            : "baseline",
          ...(baselineReason ? { baseline_reason: baselineReason } : {}),
          ...(delta
            ? {
                previous_context_id: baseline.id,
                // One context id spans many observations under target control.
                ...(targetPolicy && baseline.observationId
                  ? { previous_observation_id: baseline.observationId }
                  : {}),
                ...(text ? { observation_patch: { lines: text.lines } } : {}),
                changes: [
                  ...(text?.changes ?? []),
                  ...[...after].flatMap(([frameId, frame]) =>
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
                ],
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
        };
      } finally {
        state.working = false;
        state.lastAgentActivity = this.now();
        this.changed(state);
      }
    } catch (error) {
      if (state.stopped) return stopped();
      if (signal.aborted) return { code: "cancelled", message: "Cooperation wait cancelled" };
      state.unavailable = true;
      state.context = undefined;
      this.changed(state);
      if (error instanceof FrameCollectionError) return error.toRpcError();
      return withUnresponsiveFrames(
        failure(error instanceof Error ? error.message : String(error)),
        state.unresponsive,
      );
    }
  }

  private async bootstrap<T extends CdpRunner>(
    state: TabState,
    method: string,
    cdp: T,
    signal: AbortSignal,
    invoke: (cdp: T) => Promise<unknown>,
    epoch = state.epoch,
  ): Promise<unknown> {
    if (state.working) return failure("Another operation is settling on this tab");
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
            const allowedBlank = state.bootstrap
              ? isInitialBlank(tab)
              : isUnobservableInitialTab(tab);
            if (!session || tab.windowId !== session.agentWindowId || !allowedBlank)
              throw new Error(
                (revoked = "The initial task tab changed; synchronize before acting"),
              );
            assert();
          },
          dispatch: (_input, nativeMethod) => {
            assert();
            sent = true;
            if (
              nativeMethod === "Page.navigate" ||
              (method === "tool.navigate" && nativeMethod === "Browser.mutate")
            )
              state.bootstrap = false;
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
      if (sent && method === "tool.window_resize") this.clearWindowObservations(state.sessionId);
      if (sent) state.lastAgentActivity = this.now();
      state.working = false;
      if (method === "tool.navigate") await this.observeTab(state.tabId);
      this.changed(state);
    }
  }

  /** Tab activation/movement affects the whole task window, not just its destination. */
  /** Collection failed only because the tab still shows an empty initial/new-tab document. */
  private async unobservableBlank(state: TabState, error: unknown): Promise<boolean> {
    if (
      !(error instanceof FrameCollectionError) ||
      error.reason !== "frame_unobservable" ||
      error.frames.length === 0 ||
      error.frames.some((frame) => frame.frame_id !== 0)
    )
      return false;
    const tab = await chromeTabsApi.get(state.tabId).catch(() => undefined);
    return !!tab && isUnobservableInitialTab(tab);
  }
  /**
   * Returning a borrowed tab that is stuck on a browser-restricted page or a
   * failed root-document load must remain possible without tearing down the
   * whole session, while all other owned tabs are still prepared normally.
   */
  private async unobservableReturnTarget(
    session: SessionContext,
    state: TabState,
    returningTabId: number | undefined,
    error: unknown,
  ): Promise<boolean> {
    if (
      returningTabId === undefined ||
      state.tabId !== returningTabId ||
      !session.borrowedTabs.has(state.tabId) ||
      !(error instanceof FrameCollectionError) ||
      error.frames.length === 0 ||
      error.frames.some((frame) => frame.frame_id !== 0)
    )
      return false;
    const tab = await chromeTabsApi.get(state.tabId).catch(() => undefined);
    if (!tab) return false;
    if (error.reason === "page_load_failed") return !tab.pendingUrl;
    if (error.reason === "frame_unobservable") {
      const current = tab.url || tab.pendingUrl;
      return (
        cdpBlockedUrlReason(current) !== null &&
        (!tab.pendingUrl || cdpBlockedUrlReason(tab.pendingUrl) !== null)
      );
    }
    return false;
  }
  private async manageTabs<T extends CdpRunner>(
    session: SessionContext,
    cdp: T,
    signal: AbortSignal,
    invoke: (cdp: T, signal?: AbortSignal) => Promise<unknown>,
    returningTabId?: number,
  ): Promise<unknown> {
    const states = [...this.tabs.values()].filter((state) => state.sessionId === session.sessionId);
    if (states.some((state) => state.working))
      return failure("Another operation is settling on this tab");
    const enteredAt = this.now();
    for (const state of states) {
      if ((state.held || this.humanActive(state)) && this.canAutoResumeIdle(state, enteredAt)) {
        try {
          await this.resumeIdleControl(state);
        } catch {
          // prepare() below reports collection failures consistently.
        }
      }
    }
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
        for (const state of states) {
          if (state.bootstrap) continue;
          try {
            await this.prepareFrames(state, signal);
          } catch (error) {
            // A blank page offers no human input to miss. A borrowed one has no
            // collector, and refusing here would also block returning it.
            if (
              !(await this.unobservableBlank(state, error)) &&
              !(await this.unobservableReturnTarget(session, state, returningTabId, error))
            )
              throw error;
          }
        }
        assert();
      } catch (error) {
        revoked ??= error instanceof Error ? error.message : String(error);
        throw error;
      }
    };
    // Tab operations prepare every owned tab, so name the tab of each silent frame.
    const refusal = (message: string) =>
      withUnresponsiveFrames(
        failure(message, sent ? "unknown" : "none"),
        states.flatMap((state) =>
          state.unavailable
            ? (state.unresponsive ?? []).map((frame) => ({ tab_id: state.tabId, ...frame }))
            : [],
        ),
      );
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
      if (revoked) return refusal(revoked);
      return result;
    } catch (error) {
      if (states.some((state) => state.stopped)) return stopped(sent ? "unknown" : "none");
      if (signal.aborted)
        return {
          code: "cancelled",
          message: "Tab operation cancelled",
          data: { effect_state: sent ? "unknown" : "none" },
        };
      return refusal(error instanceof Error ? error.message : String(error));
    } finally {
      for (const state of states) {
        if (sent) state.lastAgentActivity = this.now();
        state.working = false;
        if (this.tabs.get(state.tabId) === state) this.changed(state);
      }
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
          observation_id?: string;
          expect?: unknown;
          capture_id?: string;
          image_x?: number;
          image_y?: number;
          timeout_ms?: number;
          probe_hover?: boolean;
          ref?: string;
          selector?: string;
          depends_on?: string[];
          unverified?: unknown;
          source?: DragTarget;
          target?: DragTarget;
        }
      | undefined;
    const policy = toolPolicy(req.method);
    if (policy?.cooperation === "session_start") {
      const result = await invoke(cdp);
      if (!isRpcError(result) && params?.session_id) this.startSession(params.session_id);
      return result;
    }
    if (policy?.cooperation === "cooperate")
      return this.command(params as CooperationParams, cdp, signal);
    if (
      !params?.session_id ||
      !policy ||
      policy.cooperation === "session" ||
      policy.cooperation === "dialog"
    )
      return invoke(cdp);
    const session = this.deps.sessions.get(params.session_id);
    if (!session) return invoke(cdp);
    cdp = sessionCdpRunner(
      cdp,
      session.sessionId,
      () => this.deps.sessions.get(session.sessionId) === session,
    );
    const targetPolicy = session.controlPolicy === "target";
    this.startSession(session.sessionId);
    if (
      policy.cooperation !== "passive_read" &&
      [...this.tabs.values()].some((s) => s.sessionId === params.session_id && s.stopped)
    )
      return stopped();
    if (policy.cooperation === "manage_tabs") {
      if (
        req.method === "tool.tab_select" &&
        (params.tab_id === undefined || !isAgentControlledTab(session, params.tab_id))
      )
        return failure("Select an owned task tab; borrow user tabs explicitly");
      // Shared tabs never acquire background focus emulation. Keep an unspecified
      // new tab navigable, as the initial session tab is.
      if (req.method === "tool.tab_create" && (req.params as { url?: string }).url === undefined)
        req.params = { ...params, url: "about:blank" };
      const returningTabId =
        req.method === "tool.tab_return" && typeof params.tab_id === "number"
          ? params.tab_id
          : undefined;
      const result = await this.manageTabs(session, cdp, signal, invoke, returningTabId);
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
    if (policy.cooperation === "request_help") {
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
          await this.deps.resumeFrames(
            state.tabId,
            state.lease,
            state.frameRepairs,
            state.hiddenFrames,
          );
        }
        return result;
      } finally {
        if (!state.stopped && state.controlRevision === controlRevision) state.held = held;
        state.working = false;
        this.changed(state);
      }
    }
    if (policy.cooperation === "record_start") {
      const target = await resolveTargetTab(
        this.deps.sessions,
        session,
        params.tab_id ?? this.defaultTabs.get(session.sessionId),
        chromeTabsApi,
      );
      if (isRpcError(target)) return target;
      if (!isAgentControlledTab(session, target.tabId))
        return failure("Actions require an owned task tab; borrow user tabs explicitly");
      const state = this.track(session, target.tabId);
      if (state.working) return failure("Another operation is settling on this tab");
      if ((state.held || this.humanActive(state)) && this.canAutoResumeIdle(state, this.now())) {
        try {
          await this.resumeIdleControl(state);
        } catch {
          /* Fall through to held/humanActive check below. */
        }
        if (state.stopped) return stopped();
      }
      if (state.held || this.humanActive(state))
        return failure("The user is still operating this tab; wait for hand-back");
      req.params = { ...params, tab_id: target.tabId };
      state.bootstrap = false;
      state.working = true;
      state.context = undefined;
      state.baseline = undefined;
      state.epoch++;
      this.changed(state);
      try {
        const result = await invoke(cdp);
        if (!isRpcError(result)) await this.observeTab(state.tabId);
        return result;
      } finally {
        state.working = false;
        this.changed(state);
      }
    }
    const read = policy.cooperation === "passive_read" && !params.probe_hover;
    // History/status remain usable after a task tab closes; their handlers enforce ownership.
    const action = (req.params as { action?: string }).action;
    if (
      (policy.cooperation === "debug" && isPassiveDebugAction(action)) ||
      (policy.cooperation === "video" &&
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
      return targetPolicy
        ? actionError(
            "control_context_invalid",
            "This control context is no longer valid for this session and tab",
            "control",
            "Synchronize the intended tab after control is returned, inspect the current state and decide again.",
          )
        : failure("This context belongs to a different or superseded observation");
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
    if (state.bootstrap && policy.bootstrapAllowed && !params.context_id) {
      if (
        params.expect !== undefined ||
        params.observation_id !== undefined ||
        params.depends_on?.length
      )
        return {
          code: "invalid_params",
          message:
            "The initial blank tab has no observed content; omit expect, observation_id and depends_on or synchronize first",
          data: { phase: "precondition", effect_state: "none" },
        };
      return this.bootstrap(state, req.method, cdp, signal, invoke);
    }
    if (read) {
      // Reads need no action authority. When a caller explicitly supplies a
      // context, however, a retained strict baseline cannot validate a revoked
      // control context after navigation/intervention. Never renew it by reading.
      if (req.method === "tool.read" && params.context_id) {
        const invalidContext = () =>
          actionError(
            "control_context_invalid",
            "This read supplied a revoked control context",
            "control",
            "Omit the old context to inspect current data; synchronize and reconsider before further input.",
          );
        try {
          await this.refresh(state);
        } catch (error) {
          // No read has been dispatched. Preserve permanent frame diagnostics;
          // ordinary loading failures have already revoked the supplied context.
          return error instanceof FrameCollectionError
            ? error.toRpcError("none")
            : invalidContext();
        }
        if (
          state.context?.id !== params.context_id ||
          state.context.epoch !== state.epoch ||
          this.controlError(session, state)
        )
          return invalidContext();
      }
      return invoke(guardedRunner(cdp));
    }
    if (state.working) return failure("Another operation is settling on this tab");
    const expectations = parseExpectations(params.expect);
    if (isRpcError(expectations)) return expectations;
    if (targetPolicy && params.depends_on?.length)
      return {
        code: "invalid_params",
        message: "depends_on requires strict policy; use explicit expect checks with target policy",
        data: { phase: "precondition", effect_state: "none" },
      };
    const script = req.method === "tool.evaluate";
    if (params.unverified !== undefined && (!script || typeof params.unverified !== "boolean"))
      return {
        code: "invalid_params",
        message: "unverified is a boolean accepted only by evaluate",
        data: { phase: "precondition", effect_state: "none" },
      };
    // The caller takes responsibility for the page being as it expects. Asking
    // for a page check as well is a contradiction, not a stricter request.
    const unverified = script && params.unverified === true;
    if (
      unverified &&
      (params.expect !== undefined ||
        params.depends_on?.length ||
        params.observation_id !== undefined)
    )
      return {
        code: "invalid_params",
        message:
          "unverified skips page verification; omit expect, depends_on and observation_id, or omit unverified to have them checked",
        data: { phase: "precondition", effect_state: "none" },
      };
    // Only the caller knows what an opaque script relies on. When it says so,
    // those facts or regions are checked instead of the whole page. Passing a
    // strict observation as well still asks for the whole page, as it always has.
    const declared =
      script &&
      (targetPolicy
        ? expectations.length > 0 && params.observation_id === undefined
        : !!params.depends_on?.length);
    const scopedScript = unverified || declared;
    const primaryTarget = req.method === "tool.drag" ? params.source : params;
    const visual =
      params.capture_id !== undefined ||
      params.image_x !== undefined ||
      params.image_y !== undefined;
    // Authorized by the control context plus explicit checks, not by a strict
    // observation of the whole page.
    const targeted =
      targetPolicy &&
      (scopedScript ||
        (policy.domTargeted &&
          !visual &&
          !!(primaryTarget?.ref || primaryTarget?.selector) &&
          (req.method !== "tool.drag" || !!(params.target?.ref || params.target?.selector))));
    let sent = false;
    let finished = false;
    let revoked: string | undefined;
    // Whether this action has scrolled, focused or hovered before its input.
    let preparationSent = false;
    let preparationFocus = false;
    let preparationHover = false;
    // The first observed difference behind an evidence refusal, for diagnosis.
    let observed:
      | (Partial<ObservedChange> & { scope: string; phase: "decision" | "preparation" })
      | undefined;
    // All of them in brief, so the caller can judge whether they matter to it.
    let observedSummary: ObservedChanges | undefined;
    let nativeInputStarted = false;
    const context = targetPolicy && !targeted ? state.baseline : state.context;
    const rootFrameId = context?.evidence?.rootFrameId;
    const mainDocumentRef = (ref: string) => {
      const node = lookupSnapshotRef(session, ref, target.tabId);
      return rootFrameId !== undefined && node?.frameId === rootFrameId && !node.cdpSessionId;
    };
    const mainDocumentTarget = (node?: DragTarget) =>
      node?.ref ? mainDocumentRef(node.ref) : !!node?.selector;
    // Selectors are main-document only. Refs must prove their frame, including
    // both drag endpoints and any refs whose facts authorize the action. A
    // script runs in the main document, so only its stated facts can involve
    // another frame.
    const mainDocumentAction =
      targeted &&
      (scopedScript ||
        (mainDocumentTarget(primaryTarget) &&
          (req.method !== "tool.drag" || mainDocumentTarget(params.target)))) &&
      expectations.every(({ target }) => !/^@?e\d+$/.test(target) || mainDocumentRef(target));
    const observedFramesChanged = () =>
      !unverified &&
      !mainDocumentAction &&
      context !== undefined &&
      context.frameEpoch !== state.frameEpoch;
    let epoch = state.epoch;
    let detachedByHandler = false;
    let postRefreshFailed = false;
    const authorityRevision = state.authorityRevision;
    const idleAtEntry = this.canAutoResumeIdle(state, this.now());
    let verifiedFrames = context?.frames;
    let evidenceTargets: { backendNodeId: number; frameId?: string }[] | undefined;
    let actionTarget: ResolvedActionTarget | undefined;
    let destinationTarget: typeof actionTarget;
    let checkFailure: RpcError | undefined;
    // Preparation such as scrolling counts as an effect, so a click can be `unknown`
    // without having been pressed. Only that distinction makes it safe to try again.
    const unpressed = (effect: unknown) =>
      effect === "unknown" && req.method === "tool.click" && !nativeInputStarted
        ? { press_sent: false }
        : {};
    const describeFailure = (message: string, effect: "none" | "unknown"): RpcError => {
      if (
        checkFailure?.data?.reason === "input_clock_unavailable" &&
        !intervention.signal.aborted &&
        state.authorityRevision === authorityRevision
      )
        return {
          ...checkFailure,
          data: { ...checkFailure.data, effect_state: effect, ...unpressed(effect) },
        };
      const diagnosis = observed
        ? {
            observed_change: observed,
            ...(observedSummary ? { observed_changes: observedSummary } : {}),
          }
        : {};
      const idleResumable =
        idleAtEntry &&
        effect === "none" &&
        !intervention.signal.aborted &&
        state.authorityRevision === authorityRevision &&
        !this.humanBusyOrRecentInput(state);
      if (!targetPolicy) {
        const refused = failure(message, effect);
        return {
          ...refused,
          data: {
            ...refused.data,
            ...unpressed(effect),
            ...diagnosis,
            ...(idleResumable
              ? {
                  recovery:
                    "Use cooperate sync to resume control and reconcile the live result before issuing a new action. Never replay an uncertain submission.",
                }
              : script && observed && effect === "none"
                ? { recovery: SCRIPT_CHANGE_RECOVERY.strict }
                : {}),
          },
        };
      }
      if (effect === "unknown") state.context = undefined;
      const controlReason =
        state.held && !idleResumable
          ? "control_held"
          : (this.humanActive(state) && !idleResumable) ||
              intervention.signal.aborted ||
              state.authorityRevision !== authorityRevision
            ? "human_intervention"
            : observedFramesChanged() ||
                (context && context.frames.get(0)?.document !== state.frames.get(0)?.document)
              ? "document_changed"
              : state.unavailable ||
                  state.epoch !== epoch ||
                  detachedByHandler ||
                  this.controlError(session, state)
                ? "control_context_invalid"
                : undefined;
      const issue =
        !controlReason && checkFailure
          ? checkFailure
          : actionError(
              controlReason ?? "control_context_invalid",
              message,
              "control",
              idleResumable
                ? "Synchronize this tab and inspect the live result before deciding again. Never replay an uncertain action."
                : "Wait for control if needed, synchronize and inspect the live result before deciding again. Never replay an uncertain action.",
            );
      return {
        ...issue,
        data: {
          ...issue.data,
          effect_state: effect,
          ...unpressed(effect),
          ...diagnosis,
          ...(effect === "unknown"
            ? {
                recovery:
                  "Inspect the application result and synchronize before choosing another action. Never replay an uncertain submission.",
              }
            : {}),
        },
      };
    };
    const reportFailure = (message: string, effect: "none" | "unknown" = "none"): RpcError =>
      withUnresponsiveFrames(
        describeFailure(message, effect),
        state.unavailable ? state.unresponsive : undefined,
      );
    state.working = true;
    const intervention = new AbortController();
    state.interruption = intervention;
    const completion = new AbortController();
    state.completion = completion;
    const completionSignal = AbortSignal.any([signal, completion.signal]);
    const operationSignal = AbortSignal.any([completionSignal, intervention.signal]);
    const interruption = (completed = false): string | undefined => {
      if (finished) return "The action has already settled";
      if (intervention.signal.aborted) return String(intervention.signal.reason.message);
      const denied = this.controlError(session, state);
      if (denied) return denied.message;
      if (state.authorityRevision !== authorityRevision) return "User activity revoked this action";
      if (!completed && state.unavailable)
        return "Page interaction coverage changed; wait and synchronize";
      if (!completed && observedFramesChanged())
        return "A page frame changed; synchronize before choosing this action";
      if (
        req.method === "tool.press" &&
        !nativeInputStarted &&
        !params.ref &&
        !params.selector &&
        context &&
        !sameFocus(context.frames, state.frames)
      )
        return "The keyboard focus changed; synchronize before pressing a key";
      if (
        !completed &&
        !targeted &&
        !scopedScript &&
        !nativeInputStarted &&
        context &&
        !sameMedia(context.frames, state.frames)
      )
        return "The media source changed; synchronize and replan";
      if (!completed && state.epoch !== epoch)
        return "The observed page or control state changed; synchronize";
    };
    const assert = () => {
      signal.throwIfAborted();
      if (checkFailure) throw new ActionCheckError(checkFailure);
      const reason =
        interruption() ??
        (detachedByHandler ? "The observed page or control state changed; synchronize" : undefined);
      if (reason) {
        if (!targetPolicy && context && state.context === context) state.context = undefined;
        // Refusing a strict observation must not discard the reusable DOM context.
        if (targetPolicy && !targeted && context) context.consumed = true;
        throw new Error((revoked = reason));
      }
    };
    const verifyEvidence = async () => {
      if (!context || !verifiedFrames) throw new Error((revoked = "Synchronize before acting"));
      if (sameFrames(verifiedFrames, state.frames, "revision")) return;
      if (!context.evidence) {
        // A text delta carries no evidence. Have the next sync capture the page,
        // or a page that keeps changing would refuse this action after every delta.
        if (state.baseline) state.baseline.held = undefined;
        throw new Error((revoked = "Page changed; synchronize before choosing an action"));
      }
      // Scrolling, focus or hover sent by this action can change text and
      // layout on their own; native input has not started, or verification
      // would not run. Read-only probes do not count.
      const prepared = preparationSent;
      const before = state.frames;
      let evidence: ObservationEvidence | undefined;
      await captureVomObservation(guardedRunner(cdp), state.tabId, target.url, {
        signal,
        accessibilityLease: state.accessibilityLease,
        skipRender: true,
        conditionalSurfaceProbe: false,
        onScene: (scene) => {
          evidence = observationEvidence(scene);
        },
      });
      await this.refresh(state);
      assert();
      // A refusal always requires a fresh sync; the refused context cannot retry.
      const consumeRefused = () => {
        if (targetPolicy) {
          context.consumed = true;
          checkFailure = actionError(
            "observation_changed",
            "The strict observation changed before this action",
            "observation",
            script
              ? SCRIPT_CHANGE_RECOVERY.target
              : "For data, use read/extract (fixed passive DOM queries) without another sync. For a visual action, synchronize and reconsider; use a DOM target with explicit expect facts when possible.",
            { observation_id: context.observationId },
          );
          return;
        }
        if (state.context !== context) return;
        state.context = undefined;
        this.changed(state);
      };
      if (!evidence) {
        consumeRefused();
        throw new Error(
          (revoked = "The action's observed content changed; synchronize and replan"),
        );
      }
      // Learned text is tolerated only around a resolved target present in both
      // observations, whose region can be protected. Untargeted actions never
      // learn text. Keys with explicit dependencies additionally protect their
      // actual focus; other untargeted actions keep the exact whole-page check.
      const anchored =
        actionTarget !== undefined &&
        observesTarget(context.evidence, actionTarget) &&
        observesTarget(evidence, actionTarget);
      const tolerant = !targetPolicy && anchored;
      const pages = documents(state.frames);
      const volatile =
        tolerant && state.volatile?.documents === pages ? state.volatile.keys : undefined;
      // Native focus/hover may add or remove an identified input decoration.
      // Keep all other decision evidence exact, especially explicit dependencies
      // and actions without a DOM target (including visual clicks).
      const decorations = prepared && anchored && !visual && policy.domTargeted;
      const preparation = { focus: preparationFocus, hover: preparationHover };
      const preparedEvidence = decorations
        ? preparationEvidence(context.evidence, evidence, actionTarget!, preparation)
        : undefined;
      type Check = {
        scope: "destination" | "keyboard" | "target" | "dependency" | "page";
        target?: EvidenceTarget;
        keys?: ReadonlySet<string>;
        incidentalMedia?: boolean;
      };
      const keyboardCheck = (): Check | undefined => {
        if (actionTarget) return;
        // A script has no implicit recipient: its declared regions are what
        // it relies on. Other untargeted actions keep the exact whole page.
        if (script) return;
        // Only keyboard input has an implicit recipient.
        if (req.method !== "tool.press") return { scope: "page" };
        const recipients = observedKeyboardTargets(context.evidence!);
        const current = observedKeyboardTargets(evidence!);
        const specificFrames = [...context.frames.values()].filter(
          (frame) => frame.focusIsDocument !== true,
        );
        if (!specificFrames.length && !recipients.length && !current.length) return;
        // A single, stable, observed recipient gets its own exact region. Missing
        // AX focus, hidden targets and ambiguous frame/shadow focus stay strict.
        if (
          specificFrames.length === 1 &&
          recipients.length === 1 &&
          current.length === 1 &&
          recipients[0].backendNodeId === current[0].backendNodeId &&
          recipients[0].frameId === current[0].frameId
        )
          return { scope: "keyboard", target: recipients[0] };
        return { scope: "page" };
      };
      // The target's own semantic region and every declared dependency stay
      // exact; sameObservationEvidence only relaxes broad layout around a target.
      const checks = (keys?: ReadonlySet<string>): Check[] => {
        // A drag decision also depends on its destination. Explicit dependencies
        // or learned live text must never relax the destination's own region.
        const list: Check[] = destinationTarget
          ? [{ scope: "destination", target: destinationTarget, keys }]
          : [];
        if (evidenceTargets) {
          const keyboard = keyboardCheck();
          if (keyboard) list.push(keyboard);
          if (actionTarget) list.push({ scope: "target", target: actionTarget, keys });
          for (const dependency of evidenceTargets)
            list.push({ scope: "dependency", target: dependency });
          return list;
        }
        if (anchored) list.push({ scope: "target", target: actionTarget, keys });
        // The target's region is checked above, so a positively identified
        // media timeline elsewhere may advance, as it may with dependencies.
        list.push({ scope: "page", keys, incidentalMedia: anchored });
        return list;
      };
      const comparison = (check: Check) =>
        preparedEvidence && (check.scope === "target" || check.scope === "page")
          ? preparedEvidence
          : ([context.evidence!, evidence!] as const);
      const failing = (keys?: ReadonlySet<string>) =>
        checks(keys).find(
          (check) =>
            !sameObservationEvidence(...comparison(check), check.target, check.keys, {
              incidentalMedia: check.incidentalMedia,
            }),
        );
      const matches = (keys?: ReadonlySet<string>) => !failing(keys);
      const refusal = failing(volatile);
      if (!refusal) {
        // Keep the pre-capture revision: later mutations must be checked again.
        verifiedFrames = before;
        return;
      }
      observed = {
        ...(observedChange(...comparison(refusal), refusal.target, refusal.keys, {
          incidentalMedia: refusal.incidentalMedia,
        }) ?? {}),
        scope: refusal.scope,
        phase: prepared ? "preparation" : "decision",
      };
      observedSummary = observedChanges(...comparison(refusal), refusal.target, refusal.keys, {
        incidentalMedia: refusal.incidentalMedia,
      });
      consumeRefused();
      // Learn page activity only from in-place text changes that every protected
      // region would tolerate, with no human input since the sync.
      const changes =
        tolerant && !prepared && sameFrames(context.frames, state.frames, "human")
          ? contentChanges(context.evidence, evidence, volatile)
          : undefined;
      const candidate =
        changes && new Set([...(volatile ?? []), ...changes.map((change) => change.key)]);
      const pending = state.learned?.documents === pages ? state.learned.keys : undefined;
      if (
        changes &&
        matches(candidate) &&
        (volatile?.size ?? 0) + (pending?.size ?? 0) + changes.length <= MAX_VOLATILE
      ) {
        // Learned keys stay inactive until the agent observes them in a new sync.
        state.learned = {
          documents: pages,
          keys: new Set([...(pending ?? []), ...changes.map((change) => change.key)]),
        };
        // One clock is several nodes (element, text, line box); report it once.
        const reported = [
          ...new Map(
            changes.map((change) => [`${change.before}\u0000${change.after}`, change]),
          ).values(),
        ];
        const [first] = reported;
        throw new Error(
          (revoked = `Page text changed by itself (${quote(first.before)} → ${quote(first.after)}${reported.length > 1 ? ` and ${reported.length - 1} more` : ""}); synchronize and replan. After that sync, further changes to that text no longer block actions on a ref or selector elsewhere. They still block actions whose target shares a form, list, dialog, panel or other container with it, and actions without a ref, selector or explicit dependencies. If the decision relies on that text, declare it with --depends-on to keep it exact`),
        );
      }
      throw new Error((revoked = "The action's observed content changed; synchronize and replan"));
    };
    const verifyDecision = async (requireFocus = false) => {
      if (unverified) {
        // Nothing about the page is compared. Control, the document and the
        // tab are still checked by assert() below and at dispatch.
      } else if (targeted) {
        // A script has no DOM recipient to check; its expect facts follow.
        for (const node of script ? [] : [actionTarget, destinationTarget]) {
          if (!node) continue;
          const error = await checkActionTarget(cdp, node, req.method, requireFocus);
          if (error) throw new ActionCheckError((checkFailure = error));
        }
      } else await verifyEvidence();
      const error = await checkExpectations(cdp, session, target, expectations);
      if (error) throw new ActionCheckError((checkFailure = error));
      assert();
    };
    // Resolve selectors once per action. Handlers use the same concrete DOM node
    // that passed the checks, even if a list reorders during preparation.
    const pin = (node: ResolvedActionTarget) => {
      const identity = {
        tabId: target.tabId,
        backendNodeId: node.backendNodeId,
        frameId: node.frameId,
        cdpSessionId: node.cdpTarget.sessionId,
      };
      const ref = session.refStore.allocateRef(identity);
      session.refStore.set(ref, node.backendNodeId, identity);
      return ref;
    };
    const primaryEffect = (method: string) =>
      (req.method === "tool.focus" && method === "DOM.focus") ||
      (req.method === "tool.blur" && method === "Runtime.callFunctionOn") ||
      (req.method === "tool.hover" && method === "Input.dispatchMouseEvent") ||
      (req.method === "tool.scroll_to" && method === "DOM.scrollIntoViewIfNeeded");
    const targetError = (error: RpcError): RpcError =>
      targetPolicy
        ? {
            ...error,
            data: {
              ...error.data,
              reason: error.data?.reason ?? "target_unavailable",
              phase: "target",
              effect_state: "none",
              recovery:
                error.data?.recovery ??
                "Observe the current page and choose a target again. Nothing was sent.",
            },
          }
        : error;
    let fallbackBootstrap = false;
    try {
      await this.refresh(state);
      assert();
      if (!mainDocumentAction) {
        await cdp.reconcileSoftDetachedFrames?.(state.tabId);
        assert();
      }
      if (
        !context ||
        !state.context ||
        params.context_id !== state.context.id ||
        context.epoch !== state.epoch ||
        (!targetPolicy && !unverified && context.refs !== session.refStore.revision)
      )
        return targetPolicy
          ? reportFailure("This action requires a valid control context from cooperate sync")
          : failure("This action requires the context returned by the latest cooperate sync");
      if (
        targetPolicy &&
        !targeted &&
        (params.observation_id !== context.observationId || context.consumed)
      )
        return actionError(
          "observation_required",
          "This action requires an unused strict observation from cooperate sync",
          "observation",
          script
            ? "Synchronize, inspect the result and pass the sync reply's top-level observation_id, not observation.observation_id, explicitly with --observation (plugin: observationId). On a page that keeps changing, state what the script relies on with explicit expect checks and omit observation_id: then only they are checked."
            : "Synchronize, inspect the result and pass the sync reply's top-level observation_id, not observation.observation_id, explicitly with --observation (plugin: observationId).",
        );
      if (!visual && (primaryTarget?.ref || primaryTarget?.selector)) {
        const resolved = await resolveActionTarget(
          guardedRunner(cdp),
          session,
          target,
          primaryTarget,
          "shared action",
          targetPolicy || req.method === "tool.drag",
        );
        if (isRpcError(resolved)) return targetError(resolved);
        actionTarget = resolved;
        if (targeted && primaryTarget.selector) {
          const pinned = { ...primaryTarget, ref: pin(resolved), selector: undefined };
          req.params =
            req.method === "tool.drag"
              ? { ...(req.params as object), source: pinned }
              : { ...(req.params as object), ...pinned };
        }
      }
      if (req.method === "tool.drag" && (params.target?.ref || params.target?.selector)) {
        const resolved = await resolveActionTarget(
          guardedRunner(cdp),
          session,
          target,
          params.target,
          "drag destination",
          true,
        );
        if (isRpcError(resolved)) return targetError(resolved);
        destinationTarget = resolved;
        if (targeted && params.target?.selector)
          req.params = {
            ...(req.params as object),
            target: { ...params.target, ref: pin(resolved), selector: undefined },
          };
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
        if (params.depends_on.length) {
          // Dependencies constrain the decision even when a key has no target.
          // Keep them separate from the target so learned text never relaxes them.
          evidenceTargets = [];
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
      }
      // Wait only before execution, and only for transient element readiness.
      // Business facts, missing nodes and ambiguous selectors fail immediately.
      const deadline = Date.now() + (params.timeout_ms ?? 30_000);
      while (true) {
        try {
          await verifyDecision();
          break;
        } catch (error) {
          if (
            !targeted ||
            !(error instanceof ActionCheckError) ||
            !["target_hidden", "target_disabled", "target_readonly"].includes(
              error.rpcError.data?.reason ?? "",
            )
          )
            throw error;
          if (Date.now() >= deadline) {
            checkFailure = { ...error.rpcError, code: "timeout" };
            throw new ActionCheckError(checkFailure);
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
          // Push events revoke control while waiting. The dispatch guard still
          // refreshes every frame before any effect, including missed events.
          checkFailure = undefined;
          assert();
        }
      }
      if (targeted && params.timeout_ms !== undefined)
        req.params = { ...(req.params as object), timeout_ms: Math.max(1, deadline - Date.now()) };
      if (!targetPolicy) state.context = undefined;
      else if (!targeted) context.consumed = true;
      this.changed(state);
      let result = await invoke(
        guardedRunner(cdp, {
          onInputClockError: (error) => {
            checkFailure = error.toRpcError();
          },
          scriptedEffect: req.method === "tool.evaluate",
          prepare: async (input, method) => {
            assert();
            if (targeted && isInternalActionStep(input, method, req.method === "tool.evaluate")) {
              return;
            }
            await this.prepareFrames(state, operationSignal, input, method, deadline);
            assert();
            if (
              input?.type === "pointerdown" &&
              Number.isFinite(input.x) &&
              Number.isFinite(input.y)
            ) {
              state.target = { x: input.x!, y: input.y!, expires: this.now() + 650 };
              this.changed(state);
            }
            if (!nativeInputStarted) {
              if (!targeted) {
                await verifyDecision(false);
              } else if (req.method === "tool.press" && input?.type === "keydown") {
                await verifyDecision(true);
              }
            }
          },
          finishInput: async (input) => {
            // Retire only this command's one-shot text expectation. A late
            // acknowledgement must not clear another action's expectation.
            const clear = this.deps
              .readFrames(
                state.tabId,
                { type: "clear", id: input.id },
                state.lease,
                state.frameRepairs,
                state.hiddenFrames,
              )
              .catch(() => {});
            if (!session.agentCreatedTabs.has(state.tabId) || state.intervened || state.held) {
              await clear;
            }
          },
          dispatch: (startsInput, method) => {
            assert();
            sent = true;
            if (!startsInput && PREPARATION_METHODS.has(method)) {
              preparationSent = true;
              preparationFocus ||= method === "DOM.focus";
              preparationHover ||= method === "Input.dispatchMouseEvent";
            }
            nativeInputStarted ||= startsInput || (targeted && primaryEffect(method));
          },
          verifyPointerTarget: async (node, point, offset) => {
            try {
              await pointerTargetValidator(cdp)(node, point, offset);
            } catch (error) {
              revoked = error instanceof Error ? error.message : String(error);
              if (error instanceof ActionCheckError) checkFailure = error.rpcError;
              throw error;
            }
          },
          beginDomMutation: async () => {
            if (targeted) {
              assert();
              nativeInputStarted = true;
              return;
            }
            await this.refresh(state);
            assert();
            if (!nativeInputStarted) await verifyDecision();
            nativeInputStarted = true;
          },
          detach: cdp.detach
            ? async (tabId, expectedAttachmentId) => {
                const intact =
                  tabId === state.tabId &&
                  !state.unavailable &&
                  state.epoch === epoch &&
                  !detachedByHandler;
                await cdp.detach!(tabId, expectedAttachmentId);
                if (intact && state.epoch <= epoch + 1) {
                  // Handler cleanup detaches the debugger to fence uncertain CDP
                  // state, which triggers onDocumentChanged -> invalidate(tabId).
                  // Revoke the control context for subsequent actions without masking
                  // the handler's own failure receipt on an otherwise intact page.
                  detachedByHandler = true;
                  if (state.epoch === epoch) state.epoch++;
                  state.context = undefined;
                  state.learned = undefined;
                  epoch = state.epoch;
                  state.unavailable = false;
                  this.changed(state);
                }
              }
            : undefined,
        }),
        operationSignal,
        completionSignal,
      );
      // Pinning preserves the chosen node; the receipt also preserves how the
      // caller selected it. This applies to download's early return as well.
      if (
        targeted &&
        params.selector &&
        result &&
        typeof result === "object" &&
        !isRpcError(result)
      )
        result = { ...result, used_selector: params.selector };
      // A completed download transfers cleanup ownership to the daemon. Keep its
      // receipt even if control changed during final cleanup; dropping it would
      // orphan the file. The consumed context still requires a fresh next step.
      if (["tool.tab_close", "tool.download"].includes(req.method) && !isRpcError(result))
        return result;
      // A handler receipt describes completed input, independently of whether its
      // document can authorize the next action. evaluate reports script exceptions
      // in-band; a successfully evaluated false value is still a completed script.
      const completed =
        sent &&
        !isRpcError(result) &&
        (req.method !== "tool.evaluate" || (result as { ok?: boolean })?.ok === true);
      if (["tool.evaluate", "tool.upload"].includes(req.method)) {
        const intact = !state.unavailable && state.epoch === epoch;
        try {
          await this.refresh(state);
        } catch (error) {
          if (!completed && !(isRpcError(result) && intact)) throw error;
          // A new frame may not yet expose its collector. Retain the completed
          // receipt (or the handler's own refusal), but require a fresh sync
          // before any further page action.
          this.invalidate(state.tabId);
          if (isRpcError(result) && intact) postRefreshFailed = true;
        }
      }
      // Even a successful CDP reply does not authorize a stale next step.
      if (state.stopped) return stopped(sent ? "unknown" : "none");
      if (signal.aborted) {
        if (targetPolicy && sent) state.context = undefined;
        return {
          code: "cancelled",
          message: "Shared-tab action cancelled",
          data: {
            effect_state: sent ? "unknown" : "none",
            phase: sent ? "execution" : "precondition",
          },
        };
      }
      const reason =
        revoked ??
        interruption(completed || postRefreshFailed) ??
        (!completed && !isRpcError(result) && detachedByHandler
          ? "The observed page or control state changed; synchronize"
          : undefined);
      if (checkFailure || reason)
        return reportFailure(checkFailure?.message ?? reason!, sent ? "unknown" : "none");
      if (targetPolicy && isRpcError(result)) {
        const effect = result.data?.effect_state ?? (sent ? "unknown" : "none");
        if (effect === "unknown" || detachedByHandler || postRefreshFailed)
          state.context = undefined;
        return {
          ...result,
          data: {
            ...result.data,
            effect_state: effect,
            ...unpressed(effect),
            phase: result.data?.phase ?? "execution",
            recovery:
              result.data?.recovery ??
              (effect === "unknown"
                ? "Inspect the application result and synchronize before choosing another action. Never replay an uncertain submission."
                : "Inspect the reported target or parameter before choosing another action."),
          },
        };
      }
      return result;
    } catch (error) {
      if (state.stopped) return stopped(sent ? "unknown" : "none");
      if (signal.aborted) {
        if (targetPolicy && sent) state.context = undefined;
        return {
          code: "cancelled",
          message: "Shared-tab action cancelled",
          data: {
            effect_state: sent ? "unknown" : "none",
            phase: sent ? "execution" : "precondition",
          },
        };
      }
      if (
        !sent &&
        policy.bootstrapAllowed &&
        !params.context_id &&
        (await this.unobservableBlank(state, error))
      ) {
        if (state.stopped) return stopped("none");
        if (signal.aborted)
          return {
            code: "cancelled",
            message: "Shared-tab action cancelled",
            data: { effect_state: "none", phase: "precondition" },
          };
        if (
          params.expect !== undefined ||
          params.observation_id !== undefined ||
          params.depends_on?.length
        )
          return {
            code: "invalid_params",
            message:
              "The initial blank tab has no observed content; omit expect, observation_id and depends_on or synchronize first",
            data: { phase: "precondition", effect_state: "none" },
          };
        fallbackBootstrap = true;
      } else {
        if (error instanceof ActionCheckError) checkFailure = error.rpcError;
        if (error instanceof FrameCollectionError)
          return error.toRpcError(sent ? "unknown" : "none");
        return reportFailure(
          error instanceof Error ? error.message : String(error),
          sent ? "unknown" : "none",
        );
      }
    } finally {
      finished = true;
      if (sent && req.method === "tool.window_resize")
        this.clearWindowObservations(state.sessionId);
      if (sent) state.lastAgentActivity = this.now();
      if (state.interruption === intervention) state.interruption = undefined;
      if (state.completion === completion) state.completion = undefined;
      state.working = false;
      this.changed(state);
    }
    return fallbackBootstrap
      ? this.bootstrap(state, req.method, cdp, signal, invoke, epoch)
      : undefined;
  }
}
