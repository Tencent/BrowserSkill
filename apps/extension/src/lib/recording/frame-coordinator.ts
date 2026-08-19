import {
  isRecordFrameQueryMessage,
  RECORD_FRAME_PORT,
  RECORD_FRAME_START,
  type RecordFramePortMessage,
  type RecordFrameQueryResponse,
  type RecordFrameStartMessage,
} from "./frame-bridge";

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

const RECORD_FRAME_STOP_TIMEOUT_MS = 5_000;

export interface RecordFrameCoordinatorDeps {
  getAllFrames(tabId: number): Promise<BrowserFrame[]>;
  sendToDocument(
    tabId: number,
    message: RecordFrameStartMessage,
    target: { documentId?: string; frameId?: number },
  ): Promise<unknown>;
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
  };
}

export class RecordFrameCoordinator {
  readonly #deps: RecordFrameCoordinatorDeps;
  readonly #recordings = new Map<string, ArmedRecording>();
  #attached = false;

  constructor(deps: RecordFrameCoordinatorDeps = defaultDeps()) {
    this.#deps = deps;
  }

  attach(): () => void {
    if (this.#attached) return () => {};
    this.#attached = true;
    chrome.runtime.onConnect.addListener(this.#onConnect);
    chrome.runtime.onMessage.addListener(this.#onMessage);
    return () => {
      if (!this.#attached) return;
      this.#attached = false;
      chrome.runtime.onConnect.removeListener(this.#onConnect);
      chrome.runtime.onMessage.removeListener(this.#onMessage);
      for (const recording of this.#recordings.values()) this.#cancelAgents(recording);
      this.#recordings.clear();
    };
  }

  begin(requestId: string, startedAtMs: number): void {
    const previous = this.#recordings.get(requestId);
    if (previous) this.#cancelAgents(previous);
    this.#recordings.set(requestId, {
      requestId,
      startedAtMs,
      tabIds: new Set(),
      agents: new Map(),
      finishing: false,
    });
  }

  async armTab(requestId: string, tabId: number): Promise<boolean> {
    const recording = this.#recordings.get(requestId);
    if (!recording || recording.finishing) return false;
    recording.tabIds.add(tabId);

    let frames: BrowserFrame[];
    try {
      frames = await this.#deps.getAllFrames(tabId);
    } catch {
      frames = [{ frameId: 0 }];
    }
    if (!frames.some((frame) => frame.frameId === 0)) frames.unshift({ frameId: 0 });

    const message: RecordFrameStartMessage = {
      type: RECORD_FRAME_START,
      requestId,
      startedAtMs: recording.startedAtMs,
    };
    const results = await Promise.all(
      frames.map(async (frame) => {
        try {
          const response = await this.#deps.sendToDocument(tabId, message, {
            ...(frame.documentId ? { documentId: frame.documentId } : { frameId: frame.frameId }),
          });
          return { frameId: frame.frameId, started: isStarted(response) };
        } catch {
          return { frameId: frame.frameId, started: false };
        }
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
    const commandId = crypto.randomUUID();
    const results = await Promise.all(
      [...recording.agents.values()].map((agent) => this.#stopAgent(agent, requestId, commandId)),
    );
    const succeeded = results.every(Boolean);
    if (succeeded) this.#recordings.delete(requestId);
    else recording.finishing = false;
    return succeeded;
  }

  cancel(requestId: string): void {
    const recording = this.#recordings.get(requestId);
    if (!recording) return;
    this.#cancelAgents(recording);
    this.#recordings.delete(requestId);
  }

  readonly #onMessage = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: RecordFrameQueryResponse) => void,
  ): boolean => {
    if (!isRecordFrameQueryMessage(message)) return false;
    const tabId = sender.tab?.id;
    const recording =
      typeof tabId === "number"
        ? [...this.#recordings.values()].find(
            (candidate) => !candidate.finishing && candidate.tabIds.has(tabId),
          )
        : undefined;
    sendResponse(
      recording
        ? {
            active: true,
            requestId: recording.requestId,
            startedAtMs: recording.startedAtMs,
          }
        : { active: false },
    );
    return false;
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
