// `tool.record_start` / `tool.record_stop` / `tool.record_await` — capture
// user actions in the Agent Window via the content script and return a
// semantic (LLM textbook) trace.

import {
  isRecordFinishMessage,
  isRecordQueryMessage,
  isRecordStepMessage,
  RECORD_CANCEL,
  RECORD_START,
  RECORD_STEP,
  RECORD_STOP,
  type RecordCancelMessage,
  type RecordFinishMessage,
  type RecordQueryResponse,
  type RecordStartAck,
  type RecordStartMessage,
  type RecordStepAck,
  type RecordStopMessage,
} from "@/lib/record-bridge";
import { RecordingObservationRuntime } from "@/lib/recording/recording-runtime";
import {
  appendRecordedPayload,
  observeRecordedNavigation,
  type RecordingStepBuffer,
} from "@/lib/recording/step-buffer";
import { RecordingTabCoordinator, type TabActivation } from "@/lib/recording/tab-coordinator";
import { buildTraceV2 } from "@/lib/recording/trace-reducer-v2";
import type { RecordingDraftStep } from "@/lib/recording/types";
import type { SessionManager } from "@/session-manager/manager";
import { EXTENSION_VERSION } from "@/transport/handshake";
import type {
  RecordAwaitParams,
  RecordAwaitResult,
  RecordedTrace,
  RecordStartParams,
  RecordStartResult,
  RecordStopParams,
  RecordStopResult,
  RpcError,
  StopReason,
} from "@/transport/types";
import { TRACE_VERSION_V3 } from "@/transport/types";
import { handleNavigate } from "./navigation";
import {
  type CdpRunner,
  type ChromeTabsApi,
  chromeTabsApi,
  isRpcError,
  lookupSession,
  resolveTargetTab,
} from "./shared";

interface ActiveRecording {
  requestId: string;
  tabs: RecordingTabCoordinator;
  agentWindowId: number;
  startUrl?: string;
  purpose?: string;
  steps: RecordingDraftStep[];
  startedAt: string;
  startedAtMs: number;
  traceVersion: 2 | 3;
  supportsTabSwitchSteps: boolean;
  finishPromise: Promise<RecordedTrace>;
  resolveFinish: (trace: RecordedTrace) => void;
  rejectFinish: (err: Error) => void;
  settled: boolean;
  finishAttempt: Promise<RecordedTrace | null> | null;
  observation: RecordingObservationRuntime | null;
  stoppedBy: StopReason;
  /** Navigation callbacks tracked from event receipt through action enqueue. */
  navigationCallbacks: Set<Promise<void>>;
  /** Synchronous intake gate closed only after finish drains to stability. */
  acceptingNavigation: boolean;
  /**
   * Serializes step appends with navigation observation so a click is always
   * in `steps` before a same-turn `webNavigation` tries to annotate it.
   */
  actionQueue: Promise<void>;
  /** Last accepted sequence for each content-script document producer. */
  lastStepSequenceByProducer: Map<string, number>;
}

function enqueueRecordingAction(
  recording: ActiveRecording,
  task: () => Promise<void>,
): Promise<void> {
  const queued = recording.actionQueue.then(task, task);
  recording.actionQueue = queued.catch(() => {});
  return queued;
}

const recordings = new Map<string, ActiveRecording>();

const RECORD_START_RETRIES = 3;
const RECORD_START_RETRY_DELAY_MS = 500;
const RECORD_REARM_DEBOUNCE_MS = 150;
const RECORD_REARM_MAX_ATTEMPTS = 12;
const RECORD_REARM_RETRY_DELAY_MS = 400;

const rearmTimers = new Map<number, ReturnType<typeof setTimeout>>();

function makeRequestId(tabId: number): string {
  return `rec-${tabId}-${Date.now().toString(36)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Recording producer version mirrored into trace.recorder.bsk. */
export const BSK_TRACE_VERSION = EXTENSION_VERSION;

/** Injectable http(s) landing page when `tool.record_start` omits `url`. */
export const RECORD_DEFAULT_START_URL = "https://example.com/";

/** Pages where MV3 content scripts cannot attach (Agent Window boots here). */
function isContentScriptRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();
  return (
    lower === "about:blank" ||
    lower.startsWith("about:") ||
    lower.startsWith("chrome://") ||
    lower.startsWith("chrome-extension://") ||
    lower.startsWith("edge://") ||
    lower.startsWith("devtools://") ||
    lower.startsWith("devtools:") ||
    lower.startsWith("https://chrome.google.com/webstore")
  );
}

async function waitForTabReady(
  tabId: number,
  tabsApi: ChromeTabsApi,
  timeoutMs = 10_000,
): Promise<void> {
  try {
    const tab = await tabsApi.get(tabId);
    if (tab.status === "complete") return;
  } catch {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("tab load timeout"));
    }, timeoutMs);
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId || info.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function isRecordStartAck(response: unknown): response is RecordStartAck {
  return (
    typeof response === "object" &&
    response !== null &&
    "ok" in response &&
    (response as RecordStartAck).ok === true
  );
}

async function sendRecordStartWithAck(
  tabId: number,
  msg: RecordStartMessage,
  sendToTab: RecordDeps["sendToTab"],
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RECORD_START_RETRIES; attempt += 1) {
    try {
      const response = await sendToTab(tabId, msg);
      if (isRecordStartAck(response)) return;
      lastError = new Error("content script did not ack RECORD_START");
    } catch (err) {
      lastError = err;
    }
    if (attempt + 1 < RECORD_START_RETRIES) {
      await sleep(RECORD_START_RETRY_DELAY_MS);
    }
  }
  throw lastError ?? new Error("failed to start recording in content script");
}

function negotiatedTraceVersion(params: RecordStartParams): 2 | 3 | RpcError {
  if (params.trace_version === undefined) return 2;
  if (params.trace_version === TRACE_VERSION_V3) return 3;
  return {
    code: "invalid_params",
    message: `unsupported trace_version ${params.trace_version}; supported values are omitted (v2) or ${TRACE_VERSION_V3} (v3)`,
  };
}

function buildTrace(recording: ActiveRecording): RecordedTrace {
  if (recording.traceVersion === 3 && recording.observation) {
    return recording.observation.buildTrace({
      drafts: recording.steps,
      startedAt: recording.startedAt,
      purpose: recording.purpose,
      startUrl: recording.startUrl,
      stoppedBy: recording.stoppedBy,
      bskVersion: BSK_TRACE_VERSION,
      includeTabSwitches: recording.supportsTabSwitchSteps,
    });
  }
  if (recording.traceVersion === 3) {
    throw new Error("trace v3 observation runtime is unavailable");
  }
  return buildTraceV2({
    steps: recording.steps,
    startedAt: recording.startedAt,
    ...(recording.startUrl ? { startUrl: recording.startUrl } : {}),
    ...(recording.purpose ? { purpose: recording.purpose } : {}),
  });
}

function stepBufferFor(
  recording: ActiveRecording,
  tabId: number,
  fallbackUrl?: string,
): RecordingStepBuffer {
  return {
    steps: recording.steps,
    navigation: recording.tabs.navigation(tabId, fallbackUrl),
  };
}

async function activateRecordingTab(
  recording: ActiveRecording,
  targetTabId: number,
): Promise<void> {
  const previousTabId = recording.tabs.currentTabId;
  if (targetTabId === previousTabId) return;

  const transition = recording.observation
    ? await recording.observation.captureTabTransition(previousTabId, targetTabId)
    : {};
  const { targetUrl, ...stateLinks } = transition;
  const draft: Extract<RecordingDraftStep, { op: "switch_tab" }> = {
    op: "switch_tab",
    ...stateLinks,
  };
  recording.steps.push(draft);
  recording.observation?.bindTabTransition(draft, recording.steps.length);
  recording.tabs.navigation(targetTabId, targetUrl);
  recording.tabs.commit(targetTabId);
}

async function processRecordedStep(
  recording: ActiveRecording,
  draftIndex: number,
  tabId: number,
): Promise<void> {
  if (!recording.observation) return;
  try {
    await recording.observation.processDraft(tabId, recording.steps, draftIndex);
  } catch (err) {
    console.warn(`[bsk record] observation failed for step ${draftIndex + 1}`, err);
  }
}

export interface RecordDeps {
  tabsApi: ChromeTabsApi;
  sendToTab(
    tabId: number,
    msg: RecordStartMessage | RecordStopMessage | RecordCancelMessage,
  ): Promise<unknown>;
  bypassOverlay?: (tabId: number, enabled: boolean) => Promise<void>;
  cdp?: CdpRunner;
  signal?: AbortSignal;
}

let defaultDeps: RecordDeps | null = null;
function getDefaultDeps(): RecordDeps {
  if (!defaultDeps) {
    defaultDeps = {
      tabsApi: chromeTabsApi,
      sendToTab: (tabId, msg) => chrome.tabs.sendMessage(tabId, msg),
    };
  }
  return defaultDeps;
}

/** Disposer for lazily attached tab / webNavigation observers. */
let detachBrowserObservation: (() => void) | null = null;

type AttachObservation = (deps: RecordDeps) => () => void;

// Deferred wrappers so we do not capture attach* before their declarations.
let attachTabObservation: AttachObservation = (deps) => attachRecordTabListener(deps);
let attachNavObservation: AttachObservation = (deps) => attachRecordNavigationListener(deps);

/** Test seam: swap real chrome listeners for fakes. */
export function setBrowserObservationAttachForTests(
  tab: AttachObservation | null,
  nav: AttachObservation | null,
): void {
  attachTabObservation = tab ?? ((deps) => attachRecordTabListener(deps));
  attachNavObservation = nav ?? ((deps) => attachRecordNavigationListener(deps));
}

export function isBrowserObservationAttachedForTests(): boolean {
  return detachBrowserObservation !== null;
}

export function resetBrowserObservationForTests(): void {
  detachBrowserObservation?.();
  detachBrowserObservation = null;
  recordings.clear();
  attachTabObservation = (deps) => attachRecordTabListener(deps);
  attachNavObservation = (deps) => attachRecordNavigationListener(deps);
}

/**
 * Attach tab/webNavigation listeners while any recording is active.
 * Must run before navigate-on-start so rearm observes the destination load.
 */
export function ensureBrowserObservationListeners(deps: RecordDeps = getDefaultDeps()): void {
  if (detachBrowserObservation) return;
  const detachTab = attachTabObservation(deps);
  const detachNav = attachNavObservation(deps);
  detachBrowserObservation = () => {
    detachTab();
    detachNav();
  };
}

/** Detach when the recordings map is empty. */
export function releaseBrowserObservationListenersIfIdle(): void {
  if (recordings.size > 0) return;
  if (!detachBrowserObservation) return;
  detachBrowserObservation();
  detachBrowserObservation = null;
}

export function attachRecordStepListener(deps: RecordDeps = getDefaultDeps()): () => void {
  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: RecordStepAck) => void,
  ) => {
    if (!isRecordStepMessage(message)) return false;
    for (const recording of recordings.values()) {
      if (recording.requestId !== message.requestId) continue;
      const sourceTabId = sender.tab?.id ?? recording.tabs.currentTabId;
      const sourceWasActive = sender.tab?.active ?? sourceTabId === recording.tabs.activeTabId;
      const producerKey = `${sourceTabId}:${message.producerId}`;
      const expectedSequence = (recording.lastStepSequenceByProducer.get(producerKey) ?? 0) + 1;
      if (message.sequence < expectedSequence) {
        sendResponse({ ok: true, sequence: message.sequence });
        return false;
      }
      if (message.sequence > expectedSequence) {
        sendResponse({
          ok: false,
          expectedSequence,
          error: `out-of-order recorded step ${message.sequence}`,
        });
        return false;
      }

      recording.lastStepSequenceByProducer.set(producerKey, message.sequence);
      enqueueRecordingAction(recording, async () => {
        if (sourceTabId !== recording.tabs.currentTabId) {
          if (!sourceWasActive) return;
          if (sourceTabId !== recording.tabs.activeTabId)
            recording.tabs.noteActivation(sourceTabId);
          await activateRecordingTab(recording, sourceTabId);
        }
        await recording.observation?.flushRedirects(sourceTabId);
        const targetHint = message.step.geometry ? { geometry: message.step.geometry } : undefined;
        const draftIndex = appendRecordedPayload(
          stepBufferFor(recording, sourceTabId, message.step.page_url),
          message.step,
          targetHint,
        );
        if (draftIndex !== null) {
          await processRecordedStep(recording, draftIndex, sourceTabId);
        }
      });
      sendResponse({ ok: true, sequence: message.sequence });
      return false;
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

export function attachRecordFinishListener(deps: RecordDeps = getDefaultDeps()): () => void {
  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    _sendResponse: () => void,
  ) => {
    if (!isRecordFinishMessage(message)) return false;
    const tabId = sender.tab?.id;
    if (tabId === undefined) return false;
    void finishRecordingByRequest(message.requestId, tabId, deps);
    return false;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

function findRecordingByTabId(tabId: number): ActiveRecording | null {
  for (const recording of recordings.values()) {
    if (recording.tabs.currentTabId === tabId && !recording.settled) return recording;
  }
  return null;
}

async function findRecordingForTab(
  tabId: number,
  deps: RecordDeps,
): Promise<ActiveRecording | null> {
  const direct = findRecordingByTabId(tabId);
  if (direct) return direct;

  try {
    const tab = await deps.tabsApi.get(tabId);
    const windowId = tab.windowId;
    if (typeof windowId !== "number") return null;
    for (const recording of recordings.values()) {
      if (!recording.settled && recording.agentWindowId === windowId) return recording;
    }
  } catch {
    return null;
  }
  return null;
}

function clearRearmTimer(tabId: number): void {
  const timer = rearmTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    rearmTimers.delete(tabId);
  }
}

async function clearRearmTimersForRecording(
  recording: ActiveRecording,
  deps: RecordDeps,
): Promise<void> {
  clearRearmTimer(recording.tabs.currentTabId);
  try {
    const tabs = await deps.tabsApi.query({ windowId: recording.agentWindowId });
    for (const tab of tabs) {
      if (typeof tab.id === "number") clearRearmTimer(tab.id);
    }
  } catch {
    // Best-effort cleanup.
  }
}

async function stopRecordingOnAllAgentTabs(
  recording: ActiveRecording,
  deps: RecordDeps,
): Promise<void> {
  const stopMsg: RecordStopMessage = { type: RECORD_STOP, requestId: recording.requestId };
  let tabIds = [recording.tabs.currentTabId];
  try {
    const tabs = await deps.tabsApi.query({ windowId: recording.agentWindowId });
    tabIds = [
      ...new Set([
        recording.tabs.currentTabId,
        ...tabs.flatMap((tab) => (typeof tab.id === "number" ? [tab.id] : [])),
      ]),
    ];
  } catch {
    // Fall back to the current recording tab.
  }

  for (const tabId of tabIds) {
    try {
      const response = await deps.sendToTab(tabId, stopMsg);
      if (tabId === recording.tabs.currentTabId && !isRecordStartAck(response)) {
        throw new Error("content script did not confirm recorded steps");
      }
    } catch {
      if (tabId === recording.tabs.currentTabId) {
        throw new Error("failed to flush recorded steps");
      }
    }
    if (deps.bypassOverlay) {
      try {
        await deps.bypassOverlay(tabId, false);
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}

async function rearmRecording(
  recording: ActiveRecording,
  targetTabId: number,
  deps: RecordDeps,
  activation?: TabActivation,
): Promise<boolean> {
  // Do NOT toggle automation-bypass here: each retry used to increment the
  // content-script counter, and a single stop decrement left the ControlOverlay
  // stuck with pointer-events:none (page usable, Interrupt dead). RecordOverlay
  // already hides the control chrome while activeRecord is set.
  for (let attempt = 0; attempt < RECORD_REARM_MAX_ATTEMPTS; attempt += 1) {
    const startMsg: RecordStartMessage = {
      type: RECORD_START,
      requestId: recording.requestId,
      startedAtMs: recording.startedAtMs,
    };
    try {
      await sendRecordStartWithAck(targetTabId, startMsg, deps.sendToTab);
      if (activation) {
        if (!recording.tabs.isLatest(activation)) return true;
        await enqueueRecordingAction(recording, () => activateRecordingTab(recording, targetTabId));
      }
      return true;
    } catch {
      if (attempt + 1 < RECORD_REARM_MAX_ATTEMPTS) {
        await sleep(RECORD_REARM_RETRY_DELAY_MS);
      }
    }
  }
  return false;
}

function scheduleRearmForTab(tabId: number, deps: RecordDeps, activation?: TabActivation): void {
  const existing = rearmTimers.get(tabId);
  if (existing) clearTimeout(existing);
  rearmTimers.set(
    tabId,
    setTimeout(() => {
      rearmTimers.delete(tabId);
      void (async () => {
        const current = await findRecordingForTab(tabId, deps);
        if (current) await rearmRecording(current, tabId, deps, activation);
      })();
    }, RECORD_REARM_DEBOUNCE_MS),
  );
}

export function attachRecordTabListener(deps: RecordDeps = getDefaultDeps()): () => void {
  const onCreated = (tab: chrome.tabs.Tab) => {
    const tabId = tab.id;
    const windowId = tab.windowId;
    if (tabId === undefined || windowId === undefined) return;
    for (const recording of recordings.values()) {
      if (recording.settled || recording.agentWindowId !== windowId) continue;
      scheduleRearmForTab(tabId, deps);
      return;
    }
  };

  const onActivated = (activeInfo: chrome.tabs.TabActiveInfo) => {
    for (const recording of recordings.values()) {
      if (recording.settled || recording.agentWindowId !== activeInfo.windowId) continue;
      const activation = recording.tabs.noteActivation(activeInfo.tabId);
      scheduleRearmForTab(activeInfo.tabId, deps, activation);
      return;
    }
  };

  chrome.tabs.onCreated.addListener(onCreated);
  chrome.tabs.onActivated.addListener(onActivated);
  return () => {
    chrome.tabs.onCreated.removeListener(onCreated);
    chrome.tabs.onActivated.removeListener(onActivated);
  };
}

export function attachRecordNavigationListener(deps: RecordDeps = getDefaultDeps()): () => void {
  const observeMainFrame = (
    tabId: number,
    url?: string,
    causedByAction?: boolean,
    transitionType?: string,
    transitionQualifiers?: string[],
  ) => {
    if (!url) return;
    const candidates = [...recordings.values()].filter(
      (recording) =>
        !recording.settled && recording.acceptingNavigation && recording.tabs.activeTabId === tabId,
    );
    for (const recording of candidates) {
      const queued = enqueueRecordingAction(recording, async () => {
        if (tabId !== recording.tabs.currentTabId) {
          await activateRecordingTab(recording, tabId);
        }
        const result = observeRecordedNavigation(
          stepBufferFor(recording, tabId, url),
          url,
          causedByAction,
          transitionType,
          transitionQualifiers,
        );
        if (result.kind === "coalesce_redirect") {
          recording.observation?.scheduleRedirect(tabId, recording.steps, result.url);
          return;
        }

        if (result.kind === "noop") return;
        recording.observation?.clearRedirect(tabId);
        if (result.kind === "appended") {
          await processRecordedStep(recording, result.index, tabId);
        } else {
          recording.observation?.scheduleSettle(tabId, recording.steps, result.index);
        }
      });
      const tracked = queued.catch(() => {});
      recording.navigationCallbacks.add(tracked);
      void tracked.finally(() => recording.navigationCallbacks.delete(tracked));
    }
  };
  const onMainFrameComplete = (tabId: number, url?: string) => {
    void (async () => {
      observeMainFrame(tabId, url);
      scheduleRearmForTab(tabId, deps);
    })();
  };

  if (chrome.webNavigation?.onCompleted) {
    const completedListener = (
      details: chrome.webNavigation.WebNavigationFramedCallbackDetails,
    ) => {
      if (details.frameId !== 0) return;
      onMainFrameComplete(details.tabId, details.url);
    };
    const committedListener = (
      details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
    ) => {
      if (details.frameId !== 0) return;
      observeMainFrame(
        details.tabId,
        details.url,
        undefined,
        details.transitionType,
        details.transitionQualifiers,
      );
    };
    chrome.webNavigation.onCompleted.addListener(completedListener);
    chrome.webNavigation.onCommitted?.addListener(committedListener);
    return () => {
      chrome.webNavigation.onCompleted.removeListener(completedListener);
      chrome.webNavigation.onCommitted?.removeListener(committedListener);
    };
  }

  const listener = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
    if (info.status !== "complete") return;
    onMainFrameComplete(tabId, info.url);
  };
  chrome.tabs.onUpdated.addListener(listener);
  return () => chrome.tabs.onUpdated.removeListener(listener);
}

const MAX_FINISH_DRAIN_ROUNDS = 10;

async function drainRecordingToStability(recording: ActiveRecording): Promise<boolean> {
  for (let round = 0; round < MAX_FINISH_DRAIN_ROUNDS; round += 1) {
    await Promise.all([...recording.navigationCallbacks]);
    const actionTail = recording.actionQueue;
    await actionTail;
    await recording.observation?.flush();

    if (recording.navigationCallbacks.size === 0 && recording.actionQueue === actionTail) {
      // No event or promise continuation can interleave with this synchronous
      // check-and-close, so work accepted before the cutoff is fully drained.
      recording.acceptingNavigation = false;
      return true;
    }
  }
  console.warn("[bsk record] navigation/action queues did not stabilize at stop");
  return false;
}

export function attachRecordQueryListener(deps: RecordDeps = getDefaultDeps()): () => void {
  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: RecordQueryResponse) => void,
  ) => {
    if (!isRecordQueryMessage(message)) return false;
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({ active: false });
      return false;
    }
    void (async () => {
      const recording = await findRecordingForTab(tabId, deps);
      if (!recording) {
        sendResponse({ active: false });
        return;
      }
      const activation = sender.tab?.active ? recording.tabs.noteActivation(tabId) : undefined;
      await rearmRecording(recording, tabId, deps, activation);
      sendResponse({
        active: true,
        requestId: recording.requestId,
        startedAtMs: recording.startedAtMs,
      });
    })();
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

async function finishRecordingByRequest(
  requestId: string,
  tabId: number,
  deps: RecordDeps,
): Promise<void> {
  for (const [sessionId, recording] of recordings) {
    if (recording.requestId !== requestId || recording.settled) continue;
    const match = await findRecordingForTab(tabId, deps);
    if (match !== recording) continue;
    await finishRecording(sessionId, deps, "user_finish");
    return;
  }
}

async function finishRecording(
  sessionId: string,
  deps: RecordDeps,
  stoppedBy: StopReason,
): Promise<RecordedTrace | null> {
  const recording = recordings.get(sessionId);
  if (!recording || recording.settled) return null;
  if (recording.finishAttempt) return recording.finishAttempt;
  recording.stoppedBy = stoppedBy;

  const attempt = finishRecordingAttempt(sessionId, recording, deps);
  recording.finishAttempt = attempt;
  try {
    return await attempt;
  } finally {
    if (!recording.settled) {
      recording.finishAttempt = null;
    }
  }
}

async function finishRecordingAttempt(
  sessionId: string,
  recording: ActiveRecording,
  deps: RecordDeps,
): Promise<RecordedTrace | null> {
  await clearRearmTimersForRecording(recording, deps);
  try {
    // Disposing content capture may commit a final dirty fill. Flush content
    // first so all resulting RECORD_STEP messages enter actionQueue before it
    // and the observation queues are drained.
    await stopRecordingOnAllAgentTabs(recording, deps);
  } catch {
    return null;
  }
  if (!(await drainRecordingToStability(recording))) {
    return null;
  }
  await recording.observation?.settleTrailing(recording.tabs.currentTabId, recording.steps);

  recording.settled = true;
  recordings.delete(sessionId);
  releaseBrowserObservationListenersIfIdle();
  const trace = buildTrace(recording);
  recording.resolveFinish(trace);
  return trace;
}

export async function handleRecordStart(
  manager: SessionManager,
  params: RecordStartParams,
  deps: RecordDeps = getDefaultDeps(),
): Promise<RecordStartResult | RpcError> {
  const traceVersionOrErr = negotiatedTraceVersion(params);
  if (typeof traceVersionOrErr !== "number") return traceVersionOrErr;
  if (traceVersionOrErr === 3 && !deps.cdp) {
    return {
      code: "protocol_error",
      message: "trace v3 recording requires an active CDP connection",
    };
  }

  const ctxOrErr = lookupSession(manager, params, "record_start");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  if (recordings.has(params.session_id)) {
    return {
      code: "protocol_error",
      message: `session ${params.session_id} is already recording`,
    };
  }
  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;

  // Register the recording *before* navigate so content-script syncAgentOverlay
  // on the destination page can RECORD_QUERY → rearm → show RecordOverlay
  // instead of flashing ControlOverlay ("Agent 正在控制").
  const requestId = makeRequestId(target.tabId);
  let resolveFinish!: (trace: RecordedTrace) => void;
  let rejectFinish!: (err: Error) => void;
  const finishPromise = new Promise<RecordedTrace>((resolve, reject) => {
    resolveFinish = resolve;
    rejectFinish = reject;
  });
  const navigateUrl = params.url ?? RECORD_DEFAULT_START_URL;
  const startedAtMs = Date.now();
  const maxPageTokens = params.max_page_tokens;
  const redactValues = params.redact_values ?? false;
  recordings.set(params.session_id, {
    requestId,
    tabs: new RecordingTabCoordinator(target.tabId, navigateUrl),
    agentWindowId: ctx.agentWindowId,
    startUrl: navigateUrl,
    ...(params.purpose ? { purpose: params.purpose } : {}),
    steps: [],
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    traceVersion: traceVersionOrErr,
    supportsTabSwitchSteps: params.supports_tab_switch_steps === true,
    finishPromise,
    resolveFinish,
    rejectFinish,
    settled: false,
    finishAttempt: null,
    observation:
      traceVersionOrErr === 3 && deps.cdp
        ? new RecordingObservationRuntime({
            cdp: deps.cdp,
            tabsApi: deps.tabsApi,
            maxTokens: maxPageTokens,
            redactValues,
          })
        : null,
    stoppedBy: "user_finish",
    navigationCallbacks: new Set(),
    acceptingNavigation: true,
    actionQueue: Promise.resolve(),
    lastStepSequenceByProducer: new Map(),
  });
  // Observe navigations for the whole recording lifetime; attach before
  // optional navigate so the destination load can rearm capture.
  ensureBrowserObservationListeners(deps);

  const abortPending = async (notifyContent: boolean) => {
    recordings.get(params.session_id)?.observation?.cancel();
    recordings.delete(params.session_id);
    releaseBrowserObservationListenersIfIdle();
    if (notifyContent) {
      try {
        await deps.sendToTab(target.tabId, {
          type: RECORD_CANCEL,
          requestId,
        });
      } catch {
        // Content may never have received RECORD_START.
      }
    }
    if (deps.bypassOverlay) {
      try {
        await deps.bypassOverlay(target.tabId, false);
      } catch {
        // Ignore cleanup errors.
      }
    }
  };

  const cancelledError = (): RpcError => ({
    code: "cancelled",
    message: "record_start aborted",
  });

  /** Dispatcher may race-cancel while we still hold a provisional recording. */
  const abortIfCancelled = async (notifyContent: boolean): Promise<RpcError | null> => {
    if (!deps.signal?.aborted) return null;
    await abortPending(notifyContent);
    return cancelledError();
  };

  {
    const cancelled = await abortIfCancelled(false);
    if (cancelled) return cancelled;
  }

  if (deps.cdp) {
    const nav = await handleNavigate(
      manager,
      {
        session_id: params.session_id,
        url: navigateUrl,
        tab_id: target.tabId,
      },
      { cdp: deps.cdp, tabsApi: deps.tabsApi, signal: deps.signal },
    );
    if (isRpcError(nav)) {
      await abortPending(false);
      return nav;
    }
    {
      const cancelled = await abortIfCancelled(false);
      if (cancelled) return cancelled;
    }
    try {
      await waitForTabReady(target.tabId, deps.tabsApi);
    } catch {
      // Proceed with retries even if the tab never reports complete.
    }
    {
      const cancelled = await abortIfCancelled(false);
      if (cancelled) return cancelled;
    }
  }

  let startUrl: string | undefined;
  try {
    const tab = await deps.tabsApi.get(target.tabId);
    startUrl = tab.url;
  } catch {
    startUrl = navigateUrl;
  }

  const active = recordings.get(params.session_id);
  if (!active) {
    // Cleared by a concurrent abort / session teardown.
    return cancelledError();
  }
  active.startUrl = startUrl;
  active.tabs.navigation(target.tabId, startUrl).currentUrl = startUrl;

  if (isContentScriptRestrictedUrl(startUrl)) {
    await abortPending(false);
    return {
      code: "invalid_params",
      message: params.url
        ? `cannot record on restricted URL (${startUrl}); use an http(s) page`
        : `cannot record on restricted URL (${startUrl}); default start page https://example.com/ did not load — pass --url with a page you can open`,
    };
  }

  {
    const cancelled = await abortIfCancelled(false);
    if (cancelled) return cancelled;
  }

  if (deps.bypassOverlay) {
    try {
      // Single ref for the initial race before RecordOverlay mounts; rearm must
      // not stack additional refs (see rearmRecording). Cleared on stop.
      await deps.bypassOverlay(target.tabId, true);
    } catch {
      // Best-effort; activeRecord also hides the control overlay.
    }
  }

  {
    const cancelled = await abortIfCancelled(true);
    if (cancelled) return cancelled;
  }

  const startMsg: RecordStartMessage = { type: RECORD_START, requestId, startedAtMs };

  try {
    await sendRecordStartWithAck(target.tabId, startMsg, deps.sendToTab);
  } catch {
    await abortPending(true);
    return {
      code: "protocol_error",
      message:
        "failed to start recording in content script — reload the BrowserSkill extension, then retry",
    };
  }

  if (active.observation) {
    const activeRecording = recordings.get(params.session_id);
    if (activeRecording) {
      try {
        await activeRecording.observation?.captureInitial(target.tabId);
      } catch {
        // Proceed without initial observation; steps may be dropped by reducer.
      }
    }
  }

  {
    const cancelled = await abortIfCancelled(true);
    if (cancelled) return cancelled;
  }

  return { tab_id: target.tabId, recording: true };
}

export async function handleRecordStop(
  manager: SessionManager,
  params: RecordStopParams,
  deps: RecordDeps = getDefaultDeps(),
): Promise<RecordStopResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "record_stop");
  if (isRpcError(ctxOrErr)) return ctxOrErr;

  const recording = recordings.get(params.session_id);
  if (!recording) {
    return {
      code: "not_found",
      message: `no active recording for session ${params.session_id}`,
    };
  }

  const trace = await finishRecording(params.session_id, deps, "cli_stop");
  if (!trace) {
    return {
      code: "protocol_error",
      message: `failed to flush recorded steps for session ${params.session_id}; the recording is still active — retry \`bsk record stop\``,
    };
  }
  return { trace };
}

export async function handleRecordAwait(
  manager: SessionManager,
  params: RecordAwaitParams,
  deps: RecordDeps = getDefaultDeps(),
): Promise<RecordAwaitResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "record_await");
  if (isRpcError(ctxOrErr)) return ctxOrErr;

  const recording = recordings.get(params.session_id);
  if (!recording) {
    return {
      code: "not_found",
      message: `no active recording for session ${params.session_id}`,
    };
  }

  if (deps.signal?.aborted) {
    return { code: "cancelled", message: "record_await aborted" };
  }

  const outcome = await new Promise<{ trace: RecordedTrace } | { error: RpcError }>((resolve) => {
    let settled = false;
    const finish = (result: { trace: RecordedTrace } | { error: RpcError }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      deps.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ error: { code: "cancelled", message: "record_await aborted" } });
    const timer =
      params.timeout_ms === undefined
        ? undefined
        : setTimeout(
            () =>
              finish({
                error: {
                  code: "timeout",
                  message: `record_await timed out after ${params.timeout_ms}ms`,
                },
              }),
            params.timeout_ms,
          );
    deps.signal?.addEventListener("abort", onAbort, { once: true });
    void recording.finishPromise.then(
      (trace) => finish({ trace }),
      () =>
        finish({
          error: { code: "cancelled", message: "recording was cleared" },
        }),
    );
  });
  return "trace" in outcome ? { trace: outcome.trace } : outcome.error;
}

export function clearRecordingForSession(sessionId: string): void {
  const recording = recordings.get(sessionId);
  if (!recording) {
    recordings.delete(sessionId);
    releaseBrowserObservationListenersIfIdle();
    return;
  }
  void clearRearmTimersForRecording(recording, getDefaultDeps());
  if (!recording.settled) {
    recording.observation?.cancel();
    recording.settled = true;
    recording.rejectFinish(new Error("recording cleared"));
  }
  recordings.delete(sessionId);
  releaseBrowserObservationListenersIfIdle();
}

export type { RecordFinishMessage };
