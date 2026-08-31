import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { CdpRunner } from "../shared";
import {
  captureSurfaceEnvironment,
  resolveSurfacePointerTarget,
  SURFACE_POINTER_MOVE_SETTLE_MS,
} from "../surface-target";

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
      throw new Error(`unexpected CDP call ${method}`);
    }) as CdpRunner["send"],
    trackSessionTab: vi.fn(),
  };
  return {
    cdp,
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
    ref: "@e3",
    captureId,
    imageX: 50,
    imageY: 20,
  };
}

describe("Surface screenshot-bound pointer target", () => {
  it("maps one fresh capture coordinate without executing an action", async () => {
    const { context, browser, capture } = await setupCapture();
    const result = await resolveSurfacePointerTarget(
      context,
      { tabId: 4 },
      pointParams(capture.id),
      { cdp: browser.cdp },
    );

    if ("code" in result) throw new Error(JSON.stringify(result));
    expect(result).toMatchObject({
      usedRef: "e3",
      point: { x: 35, y: 30 },
      moveSettleMs: SURFACE_POINTER_MOVE_SETTLE_MS,
      capture: { id: capture.id, imageX: 50, imageY: 20 },
    });
    expect(browser.sent.some((call) => call.method === "Input.dispatchMouseEvent")).toBe(false);

    const repeated = await resolveSurfacePointerTarget(
      context,
      { tabId: 4 },
      pointParams(capture.id),
      { cdp: browser.cdp },
    );
    expect(repeated).toMatchObject({
      code: "permission_denied",
      data: { reason: "surface_capture_consumed" },
    });
  });

  it("rejects a new observation generation before sending input", async () => {
    const { context, browser, capture } = await setupCapture();
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

    const result = await resolveSurfacePointerTarget(
      context,
      { tabId: 4 },
      pointParams(capture.id),
      { cdp: browser.cdp },
    );
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
      const { context, browser, capture } = await setupCapture();
      mutate(browser);
      const result = await resolveSurfacePointerTarget(
        context,
        { tabId: 4 },
        pointParams(capture.id),
        { cdp: browser.cdp },
      );
      expect(result).toMatchObject({
        code: "permission_denied",
        data: { reason: "surface_capture_stale" },
      });
      expect(browser.sent.some((call) => call.method === "Input.dispatchMouseEvent")).toBe(false);
    }
  });

  it("consumes the capture when coordinate validation fails", async () => {
    const invalid = await setupCapture();
    const outside = await resolveSurfacePointerTarget(
      invalid.context,
      { tabId: 4 },
      { ...pointParams(invalid.capture.id), imageX: 200 },
      { cdp: invalid.browser.cdp },
    );
    expect(outside).toMatchObject({
      code: "invalid_params",
      data: { reason: "surface_coordinate_invalid" },
    });
    expect(
      await resolveSurfacePointerTarget(
        invalid.context,
        { tabId: 4 },
        pointParams(invalid.capture.id),
        { cdp: invalid.browser.cdp },
      ),
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

    const result = await resolveSurfacePointerTarget(
      context,
      { tabId: 4 },
      {
        ref: "@e3",
        captureId: capture.id,
        imageX: 100,
        imageY: 40,
      },
      { cdp },
    );

    if ("code" in result) throw new Error(JSON.stringify(result));
    expect(result).toMatchObject({ point: { x: 170, y: 130 } });
    expect(sent.some((call) => call.method === "Input.dispatchMouseEvent")).toBe(false);
  });
});
