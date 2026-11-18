import { provenHiddenFrames } from "@/cooperation/hidden-frames";
import { createRandomUuid } from "../random-uuid";
import { injectRecordFrameAllFrames } from "../runtime-content-scripts";
import {
  RECORD_FRAME_PORT,
  RECORD_FRAME_START,
  type RecordFramePortMessage,
  type RecordFrameStartMessage,
} from "./frame-bridge";

export const RECORD_SUBFRAME_DEBOUNCE_MS = 50;

export interface RecordingCaptureScope {
  tabId: number;
  documentId: string;
  browserFrameId: number;
  producerId: string;
}

interface ArmedRecording {
  requestId: string;
  startedAtMs: number;
  tabIds: Set<number>;
  agents: Map<string, FrameAgent>;
  onDocumentReady?: (scope: RecordingCaptureScope) => void | Promise<void>;
  finishing: boolean;
}

interface FrameAgent extends RecordingCaptureScope {
  requestId: string;
  port: chrome.runtime.Port;
  stopWaiters: Map<string, (ok: boolean) => void>;
}

interface BrowserFrame {
  frameId: number;
  documentId?: string;
}

interface BrowserFrameNavigation extends BrowserFrame {
  tabId: number;
  lifecycle: "committed" | "completed";
}

const RECORD_FRAME_START_TIMEOUT_MS = 3_000;
const RECORD_FRAME_STOP_TIMEOUT_MS = 5_000;

export interface RecordFrameCoordinatorDeps {
  getAllFrames(tabId: number): Promise<BrowserFrame[]>;
  sendToDocument(
    tabId: number,
    message: RecordFrameStartMessage,
    target: { documentId?: string; frameId?: number },
  ): Promise<unknown>;
  ensureInjected?(tabId: number): Promise<void>;
  subscribeFrameNavigation?(listener: (frame: BrowserFrameNavigation) => void): () => void;
}

function documentKey(tabId: number, documentId: string): string {
  return `${tabId}:${documentId}`;
}

function senderAddress(
  sender: chrome.runtime.MessageSender,
): { tabId: number; documentId: string; browserFrameId: number } | null {
  const tabId = sender.tab?.id;
  const documentId = sender.documentId;
  const browserFrameId = sender.frameId;
  if (
    typeof tabId !== "number" ||
    typeof documentId !== "string" ||
    typeof browserFrameId !== "number"
  ) {
    return null;
  }
  return { tabId, documentId, browserFrameId };
}

function defaultDeps(): RecordFrameCoordinatorDeps {
  return {
    async getAllFrames(tabId) {
      return (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
    },
    sendToDocument(tabId, message, target) {
      return chrome.tabs.sendMessage(tabId, message, target);
    },
    ensureInjected(tabId) {
      return injectRecordFrameAllFrames(tabId);
    },
    subscribeFrameNavigation(listener) {
      const onCommitted = (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) =>
        listener({ ...details, lifecycle: "committed" });
      const onCompleted = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) =>
        listener({ ...details, lifecycle: "completed" });
      chrome.webNavigation.onCommitted.addListener(onCommitted);
      chrome.webNavigation.onCompleted.addListener(onCompleted);
      return () => {
        chrome.webNavigation.onCommitted.removeListener(onCommitted);
        chrome.webNavigation.onCompleted.removeListener(onCompleted);
      };
    },
  };
}

export class RecordFrameCoordinator {
  readonly #deps: RecordFrameCoordinatorDeps;
  readonly #recordings = new Map<string, ArmedRecording>();
  readonly #subframeTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly #pendingSubframeNavigations = new Map<
    number,
    Map<string, { frame: BrowserFrame; completed: boolean }>
  >();
  readonly #subframeNeedsInject = new Set<number>();
  #attached = false;
  #detachFrameNavigation: (() => void) | null = null;

  constructor(deps: RecordFrameCoordinatorDeps = defaultDeps()) {
    this.#deps = deps;
  }

  attach(): () => void {
    if (this.#attached) return () => {};
    this.#attached = true;
    chrome.runtime.onConnect.addListener(this.#onConnect);
    this.#detachFrameNavigation =
      this.#deps.subscribeFrameNavigation?.(this.#onFrameNavigation) ?? null;
    return () => {
      if (!this.#attached) return;
      this.#attached = false;
      chrome.runtime.onConnect.removeListener(this.#onConnect);
      this.#detachFrameNavigation?.();
      this.#detachFrameNavigation = null;
      this.#clearAllSubframeTimers();
      for (const recording of this.#recordings.values()) this.#cancelAgents(recording);
      this.#recordings.clear();
    };
  }

  begin(
    requestId: string,
    startedAtMs: number,
    initialTabId: number,
    onDocumentReady?: (scope: RecordingCaptureScope) => void | Promise<void>,
  ): void {
    const previous = this.#recordings.get(requestId);
    if (previous) this.#cancelAgents(previous);
    this.#recordings.set(requestId, {
      requestId,
      startedAtMs,
      tabIds: new Set([initialTabId]),
      agents: new Map(),
      ...(onDocumentReady ? { onDocumentReady } : {}),
      finishing: false,
    });
  }

  async armTab(requestId: string, tabId: number): Promise<boolean> {
    const recording = this.#recordings.get(requestId);
    if (!recording || recording.finishing) return false;
    recording.tabIds.add(tabId);
    await this.#deps.ensureInjected?.(tabId);
    if (recording.finishing || this.#recordings.get(requestId) !== recording) return false;

    let frames: BrowserFrame[];
    try {
      frames = await this.#deps.getAllFrames(tabId);
    } catch {
      frames = [{ frameId: 0 }];
    }
    if (!frames.some((frame) => frame.frameId === 0)) frames.unshift({ frameId: 0 });

    const results = await Promise.all(
      frames.map(async (frame) => {
        const started = await this.#startFrame(recording, tabId, frame);
        return { frameId: frame.frameId, started };
      }),
    );
    return results.some((result) => result.frameId === 0 && result.started);
  }

  sourceFor(
    requestId: string,
    producerId: string,
    sender: chrome.runtime.MessageSender,
  ): RecordingCaptureScope | null {
    const address = senderAddress(sender);
    const recording = this.#recordings.get(requestId);
    if (!address || !recording) return null;
    const agent = recording.agents.get(documentKey(address.tabId, address.documentId));
    if (!agent || agent.producerId !== producerId) return null;
    return {
      tabId: agent.tabId,
      documentId: agent.documentId,
      browserFrameId: agent.browserFrameId,
      producerId: agent.producerId,
    };
  }

  async stop(requestId: string): Promise<boolean> {
    const recording = this.#recordings.get(requestId);
    if (!recording) return true;
    recording.finishing = true;
    const commandId = createRandomUuid();
    const agents = [...recording.agents.values()];
    const results = await Promise.all(
      agents.map((agent) => this.#stopAgent(agent, requestId, commandId)),
    );
    let failedAgents = agents.filter((_, index) => !results[index]);
    if (
      failedAgents.length > 0 &&
      failedAgents.every((agent) => agent.browserFrameId !== 0) &&
      typeof chrome !== "undefined" &&
      typeof chrome.webNavigation?.getAllFrames === "function"
    ) {
      const byTab = new Map<number, FrameAgent[]>();
      for (const agent of failedAgents) {
        const list = byTab.get(agent.tabId) ?? [];
        list.push(agent);
        byTab.set(agent.tabId, list);
      }
      const hiddenByTab = new Map<number, Set<number>>();
      for (const [tabId, tabAgents] of byTab) {
        try {
          const allFrames = await chrome.webNavigation.getAllFrames({ tabId });
          if (!allFrames?.length) continue;
          const failedIds = new Set(tabAgents.map((agent) => agent.browserFrameId));
          const failedFrames = allFrames.filter((frame) => failedIds.has(frame.frameId));
          if (failedFrames.length > 0) {
            hiddenByTab.set(tabId, await provenHiddenFrames(tabId, allFrames, failedFrames));
          }
        } catch {
          // Unreadable frame hierarchies remain unconfirmed.
        }
      }
      failedAgents = failedAgents.filter(
        (agent) => !hiddenByTab.get(agent.tabId)?.has(agent.browserFrameId),
      );
    }
    const succeeded = failedAgents.length === 0;
    if (succeeded) {
      agents.forEach((agent, index) => {
        if (!results[index]) {
          try {
            agent.port.disconnect();
          } catch {
            // Ignore already-closed ports.
          }
        }
      });
      this.#recordings.delete(requestId);
    } else {
      recording.finishing = false;
    }
    return succeeded;
  }

  cancel(requestId: string): void {
    const recording = this.#recordings.get(requestId);
    if (!recording) return;
    for (const tabId of recording.tabIds) this.#clearSubframeTimerForTabIfIdle(tabId, requestId);
    this.#cancelAgents(recording);
    this.#recordings.delete(requestId);
  }

  #clearSubframeTimerForTabIfIdle(tabId: number, ignoringRequestId?: string): void {
    const stillActive = [...this.#recordings.values()].some(
      (candidate) =>
        candidate.requestId !== ignoringRequestId &&
        !candidate.finishing &&
        candidate.tabIds.has(tabId),
    );
    if (stillActive) return;
    const timer = this.#subframeTimers.get(tabId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#subframeTimers.delete(tabId);
    }
    this.#pendingSubframeNavigations.delete(tabId);
    this.#subframeNeedsInject.delete(tabId);
  }

  #clearAllSubframeTimers(): void {
    for (const timer of this.#subframeTimers.values()) clearTimeout(timer);
    this.#subframeTimers.clear();
    this.#pendingSubframeNavigations.clear();
    this.#subframeNeedsInject.clear();
  }

  #scheduleSubframeArm(tabId: number): void {
    const existing = this.#subframeTimers.get(tabId);
    if (existing !== undefined) clearTimeout(existing);
    this.#subframeTimers.set(
      tabId,
      setTimeout(() => {
        this.#subframeTimers.delete(tabId);
        void this.#flushSubframeArm(tabId);
      }, RECORD_SUBFRAME_DEBOUNCE_MS),
    );
  }

  async #flushSubframeArm(tabId: number): Promise<void> {
    const needsInject = this.#subframeNeedsInject.delete(tabId);
    const pendingNavs = this.#pendingSubframeNavigations.get(tabId);
    this.#pendingSubframeNavigations.delete(tabId);
    const activeRecordings = [...this.#recordings.values()].filter(
      (candidate) => !candidate.finishing && candidate.tabIds.has(tabId),
    );
    if (activeRecordings.length === 0) return;

    if (needsInject) {
      await this.#deps.ensureInjected?.(tabId);
    }

    let discovered: BrowserFrame[] = [];
    try {
      discovered = (await this.#deps.getAllFrames(tabId)).filter((frame) => frame.frameId !== 0);
    } catch {
      discovered = [];
    }

    const targets = new Map<string, { frame: BrowserFrame; completed: boolean }>();
    for (const frame of discovered) {
      const key = frame.documentId ?? `frame:${frame.frameId}`;
      targets.set(key, { frame, completed: false });
    }
    if (pendingNavs) {
      for (const [key, entry] of pendingNavs) {
        const current = targets.get(key);
        targets.set(key, {
          frame: current?.frame ?? entry.frame,
          completed: Boolean(current?.completed || entry.completed),
        });
      }
    }

    for (const recording of activeRecordings) {
      if (recording.finishing) continue;
      await Promise.all(
        [...targets.values()].map(async ({ frame, completed }) => {
          const docKey = frame.documentId ? documentKey(tabId, frame.documentId) : null;
          const alreadyRegistered = docKey ? recording.agents.has(docKey) : false;
          const started = await this.#startFrame(recording, tabId, frame);
          if (!started || recording.finishing) return;
          if (!completed && !(needsInject && !alreadyRegistered)) return;
          const agent = frame.documentId
            ? recording.agents.get(documentKey(tabId, frame.documentId))
            : [...recording.agents.values()].find(
                (candidate) =>
                  candidate.tabId === tabId && candidate.browserFrameId === frame.frameId,
              );
          if (!agent) return;
          await recording.onDocumentReady?.({
            tabId: agent.tabId,
            documentId: agent.documentId,
            browserFrameId: agent.browserFrameId,
            producerId: agent.producerId,
          });
        }),
      );
    }
  }

  readonly #onFrameNavigation = (frame: BrowserFrameNavigation): void => {
    const activeRecordings = [...this.#recordings.values()].filter(
      (candidate) => !candidate.finishing && candidate.tabIds.has(frame.tabId),
    );
    if (activeRecordings.length === 0) return;

    if (frame.frameId === 0) {
      for (const recording of activeRecordings) {
        void this.#startFrame(recording, frame.tabId, frame);
      }
      return;
    }

    let pendingForTab = this.#pendingSubframeNavigations.get(frame.tabId);
    if (!pendingForTab) {
      pendingForTab = new Map();
      this.#pendingSubframeNavigations.set(frame.tabId, pendingForTab);
    }
    const key = frame.documentId ?? `frame:${frame.frameId}`;
    const previous = pendingForTab.get(key);
    pendingForTab.set(key, {
      frame,
      completed: Boolean(previous?.completed || frame.lifecycle === "completed"),
    });
    this.#scheduleSubframeArm(frame.tabId);
  };

  readonly #onConnect = (port: chrome.runtime.Port): void => {
    if (port.name !== RECORD_FRAME_PORT) return;
    const address = senderAddress(port.sender ?? {});
    if (!address) {
      port.disconnect();
      return;
    }
    let registered: FrameAgent | null = null;
    port.onMessage.addListener((raw: unknown) => {
      const message = raw as Partial<RecordFramePortMessage>;
      if (message.type === "ready") {
        if (typeof message.requestId !== "string" || typeof message.producerId !== "string") {
          port.disconnect();
          return;
        }
        const requestId = message.requestId;
        const producerId = message.producerId;
        if (registered) {
          if (registered.requestId === requestId && registered.producerId === producerId) {
            port.postMessage({
              type: "ready_ack",
              requestId,
              producerId,
            } satisfies RecordFramePortMessage);
          } else {
            port.disconnect();
          }
          return;
        }
        const recording = this.#recordings.get(requestId);
        if (
          !recording ||
          recording.finishing ||
          !recording.tabIds.has(address.tabId) ||
          producerId.length === 0
        ) {
          port.disconnect();
          return;
        }
        const agent: FrameAgent = {
          ...address,
          requestId,
          producerId,
          port,
          stopWaiters: new Map(),
        };
        registered = agent;
        const key = documentKey(address.tabId, address.documentId);
        const previous = recording.agents.get(key);
        if (previous && previous !== agent) previous.port.disconnect();
        recording.agents.set(key, agent);
        port.postMessage({
          type: "ready_ack",
          requestId,
          producerId,
        } satisfies RecordFramePortMessage);
        return;
      }
      if (
        message.type === "subframe_added" &&
        registered &&
        message.requestId === registered.requestId
      ) {
        const recording = this.#recordings.get(registered.requestId);
        if (recording && !recording.finishing && recording.tabIds.has(registered.tabId)) {
          this.#subframeNeedsInject.add(registered.tabId);
          this.#scheduleSubframeArm(registered.tabId);
        }
        return;
      }
      if (
        message.type === "stopped" &&
        registered &&
        message.requestId === registered.requestId &&
        typeof message.commandId === "string"
      ) {
        registered.stopWaiters.get(message.commandId)?.(message.ok === true);
        registered.stopWaiters.delete(message.commandId);
      }
    });
    port.onDisconnect.addListener(() => {
      if (!registered) return;
      for (const resolve of registered.stopWaiters.values()) resolve(true);
      const recording = this.#recordings.get(registered.requestId);
      const key = documentKey(registered.tabId, registered.documentId);
      if (recording?.agents.get(key) === registered) recording.agents.delete(key);
    });
  };

  #stopAgent(agent: FrameAgent, requestId: string, commandId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        agent.stopWaiters.delete(commandId);
        resolve(false);
      }, RECORD_FRAME_STOP_TIMEOUT_MS);
      agent.stopWaiters.set(commandId, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
      try {
        agent.port.postMessage({
          type: "stop",
          requestId,
          commandId,
        } satisfies RecordFramePortMessage);
      } catch {
        clearTimeout(timer);
        agent.stopWaiters.delete(commandId);
        resolve(true);
      }
    });
  }

  async #startFrame(
    recording: ArmedRecording,
    tabId: number,
    frame: BrowserFrame,
  ): Promise<boolean> {
    const message: RecordFrameStartMessage = {
      type: RECORD_FRAME_START,
      requestId: recording.requestId,
      startedAtMs: recording.startedAtMs,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = this.#deps.sendToDocument(tabId, message, {
        ...(frame.documentId ? { documentId: frame.documentId } : { frameId: frame.frameId }),
      });
      void pending?.catch?.(() => {});
      const response = await Promise.race([
        pending,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), RECORD_FRAME_START_TIMEOUT_MS);
        }),
      ]);
      return isStarted(response);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  #cancelAgents(recording: ArmedRecording): void {
    for (const agent of recording.agents.values()) {
      try {
        agent.port.postMessage({
          type: "cancel",
          requestId: recording.requestId,
        } satisfies RecordFramePortMessage);
      } catch {
        // A destroyed Document has no remaining capture state to cancel.
      }
    }
  }
}

function isStarted(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === true;
}

export const recordFrameCoordinator = new RecordFrameCoordinator();
