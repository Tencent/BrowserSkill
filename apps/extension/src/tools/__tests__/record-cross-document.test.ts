import { afterEach, describe, expect, it, vi } from "vitest";
import { RECORD_START, RECORD_STEP } from "@/lib/record-bridge";
import {
  RECORD_FRAME_PORT,
  RECORD_FRAME_QUERY,
  RECORD_FRAME_START,
  type RecordFrameQueryResponse,
} from "@/lib/recording/frame-bridge";
import { RecordFrameCoordinator } from "@/lib/recording/frame-coordinator";
import type { SessionManager } from "@/session-manager/manager";
import type { CdpRunner } from "@/tools/shared";
import type { RecordStopResult, TraceV3 } from "@/transport/types";
import {
  attachRecordStepListener,
  handleRecordStart,
  handleRecordStop,
  resetBrowserObservationForTests,
} from "../record";

const AGENT_WINDOW_ID = 100;
const TAB_ID = 4;
const START_URL = "https://start.example/";
const NEXT_URL = "https://next.example/article";

class ListenerSet<T extends (...args: never[]) => unknown> {
  readonly listeners = new Set<T>();
  addListener = (listener: T) => this.listeners.add(listener);
  removeListener = (listener: T) => this.listeners.delete(listener);
  emit = (...args: Parameters<T>) => {
    for (const listener of [...this.listeners]) listener(...args);
  };
}

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => unknown;

function installChrome() {
  const runtimeOnMessage = new ListenerSet<RuntimeListener>();
  const runtimeOnConnect = new ListenerSet<(port: chrome.runtime.Port) => void>();
  const webNavigationOnCompleted = new ListenerSet<
    (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => unknown
  >();
  const webNavigationOnCommitted = new ListenerSet<
    (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => unknown
  >();
  vi.stubGlobal("chrome", {
    runtime: { onMessage: runtimeOnMessage, onConnect: runtimeOnConnect },
    tabs: {
      onActivated: new ListenerSet(),
      onCreated: new ListenerSet(),
      onUpdated: new ListenerSet(),
    },
    webNavigation: {
      onCompleted: webNavigationOnCompleted,
      onCommitted: webNavigationOnCommitted,
    },
  });
  return {
    runtimeOnMessage,
    runtimeOnConnect,
    webNavigationOnCompleted,
    webNavigationOnCommitted,
  };
}

function fakeManager() {
  return {
    get: (id: string) =>
      id === "abcd"
        ? {
            sessionId: "abcd",
            agentWindowId: AGENT_WINDOW_ID,
            refStore: { resolve: () => null, replace: () => {} },
            borrowedTabs: new Map(),
          }
        : null,
    findByWindowId: (windowId: number) =>
      windowId === AGENT_WINDOW_ID ? { sessionId: "abcd" } : null,
  } as unknown as SessionManager;
}

function makeFakeCdp(): CdpRunner {
  type EventListener = (source: chrome.debugger.Debuggee, method: string, params: unknown) => void;
  const events: EventListener[] = [];
  const handlers: Record<string, (params: unknown, tabId: number) => unknown> = {
    "Page.enable": () => ({}),
    "Page.setLifecycleEventsEnabled": () => ({}),
    "Page.getFrameTree": () => ({
      frameTree: { frame: { id: "frame-1", loaderId: "loader-before" } },
    }),
    "Page.navigate": () => {
      for (const listener of [...events]) {
        listener({ tabId: TAB_ID }, "Page.lifecycleEvent", {
          name: "load",
          frameId: "frame-1",
          loaderId: "loader-after",
        });
      }
      return { frameId: "frame-1", loaderId: "loader-after" };
    },
    "Page.getLayoutMetrics": () => ({
      cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 },
    }),
    "Runtime.enable": () => ({}),
    "Runtime.evaluate": (params: unknown) => {
      const expression = String((params as { expression?: string })?.expression ?? "");
      if (!expression.includes("__bskRecordQuiet")) return { result: { value: "complete" } };
      return { result: { value: { idleMs: 10_000, readyState: "complete" } } };
    },
    "Accessibility.enable": () => ({}),
    "Accessibility.getFullAXTree": () => ({
      nodes: [
        {
          nodeId: "1",
          backendDOMNodeId: 1,
          role: { type: "role", value: "RootWebArea" },
          name: { type: "computed", value: "Page" },
          childIds: ["2"],
        },
        {
          nodeId: "2",
          parentId: "1",
          backendDOMNodeId: 2,
          role: { type: "role", value: "button" },
          name: { type: "computed", value: "Menu" },
        },
      ],
    }),
  };
  return {
    send: (async (tabId: number, method: string, params: unknown) => {
      const handler = handlers[method];
      if (!handler) throw new Error(`unsupported CDP call ${method}`);
      return handler(params, tabId);
    }) as CdpRunner["send"],
    trackSessionTab: () => {},
    onEvent: (handler: EventListener) => {
      events.push(handler);
      return {
        dispose: () => {
          const index = events.indexOf(handler);
          if (index >= 0) events.splice(index, 1);
        },
      };
    },
  } as unknown as CdpRunner;
}

function makeTabsApi() {
  const tab = {
    id: TAB_ID,
    windowId: AGENT_WINDOW_ID,
    active: true,
    status: "complete",
    url: START_URL,
    title: "Start",
  } as chrome.tabs.Tab;
  return {
    get: async () => tab,
    query: async () => [tab],
    goTo(url: string, title: string) {
      Object.assign(tab, { url, title });
    },
  };
}

/**
 * One simulated content-script Document: the `record-frame` entrypoint's
 * behaviour reduced to what the background can observe.
 */
interface FakeDocument {
  documentId: string;
  frameId: number;
  producerId: string;
  started: boolean;
  requestId?: string;
  nextSequence: number;
  disconnect(): void;
}

function makeBrowser(chromeApi: ReturnType<typeof installChrome>) {
  const documents = new Map<string, FakeDocument>();
  let live: FakeDocument | null = null;

  function sender(doc: FakeDocument): chrome.runtime.MessageSender {
    return {
      tab: { id: TAB_ID, active: true },
      frameId: doc.frameId,
      documentId: doc.documentId,
    } as chrome.runtime.MessageSender;
  }

  /** The content script's `chrome.runtime.connect` + `ready` handshake. */
  function connect(doc: FakeDocument, requestId: string): void {
    const onMessage = new ListenerSet<(message: unknown) => void>();
    const onDisconnect = new ListenerSet<() => void>();
    const port = {
      name: RECORD_FRAME_PORT,
      sender: sender(doc),
      onMessage,
      onDisconnect,
      // The frame agent answers `stop` once its queued steps are delivered.
      postMessage: vi.fn((message: { type?: string; commandId?: string }) => {
        if (message.type !== "stop") return;
        queueMicrotask(() =>
          onMessage.emit({
            type: "stopped",
            requestId,
            commandId: message.commandId,
            ok: true,
          }),
        );
      }),
      disconnect: vi.fn(() => onDisconnect.emit()),
    } as unknown as chrome.runtime.Port;
    chromeApi.runtimeOnConnect.emit(port);
    onMessage.emit({ type: "ready", requestId, producerId: doc.producerId });
    doc.started = true;
    doc.requestId = requestId;
    doc.disconnect = () => onDisconnect.emit();
  }

  return {
    get live() {
      return live;
    },
    /** Create a new main-frame Document, as a cross-document navigation does. */
    navigate(documentId: string): FakeDocument {
      live?.disconnect();
      const doc: FakeDocument = {
        documentId,
        frameId: 0,
        producerId: `producer-${documentId}`,
        started: false,
        nextSequence: 1,
        disconnect: () => {},
      };
      documents.set(documentId, doc);
      live = doc;
      return doc;
    },
    /** `record-frame.content.ts` bootstrap at document_start. */
    async bootstrap(doc: FakeDocument): Promise<void> {
      let response: RecordFrameQueryResponse | undefined;
      for (const listener of [...chromeApi.runtimeOnMessage.listeners]) {
        listener({ type: RECORD_FRAME_QUERY }, sender(doc), (value) => {
          response = value as RecordFrameQueryResponse;
        });
      }
      if (response?.active && response.requestId) connect(doc, response.requestId);
    },
    /** `chrome.tabs.sendMessage(tabId, RECORD_FRAME_START, {documentId})`. */
    async deliverFrameStart(
      target: { documentId?: string; frameId?: number },
      requestId: string,
    ): Promise<unknown> {
      const doc = target.documentId
        ? documents.get(target.documentId)
        : [...documents.values()].find((d) => d === live && d.frameId === target.frameId);
      if (!doc || doc !== live) throw new Error("no receiving end");
      if (doc.started && doc.requestId === requestId) return { ok: true };
      connect(doc, requestId);
      return { ok: true };
    },
    /** A captured user action leaving the live Document. */
    emitStep(doc: FakeDocument, requestId: string, step: unknown): unknown {
      const sequence = doc.nextSequence;
      doc.nextSequence += 1;
      let ack: unknown;
      for (const listener of [...chromeApi.runtimeOnMessage.listeners]) {
        listener(
          { type: RECORD_STEP, requestId, producerId: doc.producerId, sequence, step },
          sender(doc),
          (value) => {
            ack = value;
          },
        );
      }
      return ack;
    },
    frames(): { frameId: number; documentId?: string }[] {
      return live ? [{ frameId: live.frameId, documentId: live.documentId }] : [{ frameId: 0 }];
    },
  };
}

function clickStep(url: string, name: string) {
  return {
    op: "click",
    page_url: url,
    target: { role: "button", name, tag: "button" },
    geometry: { rect: { x: 0, y: 0, w: 10, h: 10 }, tag: "button" },
  };
}

describe("recording survives a main-frame navigation", () => {
  afterEach(() => {
    resetBrowserObservationForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps capturing clicks in the Document that replaced the start page", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const browser = makeBrowser(chromeApi);

    const coordinator = new RecordFrameCoordinator({
      getAllFrames: async () => browser.frames(),
      sendToDocument: (_tabId, message, target) =>
        browser.deliverFrameStart(target, message.requestId),
      subscribeFrameNavigation: () => () => {},
    });
    coordinator.attach();

    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });

    const deps = { tabsApi, sendToTab, cdp: makeFakeCdp(), frameCoordinator: coordinator };
    // The start page's Document exists before record_start arms the tab.
    const first = browser.navigate("doc-1");
    const started = await handleRecordStart(
      manager,
      { session_id: "abcd", url: START_URL, trace_version: 3 as const },
      deps,
    );
    expect(started).toEqual({ tab_id: TAB_ID, recording: true });
    expect(first.started).toBe(true);

    attachRecordStepListener(deps);

    expect(browser.emitStep(first, requestId, clickStep(START_URL, "Search"))).toEqual({
      ok: true,
      sequence: 1,
    });

    // The click navigates: a fresh Document replaces the old one, the old port
    // drops, and the browser reports the main-frame load.
    tabsApi.goTo(NEXT_URL, "Article");
    const second = browser.navigate("doc-2");
    await browser.bootstrap(second);
    chromeApi.webNavigationOnCommitted.emit({
      tabId: TAB_ID,
      frameId: 0,
      url: NEXT_URL,
      transitionType: "link",
      transitionQualifiers: [],
    } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    chromeApi.webNavigationOnCompleted.emit({
      tabId: TAB_ID,
      frameId: 0,
      url: NEXT_URL,
    } as unknown as chrome.webNavigation.WebNavigationFramedCallbackDetails);
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(second.started).toBe(true);
    expect(browser.emitStep(second, requestId, clickStep(NEXT_URL, "Menu"))).toEqual({
      ok: true,
      sequence: 1,
    });

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, deps);
    const trace = (stopped as RecordStopResult).trace as TraceV3;
    expect(trace.steps.map((step) => step.op)).toEqual(["click", "navigate", "click"]);
  }, 20_000);
  it("arms the new Document from the navigation listener when its own query is lost", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const browser = makeBrowser(chromeApi);

    const coordinator = new RecordFrameCoordinator({
      getAllFrames: async () => browser.frames(),
      sendToDocument: (_tabId, message, target) =>
        browser.deliverFrameStart(target, message.requestId),
      subscribeFrameNavigation: () => () => {},
    });
    coordinator.attach();

    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });

    const deps = { tabsApi, sendToTab, cdp: makeFakeCdp(), frameCoordinator: coordinator };
    browser.navigate("doc-1");
    await handleRecordStart(
      manager,
      { session_id: "abcd", url: START_URL, trace_version: 3 as const },
      deps,
    );
    attachRecordStepListener(deps);

    // A service worker that was asleep at document_start loses the query, so
    // the Document never bootstraps itself.
    tabsApi.goTo(NEXT_URL, "Article");
    const second = browser.navigate("doc-2");
    chromeApi.webNavigationOnCompleted.emit({
      tabId: TAB_ID,
      frameId: 0,
      url: NEXT_URL,
    } as unknown as chrome.webNavigation.WebNavigationFramedCallbackDetails);
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(second.started).toBe(true);
    expect(browser.emitStep(second, requestId, clickStep(NEXT_URL, "Menu"))).toEqual({
      ok: true,
      sequence: 1,
    });

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, deps);
    const trace = (stopped as RecordStopResult).trace as TraceV3;
    expect(trace.steps.map((step) => step.op)).toEqual(["navigate", "click"]);
  }, 20_000);
});
