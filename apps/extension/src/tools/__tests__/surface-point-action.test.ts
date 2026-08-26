import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { CdpRunner } from "../shared";
import { captureSurfaceEnvironment, handleSurfacePointClick } from "../surface-point-action";

function fakeAgentWindow() {
  return {
    create: vi.fn(async () => 100),
    remove: vi.fn(async () => {}),
    ensureActiveTab: vi.fn(async () => {}),
  };
}

function fakeBrowser() {
  let loaderId = "loader-1";
  let pageY = 0;
  let quad = [10, 20, 110, 20, 110, 60, 10, 60];
  let dispatchFails = false;
  const sent: Array<{ method: string; params?: object }> = [];
  const cdp: CdpRunner = {
    send: vi.fn(async (_tabId: number, method: string, params?: object) => {
      sent.push({ method, params });
      if (method === "Page.getFrameTree") {
        return {
          frameTree: { frame: { id: "main", loaderId, url: "https://fixture.test/" } },
        } as never;
      }
      if (method === "Page.getLayoutMetrics") {
        return {
          cssLayoutViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY },
          cssVisualViewport: {
            clientWidth: 800,
            clientHeight: 600,
            pageX: 0,
            pageY,
            scale: 1,
          },
        } as never;
      }
      if (method === "DOM.getContentQuads") return { quads: [quad] } as never;
      if (method === "Input.dispatchMouseEvent") {
        if (dispatchFails) throw new Error("input failed");
        return {} as never;
      }
      throw new Error(`unexpected CDP call ${method}`);
    }) as CdpRunner["send"],
    trackSessionTab: vi.fn(),
  };
  const tabsApi = {
    get: vi.fn(
      async (tabId: number) => ({ id: tabId, windowId: 100, active: true }) as chrome.tabs.Tab,
    ),
    query: vi.fn(async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab]),
  };
  return {
    cdp,
    tabsApi,
    sent,
    setLoaderId: (value: string) => {
      loaderId = value;
    },
    setPageY: (value: number) => {
      pageY = value;
    },
    setQuad: (value: number[]) => {
      quad = value;
    },
    failDispatch: () => {
      dispatchFails = true;
    },
  };
}

async function setupCapture() {
  const manager = new SessionManager({ agentWindow: fakeAgentWindow() });
  const context = await manager.start("aa11");
  context.refStore.set("e3", 99, {
    tabId: 4,
    kind: "surface",
    visibleRect: { x: 10, y: 20, w: 100, h: 40 },
  });
  const browser = fakeBrowser();
  const environment = await captureSurfaceEnvironment(browser.cdp, 4, undefined);
  if ("code" in environment) throw new Error(environment.message);
  const entry = context.refStore.resolveEntry("e3");
  if (!entry) throw new Error("missing ref");
  const capture = context.surfaceCaptures.create({
    sessionId: "aa11",
    tabId: 4,
    navigationIdentity: environment.navigationIdentity,
    surface: {
      ref: "e3",
      backendNodeId: 99,
      observationGeneration: entry.generation,
    },
    topViewportRect: { x: 10, y: 20, w: 100, h: 40 },
    imageWidth: 200,
    imageHeight: 80,
    viewportSignature: environment.viewportSignature,
    frameProjectionSignature: environment.frameProjectionSignature,
  });
  return { manager, context, browser, capture };
}

function pointParams(captureId: string) {
  return {
    session_id: "aa11",
    ref: "@e3",
    capture_id: captureId,
    image_x: 50,
    image_y: 20,
  };
}

describe("Surface screenshot-bound point click", () => {
  it("maps one fresh capture coordinate and dispatches exactly one trusted click", async () => {
    const { manager, browser, capture } = await setupCapture();
    const result = await handleSurfacePointClick(manager, pointParams(capture.id), browser);

    if ("code" in result) throw new Error(JSON.stringify(result));
    expect(result).toMatchObject({
      used_ref: "e3",
      capture_id: capture.id,
      image_x: 50,
      image_y: 20,
      x: 35,
      y: 30,
    });
    expect(browser.sent.filter((call) => call.method === "Input.dispatchMouseEvent")).toHaveLength(
      3,
    );

    const repeated = await handleSurfacePointClick(manager, pointParams(capture.id), browser);
    expect(repeated).toMatchObject({
      code: "permission_denied",
      data: { reason: "surface_capture_consumed" },
    });
  });

  it("rejects a new observation generation before sending input", async () => {
    const { manager, context, browser, capture } = await setupCapture();
    context.refStore.replace([
      [
        "e3",
        {
          backendNodeId: 99,
          tabId: 4,
          kind: "surface" as const,
          visibleRect: { x: 10, y: 20, w: 100, h: 40 },
        },
      ],
    ]);

    const result = await handleSurfacePointClick(manager, pointParams(capture.id), browser);
    expect(result).toMatchObject({
      code: "permission_denied",
      data: { reason: "surface_capture_stale" },
    });
    expect(browser.sent.some((call) => call.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  it("rejects navigation, scroll, and visible geometry changes", async () => {
    for (const mutate of [
      (browser: ReturnType<typeof fakeBrowser>) => browser.setLoaderId("loader-2"),
      (browser: ReturnType<typeof fakeBrowser>) => browser.setPageY(20),
      (browser: ReturnType<typeof fakeBrowser>) =>
        browser.setQuad([11, 20, 111, 20, 111, 60, 11, 60]),
    ]) {
      const { manager, browser, capture } = await setupCapture();
      mutate(browser);
      const result = await handleSurfacePointClick(manager, pointParams(capture.id), browser);
      expect(result).toMatchObject({
        code: "permission_denied",
        data: { reason: "surface_capture_stale" },
      });
      expect(browser.sent.some((call) => call.method === "Input.dispatchMouseEvent")).toBe(false);
    }
  });

  it("consumes the capture when coordinates or input dispatch fail", async () => {
    const invalid = await setupCapture();
    const outside = await handleSurfacePointClick(
      invalid.manager,
      { ...pointParams(invalid.capture.id), image_x: 200 },
      invalid.browser,
    );
    expect(outside).toMatchObject({
      code: "invalid_params",
      data: { reason: "surface_coordinate_invalid" },
    });
    expect(
      await handleSurfacePointClick(
        invalid.manager,
        pointParams(invalid.capture.id),
        invalid.browser,
      ),
    ).toMatchObject({ data: { reason: "surface_capture_consumed" } });

    const failed = await setupCapture();
    failed.browser.failDispatch();
    expect(
      await handleSurfacePointClick(failed.manager, pointParams(failed.capture.id), failed.browser),
    ).toMatchObject({ code: "cdp_failed" });
    expect(
      await handleSurfacePointClick(failed.manager, pointParams(failed.capture.id), failed.browser),
    ).toMatchObject({ data: { reason: "surface_capture_consumed" } });
  });

  it("maps image coordinates through an OOPIF frame projection", async () => {
    const manager = new SessionManager({ agentWindow: fakeAgentWindow() });
    const context = await manager.start("aa11");
    context.refStore.set("e3", 99, {
      tabId: 4,
      frameId: "child",
      cdpSessionId: "child-session",
      kind: "surface",
      visibleRect: { x: 120, y: 110, w: 100, h: 40 },
    });
    const graph = {
      rootFrameId: "main",
      frames: [
        { frameId: "main", target: { tabId: 4 } },
        {
          frameId: "child",
          parentFrameId: "main",
          ownerBackendNodeId: 77,
          target: { tabId: 4, sessionId: "child-session" },
        },
      ],
    };
    const sent: Array<{ method: string; params?: object }> = [];
    const cdp: CdpRunner = {
      send: vi.fn(async (_tabId: number, method: string, params?: object) => {
        sent.push({ method, params });
        if (method === "Page.getFrameTree") {
          return {
            frameTree: {
              frame: { id: "main", loaderId: "loader-1", url: "https://fixture.test/" },
            },
          } as never;
        }
        if (method === "Page.getLayoutMetrics") {
          return {
            cssLayoutViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 },
            cssVisualViewport: {
              clientWidth: 800,
              clientHeight: 600,
              pageX: 0,
              pageY: 0,
              scale: 1,
            },
          } as never;
        }
        if (method === "DOM.getBoxModel") {
          return { model: { content: [100, 100, 300, 100, 300, 200, 100, 200] } } as never;
        }
        if (method === "Input.dispatchMouseEvent") return {} as never;
        throw new Error(`unexpected root CDP call ${method}`);
      }) as CdpRunner["send"],
      sendToTarget: vi.fn(async (_target, method) => {
        if (method === "DOM.getContentQuads") {
          return { quads: [[20, 10, 120, 10, 120, 50, 20, 50]] } as never;
        }
        if (method === "Page.getLayoutMetrics") {
          return { cssLayoutViewport: { clientWidth: 200, clientHeight: 100 } } as never;
        }
        throw new Error(`unexpected child CDP call ${method}`);
      }) as CdpRunner["sendToTarget"],
      getFrameGraph: vi.fn(async () => graph),
      trackSessionTab: vi.fn(),
    };
    const tabsApi = {
      get: vi.fn(async () => ({ id: 4, windowId: 100, active: true }) as chrome.tabs.Tab),
      query: vi.fn(async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab]),
    };
    const environment = await captureSurfaceEnvironment(cdp, 4, "child");
    if ("code" in environment) throw new Error(environment.message);
    const entry = context.refStore.resolveEntry("e3");
    if (!entry) throw new Error("missing ref");
    const capture = context.surfaceCaptures.create({
      sessionId: "aa11",
      tabId: 4,
      navigationIdentity: environment.navigationIdentity,
      surface: {
        ref: "e3",
        frameId: "child",
        backendNodeId: 99,
        observationGeneration: entry.generation,
      },
      topViewportRect: { x: 120, y: 110, w: 100, h: 40 },
      imageWidth: 200,
      imageHeight: 80,
      viewportSignature: environment.viewportSignature,
      frameProjectionSignature: environment.frameProjectionSignature,
    });

    const result = await handleSurfacePointClick(
      manager,
      {
        session_id: "aa11",
        ref: "@e3",
        capture_id: capture.id,
        image_x: 100,
        image_y: 40,
      },
      { cdp, tabsApi },
    );

    if ("code" in result) throw new Error(JSON.stringify(result));
    expect(result).toMatchObject({ x: 170, y: 130 });
    expect(sent.filter((call) => call.method === "Input.dispatchMouseEvent")).toHaveLength(3);
  });
});
