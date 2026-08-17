import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RECORD_FINISH,
  RECORD_QUERY,
  RECORD_START,
  RECORD_STEP,
  RECORD_STOP,
} from "@/lib/record-bridge";
import { resetStateIdCounterForTests } from "@/lib/trace-reducer";
import type { SessionManager } from "@/session-manager/manager";
import type { CdpRunner } from "@/tools/shared";
import { EXTENSION_VERSION } from "@/transport/handshake";
import type { RecordedTrace, RecordStopResult, TraceV3 } from "@/transport/types";
import {
  attachRecordFinishListener,
  attachRecordQueryListener,
  attachRecordStepListener,
  handleRecordStart,
  handleRecordStop,
  resetBrowserObservationForTests,
} from "../record";

const AGENT_WINDOW_ID = 100;
const TAB_ID = 4;
const START_URL = "https://example.com/";
const RECORD_START_V3 = { session_id: "abcd", url: START_URL, trace_version: 3 as const };

function asTraceV3(trace: RecordedTrace): TraceV3 {
  if (!("version" in trace)) {
    throw new Error("expected v3 trace");
  }
  return trace;
}

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => unknown;

function chromeEvent<T extends (...args: never[]) => unknown>() {
  const listeners = new Set<T>();
  return {
    addListener: (listener: T) => {
      listeners.add(listener);
    },
    removeListener: (listener: T) => {
      listeners.delete(listener);
    },
    emit: (...args: Parameters<T>) => {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

function installChrome() {
  const runtimeOnMessage = chromeEvent<RuntimeListener>();
  const webNavigationOnCompleted =
    chromeEvent<(details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => unknown>();
  const webNavigationOnCommitted =
    chromeEvent<
      (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => unknown
    >();
  vi.stubGlobal("chrome", {
    runtime: { onMessage: runtimeOnMessage },
    tabs: {
      onActivated: chromeEvent(),
      onCreated: chromeEvent(),
      onUpdated: chromeEvent(),
    },
    webNavigation: {
      onCompleted: webNavigationOnCompleted,
      onCommitted: webNavigationOnCommitted,
    },
  });
  return { runtimeOnMessage, webNavigationOnCompleted, webNavigationOnCommitted };
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

/** One AX tree per capture; the last one repeats once the script runs out. */
function axTree(rootName: string, controls: string[] = []): unknown {
  return {
    nodes: [
      {
        nodeId: "1",
        backendDOMNodeId: 1,
        role: { type: "role", value: "RootWebArea" },
        name: { type: "computed", value: rootName },
        childIds: controls.map((_, index) => `${index + 2}`),
      },
      ...controls.map((name, index) => ({
        nodeId: `${index + 2}`,
        parentId: "1",
        backendDOMNodeId: index + 2,
        role: { type: "role", value: "button" },
        name: { type: "computed", value: name },
      })),
    ],
  };
}

type FakeCdp = CdpRunner & {
  /** Simulate captures racing a document swap. */
  setCaptureFailure(failing: boolean): void;
  /** Keep the page reporting DOM churn for this long, as a slow render would. */
  setBusyFor(ms: number): void;
};

/** Long enough that the recorder treats the page as done reacting. */
const LONG_IDLE_MS = 10_000;

/** AX-only page: DOMSnapshot calls throw so capture falls back to the AX tree. */
function makeFakeCdp(
  trees?: unknown[],
  options?: { failCaptures?: boolean; treesByTab?: Record<number, unknown> },
): FakeCdp {
  type EventListener = (source: chrome.debugger.Debuggee, method: string, params: unknown) => void;
  const events: EventListener[] = [];
  const script = [...(trees ?? [])];
  let failing = options?.failCaptures ?? false;
  let busyUntil = 0;
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
      const idleMs = Date.now() >= busyUntil ? LONG_IDLE_MS : 0;
      return { result: { value: { idleMs, readyState: "complete" } } };
    },
    "Accessibility.enable": () => ({}),
    "Accessibility.getFullAXTree": (_params, tabId) => {
      if (failing) throw new Error("Execution context was destroyed");
      const tabTree = options?.treesByTab?.[tabId];
      if (tabTree) return tabTree;
      if (script.length === 0) return axTree("Example Domain", ["Submit"]);
      return script.length === 1 ? script[0] : script.shift();
    },
  };

  return {
    send: (async (_tabId: number, method: string, params: unknown) => {
      const handler = handlers[method];
      if (!handler) throw new Error(`unsupported CDP call ${method}`);
      return handler(params, _tabId);
    }) as CdpRunner["send"],
    setCaptureFailure: (next: boolean) => {
      failing = next;
    },
    setBusyFor: (ms: number) => {
      busyUntil = Date.now() + ms;
    },
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
  };
}

function makeTabsApi() {
  const tab = {
    id: TAB_ID,
    windowId: AGENT_WINDOW_ID,
    active: true,
    status: "complete",
    url: START_URL,
    title: "Example Domain",
  } as chrome.tabs.Tab;
  return {
    get: async () => tab,
    query: async () => [tab],
    /** Mirror the browser moving the tab, so captures record the live URL. */
    goTo(url: string, title: string) {
      Object.assign(tab, { url, title });
    },
  };
}

function makeMultiTabsApi(tabs: chrome.tabs.Tab[]) {
  const byId = new Map(tabs.flatMap((tab) => (typeof tab.id === "number" ? [[tab.id, tab]] : [])));
  return {
    get: async (tabId: number) => {
      const tab = byId.get(tabId);
      if (!tab) throw new Error(`tab ${tabId} closed`);
      return tab;
    },
    query: async (query: chrome.tabs.QueryInfo) =>
      [...byId.values()].filter(
        (tab) =>
          (query.windowId === undefined || tab.windowId === query.windowId) &&
          (query.active === undefined || tab.active === query.active),
      ),
    close(tabId: number) {
      byId.delete(tabId);
    },
  };
}

/** Outlast a settle on a quiet page plus the per-tab observation cooldown. */
function settleWait(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 800));
}

function runtimeOnMessageEmit(
  chromeApi: ReturnType<typeof installChrome>,
  requestId: string,
  step: unknown,
): void {
  chromeApi.runtimeOnMessage.emit(
    { type: RECORD_STEP, requestId, step },
    { tab: { id: TAB_ID } } as chrome.runtime.MessageSender,
    () => {},
  );
}

describe("recorded user steps reach the exported trace", () => {
  afterEach(() => {
    resetBrowserObservationForTests();
    resetStateIdCounterForTests();
    vi.unstubAllGlobals();
  });

  it("keeps a click captured after start, even when the step listener has no cdp", async () => {
    const { runtimeOnMessage } = installChrome();
    const manager = fakeManager();
    const cdp = makeFakeCdp();
    const tabsApi = makeTabsApi();

    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });

    const startDeps = { tabsApi, sendToTab, cdp };
    const started = await handleRecordStart(manager, RECORD_START_V3, startDeps);
    expect(started).toEqual({ tab_id: TAB_ID, recording: true });
    expect(requestId).not.toBe("");

    // Background attaches this listener at service-worker startup, where no
    // CDP runner is available — the recording must supply its own.
    attachRecordStepListener({ tabsApi, sendToTab });

    runtimeOnMessage.emit(
      {
        type: RECORD_STEP,
        requestId,
        step: {
          op: "click",
          page_url: START_URL,
          target: { role: "button", name: "Submit", tag: "button" },
          geometry: {
            rect: { x: 0, y: 0, w: 10, h: 10 },
            scrollX: 0,
            scrollY: 0,
            position: "static",
            tag: "button",
          },
        },
      },
      { tab: { id: TAB_ID } } as chrome.runtime.MessageSender,
      () => {},
    );

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.recorder.bsk).toBe(EXTENSION_VERSION);
    expect(trace.steps).toHaveLength(1);
    const [step] = trace.steps;
    expect(step?.op).toBe("click");
    expect(step?.state).toBeTruthy();
    expect(step?.result.state).toBeTruthy();
    expect(trace.states.length).toBeGreaterThan(0);
  });

  it("keeps a fill followed by a click in recorded order", async () => {
    const { runtimeOnMessage } = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();

    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });

    await handleRecordStart(manager, RECORD_START_V3, { tabsApi, sendToTab, cdp: makeFakeCdp() });
    attachRecordStepListener({ tabsApi, sendToTab });

    const emit = (step: unknown) => {
      runtimeOnMessage.emit(
        { type: RECORD_STEP, requestId, step },
        { tab: { id: TAB_ID } } as chrome.runtime.MessageSender,
        () => {},
      );
    };

    emit({
      op: "fill",
      page_url: START_URL,
      target: { role: "textbox", name: "Search", tag: "input" },
      value: "hello",
      commit: "enter",
    });
    emit({
      op: "click",
      page_url: START_URL,
      target: { role: "button", name: "Submit", tag: "button" },
    });

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps.map((step) => step.op)).toEqual(["fill", "click"]);
    expect(trace.steps.map((step) => step.id)).toEqual([1, 2]);
    for (const step of trace.steps) {
      expect(step.state).toBeTruthy();
      expect(step.result.state).toBeTruthy();
    }
  });

  it("keeps a browser-observed navigation as a step", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async () => ({ ok: true }));

    await handleRecordStart(manager, RECORD_START_V3, { tabsApi, sendToTab, cdp: makeFakeCdp() });

    const destination = "https://example.com/next";
    chromeApi.webNavigationOnCommitted.emit({
      tabId: TAB_ID,
      frameId: 0,
      url: destination,
      transitionType: "link",
      transitionQualifiers: [],
    } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    // Let findRecordingForTab's tab lookup and the settle capture resolve.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps).toHaveLength(1);
    const [step] = trace.steps;
    expect(step?.op).toBe("navigate");
    expect(step?.state).toBeTruthy();
    expect(step?.result.state).toBeTruthy();
  });

  it("reports an address-bar navigation from the page it started on, not the redirect hop", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp: makeFakeCdp([
        axTree("Example Domain", ["Learn more"]),
        axTree("腾讯 iWiki"),
        axTree("工作台 - 腾讯iWiki", ["文档C+D"]),
      ]),
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    const commit = (url: string, transitionType: string) => {
      chromeApi.webNavigationOnCommitted.emit({
        tabId: TAB_ID,
        frameId: 0,
        url,
        transitionType,
        transitionQualifiers: [],
      } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    };

    // Typed https://iwiki.woa.com/ in the address bar; the site bounces to
    // /dashboard, so the bare host is a hop the flow never acts on.
    tabsApi.goTo("https://iwiki.woa.com/", "腾讯 iWiki");
    commit("https://iwiki.woa.com/", "typed");
    await settleWait();

    tabsApi.goTo("https://iwiki.woa.com/dashboard", "工作台 - 腾讯iWiki");
    commit("https://iwiki.woa.com/dashboard", "link");
    await settleWait();

    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: "https://iwiki.woa.com/dashboard",
      target: { role: "button", name: "文档C+D", tag: "button" },
    });

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.states.map((state) => state.url)).toEqual([
      START_URL,
      "https://iwiki.woa.com/dashboard",
    ]);
    expect(trace.states.map((state) => state.id)).toEqual(["s1", "s2"]);
    expect(trace.steps[0]).toMatchObject({
      op: "navigate",
      id: 1,
      state: "s1",
      result: { state: "s2" },
      to: "https://iwiki.woa.com/dashboard",
      cause: "user_typed",
    });
    expect(trace.steps[1]).toMatchObject({ op: "click", id: 2, state: "s2" });
    // The dashboard page lists the click performed on it, numbered as shipped.
    expect(trace.states[1]?.body).toContain("steps_here: [2]");
  }, 15_000);

  it("coalesces OAuth redirect hops into one navigate so the next click binds to the landing page", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    const loginUrl = "https://passport.example/login";
    const callbackUrl = "https://passport.example/callback";
    const dashboardUrl = "https://app.example/dashboard";

    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp: makeFakeCdp([
        axTree("Example Domain"),
        axTree("OA登录", ["发起验证"]),
        axTree("工作台", ["新建"]),
        axTree("工作台", ["新建", "文档"]),
      ]),
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    const commit = (url: string, transitionType: string, transitionQualifiers: string[] = []) => {
      chromeApi.webNavigationOnCommitted.emit({
        tabId: TAB_ID,
        frameId: 0,
        url,
        transitionType,
        transitionQualifiers,
      } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    };

    tabsApi.goTo(loginUrl, "OA登录");
    commit(loginUrl, "link");
    await settleWait();

    // Phone / IdP confirmation comes back as a redirect chain — intermediate
    // hops must not leave lastSettled stuck on the login page.
    tabsApi.goTo(callbackUrl, "OA登录");
    commit(callbackUrl, "link", ["server_redirect"]);
    tabsApi.goTo(dashboardUrl, "工作台");
    commit(dashboardUrl, "link", ["client_redirect"]);
    await settleWait();

    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: dashboardUrl,
      target: { role: "button", name: "新建", tag: "button" },
    });
    await settleWait();

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    // Login → dashboard may collapse into one navigate in the reducer; what
    // matters is the click is bound to the dashboard observation, not login.
    const click = trace.steps.find((step) => step.op === "click");
    expect(click).toMatchObject({
      op: "click",
      target: { role: "button", name: "新建" },
    });
    const clickState = trace.states.find((state) => state.id === click?.state);
    expect(clickState?.url).toBe(dashboardUrl);
    expect(trace.steps.some((step) => step.op === "navigate" && step.to === dashboardUrl)).toBe(
      true,
    );
  }, 15_000);

  it("keeps the final action when recording stops before it has settled", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp: makeFakeCdp([axTree("编辑", ["发布"]), axTree("已发布")]),
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    // Click 发布, the page navigates to the published doc, and the user hits
    // finish immediately — no time for the post-action capture to land.
    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "button", name: "发布", tag: "button" },
      expects_navigation: true,
    });
    tabsApi.goTo("https://example.com/published", "已发布");
    chromeApi.webNavigationOnCommitted.emit({
      tabId: TAB_ID,
      frameId: 0,
      url: "https://example.com/published",
      transitionType: "link",
      transitionQualifiers: [],
    } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps.map((step) => step.op)).toEqual(["click"]);
    expect(trace.steps[0]).toMatchObject({ target: { name: "发布" } });
  }, 15_000);

  it("keeps an action whose post-action capture keeps failing", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    // Only the initial observation succeeds; every later capture throws.
    const cdp = makeFakeCdp([axTree("编辑", ["发布"])]);
    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp,
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "button", name: "发布", tag: "button" },
      expects_navigation: true,
    });
    cdp.setCaptureFailure(true);
    await settleWait();

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    // No post-action observation exists anywhere, but the action still happened.
    expect(trace.steps.map((step) => step.op)).toEqual(["click"]);
    expect(trace.steps[0]?.state).toBe("s1");
    expect(trace.steps[0]?.result.state).toBe("s1");
  }, 15_000);

  it("retries a post-action capture that lost its execution context", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    const cdp = makeFakeCdp([axTree("编辑", ["发布"]), axTree("已发布", ["编辑"])]);
    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp,
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "button", name: "发布", tag: "button" },
      expects_navigation: true,
    });
    // The document swaps while the settle capture runs, then the published
    // page becomes available.
    cdp.setCaptureFailure(true);
    tabsApi.goTo("https://example.com/published", "已发布");
    setTimeout(() => cdp.setCaptureFailure(false), 450);
    await settleWait();

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps.map((step) => step.op)).toEqual(["click"]);
    expect(trace.steps[0]?.result.state).toBe("s2");
    expect(trace.states[1]?.url).toBe("https://example.com/published");
  }, 15_000);

  it("settles a still-unsettled action against the page as it stands at stop", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    const cdp = makeFakeCdp([axTree("编辑", ["发布"]), axTree("已发布", ["编辑"])]);
    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp,
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "button", name: "发布", tag: "button" },
      expects_navigation: true,
    });
    // Every settle attempt fails; only the page as it stands at stop is
    // readable.
    cdp.setCaptureFailure(true);
    await settleWait();
    tabsApi.goTo("https://example.com/published", "已发布");
    cdp.setCaptureFailure(false);

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps.map((step) => step.op)).toEqual(["click"]);
    expect(trace.steps[0]?.state).toBe("s1");
    expect(trace.steps[0]?.result.state).toBe("s2");
    expect(trace.states[1]?.url).toBe("https://example.com/published");
  }, 15_000);

  it("keeps the observation of an action that navigates while it settles", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    const cdp = makeFakeCdp([
      axTree("列表", ["deepsearch"]),
      axTree("分组", ["添加配置"]),
      axTree("分组 已展开", ["添加配置", "确认"]),
      axTree("停止时的页面", ["无关"]),
    ]);
    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp,
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "treeitem", name: "deepsearch", tag: "div" },
      expects_navigation: true,
    });
    // The SPA swaps the URL while the settle for that click is still waiting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    tabsApi.goTo("https://example.com/list?group=deepsearch", "分组");
    chromeApi.webNavigationOnCommitted.emit({
      tabId: TAB_ID,
      frameId: 0,
      url: "https://example.com/list?group=deepsearch",
      transitionType: "link",
      transitionQualifiers: [],
    } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    await settleWait();

    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: "https://example.com/list?group=deepsearch",
      target: { role: "button", name: "添加配置", tag: "button" },
    });
    await settleWait();

    // Whatever the page looks like when the user stops must not become the
    // landing state of an earlier step.
    tabsApi.goTo("https://example.com/elsewhere", "停止时的页面");
    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps.map((step) => step.op)).toEqual(["click", "click"]);
    const [first, second] = trace.steps;
    expect(first?.result.state).toBe(second?.state);
    const landing = trace.states.find((state) => state.id === first?.result.state);
    expect(landing?.url).toBe("https://example.com/list?group=deepsearch");
  }, 15_000);

  it("lands a mid-flow step on where the flow continued, not on the page at stop", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    const cdp = makeFakeCdp([
      axTree("列表", ["deepsearch"]),
      axTree("分组", ["添加配置"]),
      axTree("分组 已展开", ["确认"]),
      axTree("停止时的页面", ["无关"]),
    ]);
    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp,
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    // First click: its own settle never produces an observation.
    cdp.setCaptureFailure(true);
    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "treeitem", name: "deepsearch", tag: "div" },
    });
    await settleWait();

    // The flow visibly continues on the group page, which is therefore where
    // the first click landed.
    cdp.setCaptureFailure(false);
    tabsApi.goTo("https://example.com/list?group=deepsearch", "分组");
    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: "https://example.com/list?group=deepsearch",
      target: { role: "button", name: "添加配置", tag: "button" },
    });
    await settleWait();

    tabsApi.goTo("https://example.com/elsewhere", "停止时的页面");
    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps.map((step) => step.op)).toEqual(["click", "click"]);
    const [first, second] = trace.steps;
    // The next step started somewhere, and that is where this one landed.
    expect(first?.result.state).toBe(second?.state);
    const landing = trace.states.find((state) => state.id === first?.result.state);
    expect(landing?.url).not.toBe("https://example.com/elsewhere");
  }, 15_000);

  it("waits for a slow page to stop changing before recording where a click landed", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    const cdp = makeFakeCdp([axTree("列表", ["打开"]), axTree("详情", ["返回"])]);
    await handleRecordStart(manager, RECORD_START_V3, { tabsApi, sendToTab, cdp });
    attachRecordStepListener({ tabsApi, sendToTab });

    // The click starts a render that runs well past any fixed settle delay.
    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "button", name: "打开", tag: "button" },
    });
    cdp.setBusyFor(900);
    setTimeout(() => tabsApi.goTo("https://example.com/detail", "详情"), 800);
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    const [step] = trace.steps;
    const landing = trace.states.find((state) => state.id === step?.result.state);
    expect(landing?.url).toBe("https://example.com/detail");
  }, 15_000);

  it("lets the next action end a settle that is still waiting on the page", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    const cdp = makeFakeCdp([
      axTree("编辑器 弹窗", ["输入标题", "确定"]),
      axTree("编辑器", ["发布"]),
    ]);
    await handleRecordStart(manager, RECORD_START_V3, { tabsApi, sendToTab, cdp });
    attachRecordStepListener({ tabsApi, sendToTab });

    // Typing keeps the page busy, so the fill has not settled when the user
    // confirms the dialog — the confirmation closes it and changes the page.
    cdp.setBusyFor(600);
    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "fill",
      page_url: START_URL,
      target: { role: "textbox", name: "输入标题", tag: "input" },
      value: "标题",
      commit: "blur",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "button", name: "确定", tag: "button" },
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps.map((step) => step.op)).toEqual(["fill", "click"]);
    const [fill, click] = trace.steps;
    // The fill cannot land on a page that only exists because of the click.
    expect(fill?.result.state).toBe(click?.state);
    expect(click?.result.state).not.toBe(click?.state);
  }, 15_000);

  it("ignores a capture that yields no step instead of rewriting the previous one", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    let requestId = "";

    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp: makeFakeCdp([
        axTree("Example Domain", ["Submit"]),
        axTree("Loading"),
        axTree("Done", ["Next"]),
      ]),
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "button", name: "Submit", tag: "button" },
      expects_navigation: true,
    });
    // Let the click settle on the page it led to, so the current observation
    // is no longer the page the click happened on.
    tabsApi.goTo("https://example.com/next", "Done");
    await settleWait();

    // A click on an element the capture cannot name produces no step at all.
    runtimeOnMessageEmit(chromeApi, requestId, { op: "click", page_url: START_URL });

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0]).toMatchObject({
      op: "click",
      state: "s1",
      result: { state: "s2" },
      target: { name: "Submit" },
    });
    expect(trace.states.map((state) => state.url)).toEqual([START_URL, "https://example.com/next"]);
  }, 15_000);

  it("flushes content capture before draining the final recorded action", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      if (typed.type === RECORD_STOP) {
        runtimeOnMessageEmit(chromeApi, requestId, {
          op: "fill",
          page_url: START_URL,
          target: { role: "textbox", name: "Draft", tag: "input" },
          value: "saved at stop",
          commit: "blur",
        });
      }
      return { ok: true };
    });

    await handleRecordStart(manager, RECORD_START_V3, { tabsApi, sendToTab, cdp: makeFakeCdp() });
    attachRecordStepListener({ tabsApi, sendToTab });

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps).toEqual([expect.objectContaining({ op: "fill", value: "saved at stop" })]);
  });

  it("drains a redirect landing when stop begins during coalescing", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    const sendToTab = vi.fn(async () => ({ ok: true }));
    const intermediateUrl = "https://idp.example/callback";
    const finalUrl = "https://app.example/home";

    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp: makeFakeCdp([axTree("Start"), axTree("Home")]),
    });

    tabsApi.goTo(finalUrl, "Home");
    chromeApi.webNavigationOnCommitted.emit({
      tabId: TAB_ID,
      frameId: 0,
      url: intermediateUrl,
      transitionType: "link",
      transitionQualifiers: ["server_redirect"],
    } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    await Promise.resolve();

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;

    expect(trace.steps).toEqual([expect.objectContaining({ op: "navigate", to: finalUrl })]);
  }, 15_000);

  it("registers a settled action capture under the live final URL", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    const intermediateUrl = "https://example.com/loading";
    const finalUrl = "https://example.com/result";

    await handleRecordStart(manager, RECORD_START_V3, {
      tabsApi,
      sendToTab,
      cdp: makeFakeCdp([axTree("Search", ["Go"]), axTree("Result", ["Open"])]),
    });
    attachRecordStepListener({ tabsApi, sendToTab });

    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "button", name: "Go", tag: "button" },
      expects_navigation: true,
    });
    tabsApi.goTo(intermediateUrl, "Loading");
    chromeApi.webNavigationOnCommitted.emit({
      tabId: TAB_ID,
      frameId: 0,
      url: intermediateUrl,
      transitionType: "link",
      transitionQualifiers: [],
    } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    tabsApi.goTo(finalUrl, "Result");

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    const trace = (stopped as RecordStopResult).trace as TraceV3;
    const resultState = trace.states.find((state) => state.id === trace.steps[0]?.result.state);

    expect(resultState?.url).toBe(finalUrl);
  }, 15_000);

  it("lets a concurrent CLI stop await the browser finish winner", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    let requestId = "";
    let releaseStop!: () => void;
    const stopReleased = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let announceStop!: () => void;
    const stopStarted = new Promise<void>((resolve) => {
      announceStop = resolve;
    });
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      if (typed.type === RECORD_STOP) {
        announceStop();
        await stopReleased;
      }
      return { ok: true };
    });

    await handleRecordStart(manager, RECORD_START_V3, { tabsApi, sendToTab, cdp: makeFakeCdp() });
    attachRecordFinishListener({ tabsApi, sendToTab });
    chromeApi.runtimeOnMessage.emit(
      { type: RECORD_FINISH, requestId },
      { tab: { id: TAB_ID } } as chrome.runtime.MessageSender,
      () => {},
    );
    await stopStarted;

    const cliStop = handleRecordStop(manager, { session_id: "abcd" }, { tabsApi, sendToTab });
    releaseStop();
    const stopped = await cliStop;

    expect(asTraceV3((stopped as RecordStopResult).trace).stopped_by).toBe("user_finish");
  });

  it("retries STOP only on armed tabs whose final delivery did not ack", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const firstTab = {
      id: TAB_ID,
      windowId: AGENT_WINDOW_ID,
      active: true,
      status: "complete",
      url: START_URL,
      title: "First",
    } as chrome.tabs.Tab;
    const secondTab = {
      id: 5,
      windowId: AGENT_WINDOW_ID,
      active: false,
      status: "complete",
      url: "https://example.com/second",
      title: "Second",
    } as chrome.tabs.Tab;
    const tabsApi = makeMultiTabsApi([firstTab, secondTab]);
    const stopTabs: number[] = [];
    let secondStopAttempts = 0;
    const sendToTab = vi.fn(async (tabId: number, msg: unknown) => {
      const typed = msg as { type?: string };
      if (typed.type === RECORD_STOP) {
        stopTabs.push(tabId);
        if (tabId === 5 && secondStopAttempts++ === 0) {
          return { ok: false, error: "failed to deliver final fill" };
        }
      }
      return { ok: true };
    });
    const deps = { tabsApi, sendToTab, cdp: makeFakeCdp() };

    await handleRecordStart(manager, RECORD_START_V3, deps);
    attachRecordQueryListener(deps);
    await new Promise<void>((resolve) => {
      chromeApi.runtimeOnMessage.emit(
        { type: RECORD_QUERY },
        { tab: secondTab } as chrome.runtime.MessageSender,
        () => resolve(),
      );
    });

    const firstStop = await handleRecordStop(manager, { session_id: "abcd" }, deps);
    expect(firstStop).toMatchObject({ code: "protocol_error" });
    expect(stopTabs).toEqual([TAB_ID, 5]);

    const retry = await handleRecordStop(manager, { session_id: "abcd" }, deps);
    const retryTrace = (retry as RecordStopResult).trace;
    expect("version" in retryTrace && retryTrace.version).toBe(3);
    expect(stopTabs).toEqual([TAB_ID, 5, 5]);
  });

  it("defaults to trace v2 when trace_version is omitted", async () => {
    const { runtimeOnMessage } = installChrome();
    const manager = fakeManager();
    const tabsApi = makeTabsApi();
    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    const deps = { tabsApi, sendToTab, cdp: makeFakeCdp() };

    await handleRecordStart(manager, { session_id: "abcd", url: START_URL }, deps);
    attachRecordStepListener(deps);
    runtimeOnMessage.emit(
      {
        type: RECORD_STEP,
        requestId,
        step: {
          op: "click",
          page_url: START_URL,
          target: { role: "button", name: "Submit", tag: "button" },
        },
      },
      { tab: { id: TAB_ID } } as chrome.runtime.MessageSender,
      () => {},
    );

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, deps);
    const trace = (stopped as RecordStopResult).trace;
    expect("version" in trace).toBe(false);
    expect("pages" in trace && trace.pages.length).toBeGreaterThan(0);
  });

  it("rejects unsupported trace_version values", async () => {
    const manager = fakeManager();
    const result = await handleRecordStart(
      manager,
      { session_id: "abcd", url: START_URL, trace_version: 99 },
      { tabsApi: makeTabsApi(), sendToTab: vi.fn(), cdp: makeFakeCdp() },
    );
    expect(result).toMatchObject({ code: "invalid_params" });
  });

  it("does not let a closed armed tab block finish", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const firstTab = {
      id: TAB_ID,
      windowId: AGENT_WINDOW_ID,
      active: true,
      status: "complete",
      url: START_URL,
    } as chrome.tabs.Tab;
    const secondTab = {
      id: 5,
      windowId: AGENT_WINDOW_ID,
      active: false,
      status: "complete",
      url: "https://example.com/second",
    } as chrome.tabs.Tab;
    const tabsApi = makeMultiTabsApi([firstTab, secondTab]);
    const stopTabs: number[] = [];
    const sendToTab = vi.fn(async (tabId: number, msg: unknown) => {
      if ((msg as { type?: string }).type === RECORD_STOP) stopTabs.push(tabId);
      return { ok: true };
    });
    const deps = { tabsApi, sendToTab, cdp: makeFakeCdp() };

    await handleRecordStart(manager, RECORD_START_V3, deps);
    attachRecordQueryListener(deps);
    await new Promise<void>((resolve) => {
      chromeApi.runtimeOnMessage.emit(
        { type: RECORD_QUERY },
        { tab: secondTab } as chrome.runtime.MessageSender,
        () => resolve(),
      );
    });
    tabsApi.close(5);

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, deps);

    const stoppedTrace = (stopped as RecordStopResult).trace;
    expect("version" in stoppedTrace && stoppedTrace.version).toBe(3);
    expect(stopTabs).toEqual([TAB_ID]);
  });

  it("waits for an acknowledged in-flight rearm before stopping armed tabs", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const firstTab = {
      id: TAB_ID,
      windowId: AGENT_WINDOW_ID,
      active: true,
      status: "complete",
      url: START_URL,
    } as chrome.tabs.Tab;
    const secondTab = {
      id: 5,
      windowId: AGENT_WINDOW_ID,
      active: false,
      status: "complete",
      url: "https://example.com/second",
    } as chrome.tabs.Tab;
    const tabsApi = makeMultiTabsApi([firstTab, secondTab]);
    let releaseSecondStart!: () => void;
    const secondStartGate = new Promise<void>((resolve) => {
      releaseSecondStart = resolve;
    });
    let announceSecondStart!: () => void;
    const secondStartBegan = new Promise<void>((resolve) => {
      announceSecondStart = resolve;
    });
    const stopTabs: number[] = [];
    const sendToTab = vi.fn(async (tabId: number, msg: unknown) => {
      const type = (msg as { type?: string }).type;
      if (type === RECORD_START && tabId === 5) {
        announceSecondStart();
        await secondStartGate;
      }
      if (type === RECORD_STOP) stopTabs.push(tabId);
      return { ok: true };
    });
    const deps = { tabsApi, sendToTab, cdp: makeFakeCdp() };

    await handleRecordStart(manager, RECORD_START_V3, deps);
    attachRecordQueryListener(deps);
    chromeApi.runtimeOnMessage.emit(
      { type: RECORD_QUERY },
      { tab: secondTab } as chrome.runtime.MessageSender,
      () => {},
    );
    await secondStartBegan;

    const stopping = handleRecordStop(manager, { session_id: "abcd" }, deps);
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseSecondStart();
    const stopped = await stopping;

    const stoppedTrace = (stopped as RecordStopResult).trace;
    expect("version" in stoppedTrace && stoppedTrace.version).toBe(3);
    expect(stopTabs).toEqual([TAB_ID, 5]);
  });

  it("drains a navigation callback received while finish is settling", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const firstTab = {
      id: TAB_ID,
      windowId: AGENT_WINDOW_ID,
      active: true,
      status: "complete",
      url: START_URL,
      title: "Editor",
    } as chrome.tabs.Tab;
    const secondUrl = "https://example.com/late-navigation";
    const secondTab = {
      id: 5,
      windowId: AGENT_WINDOW_ID,
      active: false,
      status: "complete",
      url: secondUrl,
      title: "Late page",
    } as chrome.tabs.Tab;
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const baseTabsApi = makeMultiTabsApi([firstTab, secondTab]);
    const tabsApi = {
      ...baseTabsApi,
      get: async (tabId: number) => {
        if (tabId === 5) await lookupGate;
        return baseTabsApi.get(tabId);
      },
    };
    const cdp = makeFakeCdp([axTree("Editor", ["Save"]), axTree("Saved")]);
    let requestId = "";
    const sendToTab = vi.fn(async (_tabId: number, msg: unknown) => {
      const typed = msg as { type?: string; requestId?: string };
      if (typed.type === RECORD_START && typed.requestId) requestId = typed.requestId;
      return { ok: true };
    });
    const deps = { tabsApi, sendToTab, cdp };

    await handleRecordStart(manager, RECORD_START_V3, deps);
    attachRecordStepListener(deps);
    runtimeOnMessageEmit(chromeApi, requestId, {
      op: "click",
      page_url: START_URL,
      target: { role: "button", name: "Save", tag: "button" },
    });

    const stopping = handleRecordStop(manager, { session_id: "abcd" }, deps);
    chromeApi.webNavigationOnCommitted.emit({
      tabId: 5,
      frameId: 0,
      url: secondUrl,
      transitionType: "link",
      transitionQualifiers: [],
    } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    const earlyStop = await Promise.race([
      stopping.then((result) => ({ result })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    releaseLookup();
    const stopped = earlyStop?.result ?? (await stopping);
    const trace = asTraceV3((stopped as RecordStopResult).trace);

    expect(trace.steps.some((step) => step.op === "navigate" && step.to === secondUrl)).toBe(true);
    const navigation = trace.steps.find((step) => step.op === "navigate" && step.to === secondUrl);
    expect(navigation?.result.state).toBeTruthy();
  }, 15_000);

  it("captures a new-tab navigation from the emitting tab", async () => {
    const chromeApi = installChrome();
    const manager = fakeManager();
    const firstTab = {
      id: TAB_ID,
      windowId: AGENT_WINDOW_ID,
      active: true,
      status: "complete",
      url: START_URL,
      title: "Old tab",
    } as chrome.tabs.Tab;
    const secondUrl = "https://example.com/new-tab";
    const secondTab = {
      id: 5,
      windowId: AGENT_WINDOW_ID,
      active: false,
      status: "complete",
      url: secondUrl,
      title: "New tab",
    } as chrome.tabs.Tab;
    const tabsApi = makeMultiTabsApi([firstTab, secondTab]);
    const cdp = makeFakeCdp(undefined, {
      treesByTab: {
        [TAB_ID]: axTree("Old tab", ["Old action"]),
        5: axTree("New tab", ["New action"]),
      },
    });
    const sendToTab = vi.fn(async () => ({ ok: true }));
    const deps = { tabsApi, sendToTab, cdp };

    await handleRecordStart(manager, RECORD_START_V3, deps);
    chromeApi.webNavigationOnCommitted.emit({
      tabId: 5,
      frameId: 0,
      url: secondUrl,
      transitionType: "link",
      transitionQualifiers: [],
    } as unknown as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    await settleWait();

    const stopped = await handleRecordStop(manager, { session_id: "abcd" }, deps);
    const trace = asTraceV3((stopped as RecordStopResult).trace);
    const navigation = trace.steps.find((step) => step.op === "navigate" && step.to === secondUrl);
    const landed = trace.states.find((state) => state.id === navigation?.result.state);

    expect(landed?.url).toBe(secondUrl);
    expect(landed?.body).toContain("New tab");
    expect(landed?.body).not.toContain("Old action");
  }, 15_000);
});
