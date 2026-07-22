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
  type RecordStopMessage,
} from "@/lib/record-bridge";
import { appendRecordedPayload, observeRecordedNavigation } from "@/lib/recording-step-buffer";
import { reduceTraceSteps, resolveTraceStartUrl } from "@/lib/trace-reducer";
import type { SessionManager } from "@/session-manager/manager";
import type {
  DraftTraceStep,
  RecordAwaitParams,
  RecordAwaitResult,
  RecordStartParams,
  RecordStartResult,
  RecordStopParams,
  RecordStopResult,
  RpcError,
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
  finishPromise: Promise<Trace>;
  resolveFinish: (trace: Trace) => void;
  rejectFinish: (err: Error) => void;
  settled: boolean;
  finishing: boolean;
  currentUrl?: string;
  pendingNavigation: boolean;
  pendingNavigationDeadline?: number;
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

/** Injectable http(s) landing page when `tool.record_start` omits `url`. */
export const RECORD_DEFAULT_START_URL = "https://www.baidu.com/";

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
  const { pages, steps } = reduceTraceSteps(recording.steps, recording.startUrl);
  const startUrl = resolveTraceStartUrl(recording.steps, recording.startUrl, pages);
  return {
    ...(recording.purpose ? { purpose: recording.purpose } : {}),
    recorded_at: new Date().toISOString(),
    started_at: recording.startedAt,
    entry: { start_url: startUrl },
    pages,
    steps,
  };
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

export function attachRecordStepListener(): () => void {
  const listener = (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    _sendResponse: () => void,
  ) => {
    if (!isRecordStepMessage(message)) return false;
    for (const recording of recordings.values()) {
      if (recording.requestId !== message.requestId) continue;
      appendRecordedPayload(recording, message.step);
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
    if (recording.tabId === tabId && !recording.settled) return recording;
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

async function stopRecordingOnAllAgentTabs(
  recording: ActiveRecording,
  deps: RecordDeps,
): Promise<void> {
  const stopMsg: RecordStopMessage = { type: RECORD_STOP, requestId: recording.requestId };
  let tabIds = [recording.tabId];
  try {
    const tabs = await deps.tabsApi.query({ windowId: recording.agentWindowId });
    tabIds = [
      ...new Set([
        recording.tabId,
        ...tabs.flatMap((tab) => (typeof tab.id === "number" ? [tab.id] : [])),
      ]),
    ];
  } catch {
    // Fall back to the current recording tab.
  }

  for (const tabId of tabIds) {
    try {
      const response = await deps.sendToTab(tabId, stopMsg);
      if (tabId === recording.tabId && !isRecordStartAck(response)) {
        throw new Error("content script did not confirm recorded steps");
      }
    } catch {
      if (tabId === recording.tabId) {
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
): Promise<boolean> {
  // Do NOT toggle automation-bypass here: each retry used to increment the
  // content-script counter, and a single stop decrement left the ControlOverlay
  // stuck with pointer-events:none (page usable, Interrupt dead). RecordOverlay
  // already hides the control chrome while activeRecord is set.
  for (let attempt = 0; attempt < RECORD_REARM_MAX_ATTEMPTS; attempt += 1) {
    const startMsg: RecordStartMessage = { type: RECORD_START, requestId: recording.requestId };
    try {
      await sendRecordStartWithAck(targetTabId, startMsg, deps.sendToTab);
      recording.tabId = targetTabId;
      return true;
    } catch {
      if (attempt + 1 < RECORD_REARM_MAX_ATTEMPTS) {
        await sleep(RECORD_REARM_RETRY_DELAY_MS);
      }
    }
  }
  return false;
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
        if (current) await rearmRecording(current, tabId, deps);
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
  const observeMainFrame = (tabId: number, url?: string, causedByAction?: boolean) => {
    void (async () => {
      const recording = await findRecordingForTab(tabId, deps);
      if (recording && url) {
        observeRecordedNavigation(recording, url, causedByAction);
      }
    })();
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
      const causedByAction =
        details.transitionType === "link" || details.transitionType === "form_submit"
          ? true
          : details.transitionType === "typed" ||
              details.transitionType === "auto_bookmark" ||
              details.transitionType === "generated" ||
              details.transitionType === "keyword" ||
              details.transitionType === "keyword_generated" ||
              details.transitionType === "reload"
            ? false
            : undefined;
      observeMainFrame(details.tabId, details.url, causedByAction);
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
      await rearmRecording(recording, tabId, deps);
      sendResponse({ active: true, requestId: recording.requestId });
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
    await finishRecording(sessionId, deps);
    return;
  }
}

async function finishRecording(sessionId: string, deps: RecordDeps): Promise<Trace | null> {
  const recording = recordings.get(sessionId);
  if (!recording || recording.settled || recording.finishing) return null;
  recording.finishing = true;

  await clearRearmTimersForRecording(recording, deps);
  try {
    await stopRecordingOnAllAgentTabs(recording, deps);
  } catch {
    recording.finishing = false;
    return null;
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
  recordings.set(params.session_id, {
    requestId,
    tabId: target.tabId,
    agentWindowId: ctx.agentWindowId,
    startUrl: navigateUrl,
    ...(params.purpose ? { purpose: params.purpose } : {}),
    steps: [],
    startedAt: new Date().toISOString(),
    finishPromise,
    resolveFinish,
    rejectFinish,
    settled: false,
    finishing: false,
    currentUrl: navigateUrl,
    pendingNavigation: false,
    pendingNavigationDeadline: undefined,
  });
  // Observe navigations for the whole recording lifetime; attach before
  // optional navigate so the destination load can rearm capture.
  ensureBrowserObservationListeners(deps);

  const abortPending = async (notifyContent: boolean) => {
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

  const startMsg: RecordStartMessage = { type: RECORD_START, requestId };

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

  const trace = await finishRecording(params.session_id, deps);
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
