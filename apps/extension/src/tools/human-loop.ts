// `tool.request_help` — pause automation and let the human control a tab.

import {
  HELP_ACK,
  HELP_CANCEL,
  HELP_FINISH,
  HELP_QUERY,
  HELP_REQUEST,
  type HelpCancelMessage,
  type HelpFinishMessage,
  type HelpQueryResponse,
  type HelpRequestMessage,
  isHelpAckMessage,
  isHelpFinishMessage,
  isHelpQueryMessage,
  isHelpResponseMessage,
} from "@/lib/help-bridge";
import type { SessionContext, SessionManager } from "@/session-manager/manager";
import type {
  HelpCompletionCondition,
  HelpCompletionCriteria,
  HelpTarget,
  RequestHelpParams,
  RequestHelpResult,
  ResolvedTarget,
  RpcError,
} from "@/transport/types";
import {
  type CdpRunner,
  type ChromeTabsApi,
  chromeTabsApi,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
} from "./shared";
import { lookupSnapshotRef } from "./snapshot-ref";

const DEFAULT_HELP_TIMEOUT_MS = 300_000;
const HELP_ATTR = "data-bsk-help";
const HELP_SEND_RETRIES = 3;
const HELP_SEND_RETRY_DELAY_MS = 350;
const HELP_REARM_DEBOUNCE_MS = 150;
const HELP_REARM_MAX_ATTEMPTS = 12;
const HELP_REARM_RETRY_DELAY_MS = 400;
const DEFAULT_COMPLETION_STABLE_MS = 1_000;
const COMPLETION_POLL_MS = 500;

export interface RequestHelpNotifications {
  create(id: string, options: chrome.notifications.NotificationOptions<true>): Promise<string>;
  clear(id: string): Promise<boolean>;
}

export interface RequestHelpDeps {
  tabsApi: ChromeTabsApi;
  windows: {
    update(windowId: number, info: { focused?: boolean }): Promise<chrome.windows.Window>;
  };
  activateTab(tabId: number): Promise<void>;
  sendToTab(tabId: number, msg: HelpRequestMessage | HelpCancelMessage): Promise<unknown>;
  cdp?: CdpRunner;
  notifications: RequestHelpNotifications | null;
  notificationCopy?: { title: string; body: string };
  signal?: AbortSignal;
  autoAttachLifecycle?: boolean;
}

interface ActiveHelpRequest {
  ctx: SessionContext;
  requestId: string;
  primaryTabId: number;
  overlayTabIds: Set<number>;
  prompt: string;
  title?: string;
  targets: HelpTarget[];
  selectors: string[];
  timeoutMs: number;
  notificationId: string;
  resolvedTargets?: ResolvedTarget[];
  completionCriteria?: HelpCompletionCriteria;
  deps: RequestHelpDeps;
  settled: boolean;
  resolve: (value: RequestHelpResult | RpcError) => void;
  timeoutTimer: ReturnType<typeof setTimeout>;
  completionTimer: ReturnType<typeof setInterval> | null;
  completionMatchedSince: number | null;
  abortHandler: (() => void) | null;
}

const activeHelpRequests = new Map<string, ActiveHelpRequest>();
const helpRearmTimers = new Map<number, ReturnType<typeof setTimeout>>();

let defaultDeps: RequestHelpDeps | null = null;
function getDefaultDeps(): RequestHelpDeps {
  if (!defaultDeps) {
    defaultDeps = {
      tabsApi: chromeTabsApi,
      windows: { update: (id, info) => chrome.windows.update(id, info) },
      activateTab: async (tabId) => {
        await chrome.tabs.update(tabId, { active: true });
      },
      sendToTab: (tabId, msg) => chrome.tabs.sendMessage(tabId, msg),
      notifications: {
        create: (id, opts) =>
          new Promise((resolve, reject) =>
            chrome.notifications.create(id, opts, (rid) => {
              const err = chrome.runtime?.lastError;
              if (err) reject(new Error(err.message ?? String(err)));
              else resolve(rid ?? id);
            }),
          ),
        clear: (id) =>
          new Promise((resolve) => chrome.notifications.clear(id, (c) => resolve(c ?? false))),
      },
    };
  }
  return defaultDeps;
}

function makeRequestId(tabId: number): string {
  return `${tabId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function helpRequestMessage(help: ActiveHelpRequest, tabId: number): HelpRequestMessage {
  const isPrimaryTab = tabId === help.primaryTabId;
  return {
    type: HELP_REQUEST,
    requestId: help.requestId,
    prompt: help.prompt,
    ...(help.title ? { title: help.title } : {}),
    displayMode: isPrimaryTab ? "full" : "compact",
    selectors: isPrimaryTab ? help.selectors : [],
    timeoutMs: help.timeoutMs,
  };
}

async function sendHelpRequestWithAck(
  tabId: number,
  msg: HelpRequestMessage,
  deps: RequestHelpDeps,
): Promise<HelpFinishMessage | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt < HELP_SEND_RETRIES; attempt += 1) {
    try {
      const response = await deps.sendToTab(tabId, msg);
      if (isHelpAckMessage(response)) return null;
      if (isHelpResponseMessage(response)) {
        return {
          type: HELP_FINISH,
          requestId: msg.requestId,
          outcome: response.outcome,
          ...(response.note ? { note: response.note } : {}),
        };
      }
      lastError = new Error("content script did not ack HELP_REQUEST");
    } catch (err) {
      lastError = err;
    }
    if (attempt + 1 < HELP_SEND_RETRIES) await sleep(HELP_SEND_RETRY_DELAY_MS);
  }
  throw lastError ?? new Error("failed to show help overlay");
}

async function tagRefTarget(
  cdp: CdpRunner,
  tabId: number,
  backendNodeId: number,
  index: number,
): Promise<string | null> {
  let objectId: string | undefined;
  try {
    const resolved = await cdp.send<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", {
      backendNodeId,
    });
    objectId = resolved.object?.objectId;
    if (!objectId) return null;
    await cdp.send(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(){ this.setAttribute("${HELP_ATTR}", "${index}"); }`,
    });
    return `[${HELP_ATTR}="${index}"]`;
  } catch {
    return null;
  } finally {
    if (objectId) {
      await cdp.send(tabId, "Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }
}

async function selectorExists(
  cdp: CdpRunner,
  tabId: number,
  rootNodeId: number,
  selector: string,
): Promise<boolean> {
  try {
    const res = await cdp.send<{ nodeId?: number }>(tabId, "DOM.querySelector", {
      nodeId: rootNodeId,
      selector,
    });
    return typeof res.nodeId === "number" && res.nodeId !== 0;
  } catch {
    return false;
  }
}

async function clearRefTags(cdp: CdpRunner | undefined, tabId: number): Promise<void> {
  if (!cdp) return;
  try {
    const doc = await cdp.send<{ root?: { nodeId?: number } }>(tabId, "DOM.getDocument", {
      depth: 0,
    });
    const rootId = doc.root?.nodeId;
    if (rootId === undefined) return;
    const { nodeIds } = await cdp.send<{ nodeIds: number[] }>(tabId, "DOM.querySelectorAll", {
      nodeId: rootId,
      selector: `[${HELP_ATTR}]`,
    });
    for (const nodeId of nodeIds ?? []) {
      await cdp.send(tabId, "DOM.removeAttribute", { nodeId, name: HELP_ATTR }).catch(() => {});
    }
  } catch {
    // Best-effort cleanup.
  }
}

async function resolveHelpTargets(
  ctx: ReturnType<SessionManager["get"]>,
  tabId: number,
  targets: HelpTarget[],
  deps: RequestHelpDeps,
): Promise<{ selectors: string[]; resolvedTargets?: ResolvedTarget[] }> {
  const selectors: string[] = [];
  const resolved: ResolvedTarget[] = [];
  let rootNodeId: number | undefined;
  if (deps.cdp && targets.length > 0) {
    try {
      const doc = await deps.cdp.send<{ root?: { nodeId?: number } }>(tabId, "DOM.getDocument", {
        depth: 0,
      });
      rootNodeId = doc.root?.nodeId;
    } catch {
      rootNodeId = undefined;
    }
  }

  for (let i = 0; i < targets.length; i += 1) {
    const tgt = targets[i];
    if (tgt.selector) {
      selectors.push(tgt.selector);
      const matched =
        deps.cdp && rootNodeId !== undefined
          ? await selectorExists(deps.cdp, tabId, rootNodeId, tgt.selector)
          : deps.cdp
            ? false
            : true;
      resolved.push({ matched, selector: tgt.selector });
    } else if (tgt.ref) {
      const looked = ctx ? lookupSnapshotRef(ctx, tgt.ref, tabId) : null;
      const backendNodeId = looked?.backendNodeId ?? null;
      let sel: string | null = null;
      if (backendNodeId !== null && deps.cdp) {
        sel = await tagRefTarget(deps.cdp, tabId, backendNodeId, i);
      }
      if (sel) selectors.push(sel);
      resolved.push({ matched: sel !== null, ref: tgt.ref });
    }
  }

  return { selectors, resolvedTargets: resolved.length > 0 ? resolved : undefined };
}

async function refreshHelpTargets(help: ActiveHelpRequest): Promise<void> {
  await clearRefTags(help.deps.cdp, help.primaryTabId);
  const { selectors, resolvedTargets } = await resolveHelpTargets(
    help.ctx,
    help.primaryTabId,
    help.targets,
    help.deps,
  );
  help.selectors = selectors;
  help.resolvedTargets = resolvedTargets;
}

async function cleanupHelp(help: ActiveHelpRequest): Promise<void> {
  if (help.deps.notifications) {
    await help.deps.notifications.clear(help.notificationId).catch(() => {});
  }
  const tabsToCancel = new Set([help.primaryTabId, ...help.overlayTabIds]);
  await Promise.all(
    [...tabsToCancel].map((tabId) =>
      Promise.all([
        clearRefTags(help.deps.cdp, tabId),
        help.deps
          .sendToTab(tabId, { type: HELP_CANCEL, requestId: help.requestId })
          .catch(() => {}),
      ]),
    ),
  );
}

function finishHelp(
  help: ActiveHelpRequest,
  value: RequestHelpResult | RpcError,
  notifyContent = true,
): void {
  if (help.settled) return;
  help.settled = true;
  activeHelpRequests.delete(help.requestId);
  clearTimeout(help.timeoutTimer);
  if (help.completionTimer) clearInterval(help.completionTimer);
  if (help.abortHandler) help.deps.signal?.removeEventListener("abort", help.abortHandler);
  clearRearmTimer(help.primaryTabId);
  for (const tabId of help.overlayTabIds) clearRearmTimer(tabId);
  if (notifyContent) void cleanupHelp(help);
  help.resolve(value);
}

function findHelpByKnownTabId(tabId: number): ActiveHelpRequest | null {
  for (const help of activeHelpRequests.values()) {
    if (!help.settled && (help.primaryTabId === tabId || help.overlayTabIds.has(tabId))) {
      return help;
    }
  }
  return null;
}

async function findHelpForTab(
  tabId: number,
  deps: RequestHelpDeps,
): Promise<ActiveHelpRequest | null> {
  const direct = findHelpByKnownTabId(tabId);
  if (direct) return direct;

  try {
    const tab = await deps.tabsApi.get(tabId);
    const windowId = tab.windowId;
    if (typeof windowId !== "number") return null;
    for (const help of activeHelpRequests.values()) {
      if (!help.settled && help.ctx.agentWindowId === windowId) return help;
    }
  } catch {
    return null;
  }
  return null;
}

function clearRearmTimer(tabId: number): void {
  const timer = helpRearmTimers.get(tabId);
  if (!timer) return;
  clearTimeout(timer);
  helpRearmTimers.delete(tabId);
}

async function sendCurrentHelpOverlay(help: ActiveHelpRequest): Promise<HelpFinishMessage | null> {
  const legacyFinish = await sendHelpRequestWithAck(
    help.primaryTabId,
    helpRequestMessage(help, help.primaryTabId),
    help.deps,
  );
  help.overlayTabIds.add(help.primaryTabId);
  return legacyFinish;
}

async function refreshAndSendHelpOverlay(
  help: ActiveHelpRequest,
  tabId: number,
): Promise<HelpFinishMessage | null> {
  if (tabId === help.primaryTabId) await refreshHelpTargets(help);
  const legacyFinish = await sendHelpRequestWithAck(
    tabId,
    helpRequestMessage(help, tabId),
    help.deps,
  );
  help.overlayTabIds.add(tabId);
  return legacyFinish;
}

async function rearmHelp(help: ActiveHelpRequest, tabId: number): Promise<boolean> {
  for (let attempt = 0; attempt < HELP_REARM_MAX_ATTEMPTS; attempt += 1) {
    try {
      const legacyFinish = await refreshAndSendHelpOverlay(help, tabId);
      if (legacyFinish && !help.settled) {
        finishHelp(help, {
          outcome: legacyFinish.outcome,
          ...(legacyFinish.note ? { note: legacyFinish.note } : {}),
          tab_id: help.primaryTabId,
          resolved_targets: help.resolvedTargets,
        });
      }
      return true;
    } catch {
      if (attempt + 1 < HELP_REARM_MAX_ATTEMPTS) await sleep(HELP_REARM_RETRY_DELAY_MS);
    }
  }
  return false;
}

function scheduleRearmForTab(tabId: number, deps: RequestHelpDeps): void {
  const existing = helpRearmTimers.get(tabId);
  if (existing) clearTimeout(existing);
  helpRearmTimers.set(
    tabId,
    setTimeout(() => {
      helpRearmTimers.delete(tabId);
      void (async () => {
        const help = await findHelpForTab(tabId, deps);
        if (!help) return;
        await rearmHelp(help, tabId);
      })();
    }, HELP_REARM_DEBOUNCE_MS),
  );
}

let detachHelpObservation: (() => void) | null = null;

export function ensureHelpLifecycleListeners(deps: RequestHelpDeps = getDefaultDeps()): void {
  if (detachHelpObservation) return;
  const detachRuntime = attachHelpRuntimeListener(deps);
  const detachTabs = attachHelpTabListener(deps);
  const detachNav = attachHelpNavigationListener(deps);
  detachHelpObservation = () => {
    detachRuntime();
    detachTabs();
    detachNav();
  };
}

export function resetHelpLifecycleForTests(): void {
  detachHelpObservation?.();
  detachHelpObservation = null;
  for (const timer of helpRearmTimers.values()) clearTimeout(timer);
  helpRearmTimers.clear();
  for (const help of activeHelpRequests.values()) {
    clearTimeout(help.timeoutTimer);
    if (help.completionTimer) clearInterval(help.completionTimer);
  }
  activeHelpRequests.clear();
}

function attachHelpRuntimeListener(deps: RequestHelpDeps): () => void {
  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: HelpQueryResponse) => void,
  ) => {
    if (isHelpFinishMessage(message)) {
      void finishHelpFromContent(message, sender, deps);
      return false;
    }

    if (isHelpQueryMessage(message)) {
      const tabId = sender.tab?.id;
      if (tabId === undefined) {
        sendResponse({ active: false });
        return false;
      }
      void (async () => {
        const help = await findHelpForTab(tabId, deps);
        if (!help) {
          sendResponse({ active: false });
          return;
        }
        if (tabId === help.primaryTabId) await refreshHelpTargets(help);
        help.overlayTabIds.add(tabId);
        sendResponse({
          active: true,
          request: {
            requestId: help.requestId,
            prompt: help.prompt,
            ...(help.title ? { title: help.title } : {}),
            displayMode: tabId === help.primaryTabId ? "full" : "compact",
            selectors: tabId === help.primaryTabId ? help.selectors : [],
            timeoutMs: help.timeoutMs,
          },
        });
      })();
      return true;
    }

    return false;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

async function finishHelpFromContent(
  message: HelpFinishMessage,
  sender: chrome.runtime.MessageSender,
  deps: RequestHelpDeps,
): Promise<void> {
  const help = activeHelpRequests.get(message.requestId);
  if (!help || help.settled) return;
  const tabId = sender.tab?.id;
  if (tabId !== undefined) {
    const match = await findHelpForTab(tabId, deps);
    if (match !== help) return;
  }
  finishHelp(
    help,
    {
      outcome: message.outcome,
      ...(message.note ? { note: message.note } : {}),
      tab_id: help.primaryTabId,
      resolved_targets: help.resolvedTargets,
    },
    false,
  );
}

function attachHelpTabListener(deps: RequestHelpDeps): () => void {
  const onCreated = (tab: chrome.tabs.Tab) => {
    if (typeof tab.id !== "number") return;
    scheduleRearmForTab(tab.id, deps);
  };
  const onActivated = (activeInfo: chrome.tabs.TabActiveInfo) => {
    scheduleRearmForTab(activeInfo.tabId, deps);
  };
  chrome.tabs.onCreated?.addListener(onCreated);
  chrome.tabs.onActivated?.addListener(onActivated);
  return () => {
    chrome.tabs.onCreated?.removeListener(onCreated);
    chrome.tabs.onActivated?.removeListener(onActivated);
  };
}

function attachHelpNavigationListener(deps: RequestHelpDeps): () => void {
  const onMainFrameComplete = (tabId: number) => scheduleRearmForTab(tabId, deps);

  if (chrome.webNavigation?.onCompleted) {
    const completedListener = (
      details: chrome.webNavigation.WebNavigationFramedCallbackDetails,
    ) => {
      if (details.frameId !== 0) return;
      onMainFrameComplete(details.tabId);
    };
    chrome.webNavigation.onCompleted.addListener(completedListener);
    return () => chrome.webNavigation.onCompleted.removeListener(completedListener);
  }

  const listener = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
    if (info.status !== "complete") return;
    onMainFrameComplete(tabId);
  };
  chrome.tabs.onUpdated?.addListener(listener);
  return () => chrome.tabs.onUpdated?.removeListener(listener);
}

async function evaluateCompletionCondition(
  condition: HelpCompletionCondition,
  help: ActiveHelpRequest,
): Promise<boolean> {
  if (condition.url_contains || condition.url_matches) {
    let url = "";
    try {
      const tab = await help.deps.tabsApi.get(help.primaryTabId);
      url = tab.url ?? "";
    } catch {
      return false;
    }
    if (condition.url_contains && !url.includes(condition.url_contains)) return false;
    if (condition.url_matches) {
      try {
        if (!new RegExp(condition.url_matches).test(url)) return false;
      } catch {
        return false;
      }
    }
  }

  if (
    condition.selector_exists ||
    condition.selector_missing ||
    condition.text_exists ||
    condition.text_missing
  ) {
    if (!help.deps.cdp) return false;
    const expression = `(() => {
      const selectorExists = ${JSON.stringify(condition.selector_exists ?? null)};
      const selectorMissing = ${JSON.stringify(condition.selector_missing ?? null)};
      const textExists = ${JSON.stringify(condition.text_exists ?? null)};
      const textMissing = ${JSON.stringify(condition.text_missing ?? null)};
      if (selectorExists && !document.querySelector(selectorExists)) return false;
      if (selectorMissing && document.querySelector(selectorMissing)) return false;
      const text = document.body ? document.body.innerText || "" : "";
      if (textExists && !text.includes(textExists)) return false;
      if (textMissing && text.includes(textMissing)) return false;
      return true;
    })()`;
    try {
      const result = await help.deps.cdp.send<{ result?: { value?: boolean } }>(
        help.primaryTabId,
        "Runtime.evaluate",
        { expression, returnByValue: true },
      );
      if (result.result?.value !== true) return false;
    } catch {
      return false;
    }
  }

  return true;
}

async function completionCriteriaMatches(help: ActiveHelpRequest): Promise<boolean> {
  const criteria = help.completionCriteria;
  if (!criteria) return false;
  const any = criteria.any ?? [];
  const all = criteria.all ?? [];
  const hasAny = any.length > 0;
  const hasAll = all.length > 0;
  if (!hasAny && !hasAll) return false;

  if (hasAll) {
    for (const condition of all) {
      if (!(await evaluateCompletionCondition(condition, help))) return false;
    }
  }
  if (hasAny) {
    for (const condition of any) {
      if (await evaluateCompletionCondition(condition, help)) return true;
    }
    return false;
  }
  return true;
}

function startCompletionPolling(help: ActiveHelpRequest): void {
  if (!help.completionCriteria) return;
  const stableMs = help.completionCriteria.stable_for_ms ?? DEFAULT_COMPLETION_STABLE_MS;
  const check = async () => {
    if (help.settled) return;
    const matched = await completionCriteriaMatches(help);
    const now = Date.now();
    if (!matched) {
      help.completionMatchedSince = null;
      return;
    }
    help.completionMatchedSince ??= now;
    if (now - help.completionMatchedSince < stableMs) return;
    finishHelp(help, {
      outcome: "completed",
      completed_by: "system",
      tab_id: help.primaryTabId,
      resolved_targets: help.resolvedTargets,
    });
  };
  help.completionTimer = setInterval(() => void check(), COMPLETION_POLL_MS);
  void check();
}

export async function handleRequestHelp(
  manager: SessionManager,
  params: RequestHelpParams,
  deps: RequestHelpDeps = getDefaultDeps(),
): Promise<RequestHelpResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "request_help");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  if (!params.prompt || typeof params.prompt !== "string") {
    return { code: "invalid_params", message: "request_help requires a prompt" };
  }
  if (deps.signal?.aborted) return { code: "cancelled", message: "request_help aborted" };

  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  const denied = enforceAgentWindow(ctx, target, "request_help");
  if (denied) return denied;

  if (deps.autoAttachLifecycle !== false) ensureHelpLifecycleListeners(deps);
  const tabId = target.tabId;
  const initialTargets = params.targets ?? [];
  const { selectors, resolvedTargets } = await resolveHelpTargets(ctx, tabId, initialTargets, deps);

  await deps.windows.update(target.windowId, { focused: true }).catch(() => {});
  await deps.activateTab(tabId).catch(() => {});

  const requestId = makeRequestId(tabId);
  const notificationId = `bsk-help:${requestId}`;
  const timeoutMs = params.timeout_ms ?? DEFAULT_HELP_TIMEOUT_MS;

  if (deps.notifications) {
    const copy = deps.notificationCopy ?? {
      title: "BrowserSkill: Agent needs your help",
      body: params.prompt,
    };
    await deps.notifications
      .create(notificationId, {
        type: "basic",
        iconUrl: "icon/logo.png",
        title: copy.title,
        message: copy.body || params.prompt,
        priority: 2,
      })
      .catch(() => {});
  }

  return new Promise<RequestHelpResult | RpcError>((resolve) => {
    const timeoutTimer = setTimeout(() => {
      finishHelp(help, {
        outcome: "timed_out",
        tab_id: help.primaryTabId,
        resolved_targets: help.resolvedTargets,
      });
    }, timeoutMs);

    const help: ActiveHelpRequest = {
      ctx,
      requestId,
      primaryTabId: tabId,
      overlayTabIds: new Set(),
      prompt: params.prompt,
      ...(params.title ? { title: params.title } : {}),
      targets: initialTargets,
      selectors,
      timeoutMs,
      notificationId,
      resolvedTargets,
      completionCriteria: params.completion_criteria,
      deps,
      settled: false,
      resolve,
      timeoutTimer,
      completionTimer: null,
      completionMatchedSince: null,
      abortHandler: null,
    };

    const onAbort = () => finishHelp(help, { code: "cancelled", message: "request_help aborted" });
    help.abortHandler = onAbort;
    activeHelpRequests.set(requestId, help);
    if (deps.signal?.aborted) {
      onAbort();
      return;
    }
    deps.signal?.addEventListener("abort", onAbort, { once: true });
    startCompletionPolling(help);

    void sendCurrentHelpOverlay(help)
      .then((legacyFinish) => {
        if (!legacyFinish || help.settled) return;
        finishHelp(help, {
          outcome: legacyFinish.outcome,
          ...(legacyFinish.note ? { note: legacyFinish.note } : {}),
          tab_id: help.primaryTabId,
          resolved_targets: help.resolvedTargets,
        });
      })
      .catch(() => {
        scheduleRearmForTab(tabId, deps);
      });
  });
}
