// `tool.record_start` / `tool.record_stop` / `tool.record_await` — capture
// user actions in the Agent Window via the content script and return a
// semantic (LLM textbook) trace.

import {
  isRecordFinishMessage,
  isRecordQueryMessage,
  isRecordStepMessage,
  RECORD_CANCEL,
  RECORD_CAPTURE_STATUS,
  RECORD_START,
  RECORD_STEP,
  RECORD_STOP,
  type RecordCancelMessage,
  type RecordCaptureStatusMessage,
  type RecordFinishMessage,
  type RecordQueryResponse,
  type RecordStartAck,
  type RecordStartMessage,
  type RecordStepPayload,
  type RecordStopMessage,
} from "@/lib/record-bridge";
import {
  armAllDocumentsForTab,
  armDocumentCapture,
  cancelDocumentCapture,
  type ArmedDocument,
  listInjectableFrames,
  type RecordFrameSendDeps,
  stopDocumentCapture,
} from "@/lib/record-frame-arming";
import { DEFAULT_MAX_PAGE_TOKENS } from "@/lib/record-constants";
import {
  applyTargetMatching,
  buildTraceV3,
  cancelPendingSettles,
  captureAndRegisterObservation,
  clearPendingRedirectLanding,
  createObservationState,
  flushPendingRedirectLanding,
  flushPendingSettles,
  inferMissingPostStates,
  type RecordingObservationState,
  rememberStepOnPage,
  scheduleDraftSettle,
  scheduleRedirectLandingFlush,
  settleUnsettledDrafts,
} from "@/lib/record-observation";
import { appendRecordedPayload, observeRecordedNavigation } from "@/lib/recording-step-buffer";
import type { SessionManager } from "@/session-manager/manager";
import { EXTENSION_VERSION } from "@/transport/handshake";
import type {
  DraftTraceStep,
  FrameCaptureFailure,
  FrameCaptureInfo,
  FrameCaptureStatus,
  RecordAwaitParams,
  RecordAwaitResult,
  RecordStartParams,
  RecordStartResult,
  RecordStopParams,
  RecordStopResult,
  RpcError,
  StopReason,
  Trace,
} from "@/transport/types";
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
  tabId: number;
  agentWindowId: number;
  startUrl?: string;
  purpose?: string;
  steps: DraftTraceStep[];
  startedAt: string;
  startedAtMs: number;
  finishPromise: Promise<Trace>;
  resolveFinish: (trace: Trace) => void;
  rejectFinish: (err: Error) => void;
  settled: boolean;
  finishing: boolean;
  currentUrl?: string;
  pendingNavigation: boolean;
  pendingNavigationDeadline?: number;
  observation: RecordingObservationState;
  stoppedBy: StopReason;
  maxPageTokens: number;
  redactValues: boolean;
  /** Documents whose capture acknowledged START and still need STOP. */
  armedDocuments: Map<string, ArmedDocument>;
  frameCaptureFailures: FrameCaptureFailure[];
  frameCaptureStatus: FrameCaptureStatus;
  /** When false, ignore subframe rearm requests during finish. */
  acceptingNewFrames: boolean;
  /** Rearms already sending START when finish begins. */
  rearmCallbacks: Set<Promise<void>>;
  /** Navigation callbacks tracked from event receipt through action enqueue. */
  navigationCallbacks: Set<Promise<void>>;
  /** Synchronous intake gate closed only after finish drains to stability. */
  acceptingNavigation: boolean;
  /**
   * Serializes step appends with navigation observation so a click is always
   * in `steps` before a same-turn `webNavigation` tries to annotate it.
   */
  actionQueue: Promise<void>;
  /**
   * CDP runner captured at `record_start`. The message listeners are attached
   * once at service-worker startup, where no runner exists yet, so observation
   * capture must go through the recording instead of the listener deps.
   */
  cdp?: CdpRunner;
}

function enqueueRecordingAction(recording: ActiveRecording, task: () => Promise<void>): void {
  recording.actionQueue = recording.actionQueue.then(task, task).catch(() => {});
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

function buildTrace(recording: ActiveRecording): Trace {
  const frameCapture: FrameCaptureInfo | undefined =
    recording.frameCaptureFailures.length > 0 || recording.frameCaptureStatus === "partial"
      ? {
          status: recording.frameCaptureStatus,
          ...(recording.frameCaptureFailures.length > 0
            ? { failures: recording.frameCaptureFailures }
            : {}),
        }
      : undefined;
  return buildTraceV3({
    obs: recording.observation,
    steps: recording.steps,
    startedAt: recording.startedAt,
    ...(recording.purpose ? { purpose: recording.purpose } : {}),
    startUrl: recording.startUrl,
    stoppedBy: recording.stoppedBy,
    bskVersion: BSK_TRACE_VERSION,
    ...(frameCapture ? { frameCapture } : {}),
  });
}

function recordFrameFailure(recording: ActiveRecording, failure: FrameCaptureFailure): void {
  recording.frameCaptureFailures.push(failure);
  recording.frameCaptureStatus = "partial";
}

function enrichRecordedStep(
  recording: ActiveRecording,
  step: RecordStepPayload,
): RecordStepPayload {
  const enriched: RecordStepPayload = { ...step };
  if (enriched.geometry && enriched.documentToken) {
    const owner = recording.observation.documentTokenOwners.get(enriched.documentToken);
    if (owner !== undefined) {
      enriched.geometry = { ...enriched.geometry, ownerFrameBackendNodeId: owner };
    }
  }
  if (!enriched.page_url && recording.currentUrl) {
    enriched.page_url = recording.currentUrl;
  }
  return enriched;
}

async function publishCaptureStatus(
  recording: ActiveRecording,
  deps: RecordDeps,
): Promise<void> {
  if (!deps.broadcastCaptureStatus) return;
  const msg: RecordCaptureStatusMessage = {
    type: RECORD_CAPTURE_STATUS,
    status: recording.frameCaptureStatus,
    ...(recording.frameCaptureFailures.length > 0
      ? { failures: recording.frameCaptureFailures }
      : {}),
  };
  try {
    await deps.broadcastCaptureStatus(recording.tabId, msg);
  } catch {
    // Overlay is best-effort.
  }
}

async function processRecordedStep(
  recording: ActiveRecording,
  deps: RecordDeps,
  draftIndex: number,
): Promise<void> {
  const cdp = recording.cdp ?? deps.cdp;
  if (!cdp) return;
  const draft = recording.steps[draftIndex];
  if (!draft) return;
  const stepId = draftIndex + 1;

  if (draft.op === "navigate") {
    draft.preStateId = recording.observation.lastSettled?.stateId;
  } else {
    applyTargetMatching(recording.observation, draft, stepId);
  }
  rememberStepOnPage(recording.observation, draft, stepId);

  scheduleDraftSettle(
    recording.observation,
    draftIndex,
    stepId,
    cdp,
    recording.tabId,
    deps.tabsApi,
    recording.steps,
  );
}

export interface RecordDeps {
  tabsApi: ChromeTabsApi;
  sendToTab(
    tabId: number,
    msg: RecordStartMessage | RecordStopMessage | RecordCancelMessage,
  ): Promise<unknown>;
  sendToDocument?(
    tabId: number,
    documentId: string,
    msg: RecordStartMessage | RecordStopMessage | RecordCancelMessage,
  ): Promise<unknown>;
  getAllFrames?(tabId: number): Promise<
    Array<{
      frameId: number;
      documentId?: string;
      url?: string;
      parentFrameId: number;
    }>
  >;
  broadcastCaptureStatus?(
    tabId: number,
    msg: RecordCaptureStatusMessage,
  ): Promise<void>;
  bypassOverlay?: (tabId: number, enabled: boolean) => Promise<void>;
  cdp?: CdpRunner;
  signal?: AbortSignal;
}

function frameSendDeps(deps: RecordDeps): RecordFrameSendDeps {
  return {
    sendToDocument: (tabId, documentId, msg) => {
      if (deps.sendToDocument) return deps.sendToDocument(tabId, documentId, msg);
      return deps.sendToTab(tabId, msg);
    },
    getAllFrames: async (tabId) => {
      if (deps.getAllFrames) return deps.getAllFrames(tabId);
      if (!chrome.webNavigation?.getAllFrames) return [];
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      return (frames ?? []).map((frame) => ({
        frameId: frame.frameId,
        documentId: frame.documentId,
        url: frame.url,
        parentFrameId: frame.parentFrameId,
      }));
    },
  };
}

let defaultDeps: RecordDeps | null = null;
function getDefaultDeps(): RecordDeps {
  if (!defaultDeps) {
    defaultDeps = {
      tabsApi: chromeTabsApi,
      sendToTab: (tabId, msg) => chrome.tabs.sendMessage(tabId, msg),
      sendToDocument: (tabId, documentId, msg) =>
        chrome.tabs.sendMessage(tabId, msg, { documentId }),
      getAllFrames: async (tabId) => {
        if (!chrome.webNavigation?.getAllFrames) return [];
        const frames = await chrome.webNavigation.getAllFrames({ tabId });
        return (frames ?? []).map((frame) => ({
          frameId: frame.frameId,
          documentId: frame.documentId,
          url: frame.url,
          parentFrameId: frame.parentFrameId,
        }));
      },
      broadcastCaptureStatus: (tabId, msg) => chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }),
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
    _sendResponse: () => void,
  ) => {
    if (!isRecordStepMessage(message)) return false;
    for (const recording of recordings.values()) {
      if (recording.requestId !== message.requestId) continue;
      enqueueRecordingAction(recording, async () => {
        const cdp = recording.cdp ?? deps.cdp;
        await flushPendingRedirectLanding(
          recording.observation,
          recording.steps,
          cdp,
          recording.tabId,
          deps.tabsApi,
          { cancelled: () => recording.settled },
        );
        const enriched = enrichRecordedStep(recording, message.step);
        const draftIndex = appendRecordedPayload(recording, enriched);
        if (draftIndex !== null) await processRecordedStep(recording, deps, draftIndex);
      });
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
    if (recording.settled) continue;
    if (recording.tabId === tabId) return recording;
    for (const armed of recording.armedDocuments.values()) {
      if (armed.tabId === tabId) return recording;
    }
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
  clearRearmTimer(recording.tabId);
  try {
    const tabs = await deps.tabsApi.query({ windowId: recording.agentWindowId });
    for (const tab of tabs) {
      if (typeof tab.id === "number") clearRearmTimer(tab.id);
    }
  } catch {
    // Best-effort cleanup.
  }
}

async function stopRecordingOnAllDocuments(
  recording: ActiveRecording,
  deps: RecordDeps,
): Promise<void> {
  recording.acceptingNewFrames = false;
  const stopMsg: RecordStopMessage = { type: RECORD_STOP, requestId: recording.requestId };
  const frameDeps = frameSendDeps(deps);
  const armed = [...recording.armedDocuments.values()];
  for (const doc of armed) {
    const result = await stopDocumentCapture(doc, stopMsg, frameDeps);
    if ("ok" in result) {
      recording.armedDocuments.delete(doc.documentId);
      continue;
    }
    recordFrameFailure(recording, result);
  }
  if (recording.armedDocuments.size > 0) {
    for (const doc of [...recording.armedDocuments.values()]) {
      recordFrameFailure(
        recording,
        {
          reason: "flush_failed",
          frame_id: doc.frameId,
          document_id: doc.documentId,
          url: doc.url,
          detail: "document still armed after STOP",
        },
      );
    }
    recording.armedDocuments.clear();
  }
  await publishCaptureStatus(recording, deps);
  if (deps.bypassOverlay) {
    try {
      await deps.bypassOverlay(recording.tabId, false);
    } catch {
      // Best-effort cleanup.
    }
  }
}

async function cancelRecordingOnAllDocuments(
  recording: ActiveRecording,
  deps: RecordDeps,
): Promise<void> {
  const cancelMsg: RecordCancelMessage = { type: RECORD_CANCEL, requestId: recording.requestId };
  const frameDeps = frameSendDeps(deps);
  for (const doc of [...recording.armedDocuments.values()]) {
    await cancelDocumentCapture(doc, cancelMsg, frameDeps);
  }
  recording.armedDocuments.clear();
}

async function rearmRecordingDocuments(
  recording: ActiveRecording,
  targetTabId: number,
  deps: RecordDeps,
  targetDocumentId?: string,
): Promise<boolean> {
  let resolveTracked!: () => void;
  const tracked = new Promise<void>((resolve) => {
    resolveTracked = resolve;
  });
  recording.rearmCallbacks.add(tracked);

  const frameDeps = frameSendDeps(deps);
  try {
    const attemptLimit = targetDocumentId ? 1 : RECORD_REARM_MAX_ATTEMPTS;
    for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
      if (recording.settled || recording.finishing || !recording.acceptingNewFrames) return false;
      const { injectable, failures } = await listInjectableFrames(targetTabId, frameDeps);
      for (const failure of failures) recordFrameFailure(recording, failure);
      const targets = targetDocumentId
        ? injectable.filter((frame) => frame.documentId === targetDocumentId)
        : injectable.filter((frame) => !recording.armedDocuments.has(frame.documentId ?? ""));
      if (targets.length === 0) {
        if (targetDocumentId) {
          recordFrameFailure(recording, {
            reason: "rearm_failed",
            frame_id: 0,
            document_id: targetDocumentId,
            detail: "document not injectable",
          });
          await publishCaptureStatus(recording, deps);
          return false;
        }
        recording.tabId = targetTabId;
        return injectable.some((frame) => recording.armedDocuments.has(frame.documentId ?? ""));
      }

      let armedAny = false;
      for (const frame of targets) {
        const startMsg: RecordStartMessage = {
          type: RECORD_START,
          requestId: recording.requestId,
          startedAtMs: recording.startedAtMs,
          showOverlay: frame.frameId === 0,
          frameMode: frame.frameId === 0 ? "top" : "child",
        };
        const result = await armDocumentCapture(targetTabId, frame, startMsg, frameDeps);
        if (result.armed) {
          recording.armedDocuments.set(result.armed.documentId, result.armed);
          armedAny = true;
        }
        if (result.failure) recordFrameFailure(recording, result.failure);
      }
      if (armedAny) {
        recording.tabId = targetTabId;
        await publishCaptureStatus(recording, deps);
        if (deps.cdp && recording.acceptingNewFrames) {
          void captureAndRegisterObservation(
            recording.observation,
            deps.cdp,
            targetTabId,
            deps.tabsApi,
          ).catch(() => {});
        }
        return true;
      }
      if (attempt + 1 < RECORD_REARM_MAX_ATTEMPTS) {
        await sleep(RECORD_REARM_RETRY_DELAY_MS);
      }
    }
    await publishCaptureStatus(recording, deps);
    return false;
  } finally {
    recording.rearmCallbacks.delete(tracked);
    resolveTracked();
  }
}

function scheduleRearmForTab(tabId: number, deps: RecordDeps): void {
  const existing = rearmTimers.get(tabId);
  if (existing) clearTimeout(existing);
  rearmTimers.set(
    tabId,
    setTimeout(() => {
      rearmTimers.delete(tabId);
      void (async () => {
        const current = await findRecordingForTab(tabId, deps);
        if (current) await rearmRecordingDocuments(current, tabId, deps);
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
    scheduleRearmForTab(activeInfo.tabId, deps);
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
    const direct = findRecordingByTabId(tabId);
    const candidates = direct
      ? direct.acceptingNavigation
        ? [direct]
        : []
      : [...recordings.values()].filter(
          (recording) => !recording.settled && recording.acceptingNavigation,
        );
    if (candidates.length === 0) return;

    let resolveTracked!: () => void;
    const tracked = new Promise<void>((resolve) => {
      resolveTracked = resolve;
    });
    for (const candidate of candidates) candidate.navigationCallbacks.add(tracked);

    void (async () => {
      try {
        const recording = await findRecordingForTab(tabId, deps);
        if (!recording || !recording.acceptingNavigation || !candidates.includes(recording)) {
          return;
        }
        enqueueRecordingAction(recording, async () => {
          const result = observeRecordedNavigation(
            recording,
            url,
            causedByAction,
            transitionType,
            transitionQualifiers,
          );
          const cdp = recording.cdp ?? deps.cdp;
          if (!cdp) return;

          if (result.kind === "coalesce_redirect") {
            scheduleRedirectLandingFlush(
              recording.observation,
              recording.steps,
              cdp,
              tabId,
              deps.tabsApi,
              result.url,
              { cancelled: () => recording.settled },
            );
            return;
          }

          if (result.kind === "noop") return;

          // A concrete navigation supersedes any in-flight redirect coalesce.
          clearPendingRedirectLanding(recording.observation);

          const draftIndex = result.index;
          const lastDraft = recording.steps[draftIndex];
          if (!lastDraft) return;

          if (result.kind === "appended") {
            lastDraft.preStateId = recording.observation.lastSettled?.stateId;
            rememberStepOnPage(recording.observation, lastDraft, draftIndex + 1);
          }
          scheduleDraftSettle(
            recording.observation,
            draftIndex,
            draftIndex + 1,
            cdp,
            tabId,
            deps.tabsApi,
            recording.steps,
          );
        });
      } finally {
        for (const candidate of candidates) candidate.navigationCallbacks.delete(tracked);
        resolveTracked();
      }
    })();
  };
  const onMainFrameComplete = (tabId: number, url?: string) => {
    void (async () => {
      observeMainFrame(tabId, url);
      scheduleRearmForTab(tabId, deps);
    })();
  };

  const onSubFrameComplete = (tabId: number, documentId?: string) => {
    if (!documentId) return;
    void (async () => {
      const recording = await findRecordingForTab(tabId, deps);
      if (!recording || !recording.acceptingNewFrames) return;
      await rearmRecordingDocuments(recording, tabId, deps, documentId);
    })();
  };

  if (chrome.webNavigation?.onCompleted) {
    const completedListener = (
      details: chrome.webNavigation.WebNavigationFramedCallbackDetails,
    ) => {
      if (details.frameId === 0) {
        onMainFrameComplete(details.tabId, details.url);
        return;
      }
      onSubFrameComplete(details.tabId, details.documentId);
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

async function drainRecordingToStability(
  recording: ActiveRecording,
  deps: RecordDeps,
): Promise<boolean> {
  const cdp = recording.cdp ?? deps.cdp;
  for (let round = 0; round < MAX_FINISH_DRAIN_ROUNDS; round += 1) {
    await Promise.all([...recording.navigationCallbacks]);
    const actionTail = recording.actionQueue;
    await actionTail;
    await flushPendingRedirectLanding(
      recording.observation,
      recording.steps,
      cdp,
      recording.tabId,
      deps.tabsApi,
      { cancelled: () => recording.settled },
    );
    await flushPendingSettles(recording.observation);
    const redirectTail = recording.observation.redirectFlushQueue;
    const settleTail = recording.observation.settleQueue;
    await Promise.all([redirectTail, settleTail]);

    if (
      recording.navigationCallbacks.size === 0 &&
      recording.actionQueue === actionTail &&
      recording.observation.redirectFlushQueue === redirectTail &&
      recording.observation.settleQueue === settleTail
    ) {
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
      await rearmRecordingDocuments(recording, tabId, deps, sender.documentId);
      sendResponse({
        active: true,
        requestId: recording.requestId,
        startedAtMs: recording.startedAtMs,
        captureStatus: recording.frameCaptureStatus,
        ...(recording.frameCaptureFailures.length > 0
          ? { captureFailures: recording.frameCaptureFailures }
          : {}),
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
): Promise<Trace | null> {
  const recording = recordings.get(sessionId);
  if (!recording || recording.settled) return null;
  if (recording.finishing) return recording.finishPromise;
  recording.finishing = true;
  recording.stoppedBy = stoppedBy;

  await clearRearmTimersForRecording(recording, deps);
  await Promise.all([...recording.rearmCallbacks]);
  try {
    await stopRecordingOnAllDocuments(recording, deps);
  } catch {
    recording.finishing = false;
    return null;
  }
  if (!(await drainRecordingToStability(recording, deps))) {
    recording.finishing = false;
    return null;
  }
  cancelPendingSettles(recording.observation);
  inferMissingPostStates(recording.steps);
  const cdp = recording.cdp ?? deps.cdp;
  if (cdp) {
    await settleUnsettledDrafts(
      recording.observation,
      cdp,
      recording.tabId,
      deps.tabsApi,
      recording.steps,
    );
  }

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
  let resolveFinish!: (trace: Trace) => void;
  let rejectFinish!: (err: Error) => void;
  const finishPromise = new Promise<Trace>((resolve, reject) => {
    resolveFinish = resolve;
    rejectFinish = reject;
  });
  const navigateUrl = params.url ?? RECORD_DEFAULT_START_URL;
  const startedAtMs = Date.now();
  const maxPageTokens = params.max_page_tokens;
  const redactValues = params.redact_values ?? false;
  recordings.set(params.session_id, {
    requestId,
    tabId: target.tabId,
    agentWindowId: ctx.agentWindowId,
    startUrl: navigateUrl,
    ...(params.purpose ? { purpose: params.purpose } : {}),
    steps: [],
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    finishPromise,
    resolveFinish,
    rejectFinish,
    settled: false,
    finishing: false,
    currentUrl: navigateUrl,
    pendingNavigation: false,
    pendingNavigationDeadline: undefined,
    observation: createObservationState({ maxPageTokens, redactValues }),
    stoppedBy: "user_finish",
    maxPageTokens: maxPageTokens ?? DEFAULT_MAX_PAGE_TOKENS,
    redactValues,
    armedDocuments: new Map(),
    frameCaptureFailures: [],
    frameCaptureStatus: "complete",
    acceptingNewFrames: true,
    rearmCallbacks: new Set(),
    navigationCallbacks: new Set(),
    acceptingNavigation: true,
    actionQueue: Promise.resolve(),
    ...(deps.cdp ? { cdp: deps.cdp } : {}),
  });
  // Observe navigations for the whole recording lifetime; attach before
  // optional navigate so the destination load can rearm capture.
  ensureBrowserObservationListeners(deps);

  const abortPending = async (notifyContent: boolean) => {
    const pending = recordings.get(params.session_id);
    recordings.delete(params.session_id);
    releaseBrowserObservationListenersIfIdle();
    if (notifyContent && pending) {
      await cancelRecordingOnAllDocuments(pending, deps);
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
  active.currentUrl = startUrl;

  if (isContentScriptRestrictedUrl(startUrl)) {
    await abortPending(false);
    return {
      code: "invalid_params",
      message: params.url
        ? `cannot record on restricted URL (${startUrl}); use an http(s) page`
        : `cannot record on restricted URL (${startUrl}); default start page must be injectable http(s)`,
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

  const startMsg: RecordStartMessage = {
    type: RECORD_START,
    requestId,
    startedAtMs,
    showOverlay: true,
    frameMode: "top",
  };

  try {
    const frameDeps = frameSendDeps(deps);
    const { armed, failures } = await armAllDocumentsForTab(target.tabId, startMsg, frameDeps);
    for (const failure of failures) recordFrameFailure(active, failure);
    for (const doc of armed) active.armedDocuments.set(doc.documentId, doc);
    if (active.armedDocuments.size === 0) {
      await abortPending(true);
      return {
        code: "protocol_error",
        message:
          "failed to start recording in any frame — reload the BrowserSkill extension, then retry",
      };
    }
    await publishCaptureStatus(active, deps);
  } catch {
    await abortPending(true);
    return {
      code: "protocol_error",
      message:
        "failed to start recording in content script — reload the BrowserSkill extension, then retry",
    };
  }

  if (deps.cdp) {
    const activeRecording = recordings.get(params.session_id);
    if (activeRecording) {
      try {
        await captureAndRegisterObservation(
          activeRecording.observation,
          deps.cdp,
          target.tabId,
          deps.tabsApi,
          startUrl,
        );
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

  const outcome = await new Promise<{ trace: Trace } | { error: RpcError }>((resolve) => {
    let settled = false;
    const finish = (result: { trace: Trace } | { error: RpcError }) => {
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
    recording.settled = true;
    recording.rejectFinish(new Error("recording cleared"));
  }
  recordings.delete(sessionId);
  releaseBrowserObservationListenersIfIdle();
}

export type { RecordFinishMessage };
