import { describe, expect, it, vi } from "vitest";
import type { CdpTarget } from "@/browser-driver/frame-graph";
import { SessionManager } from "@/session-manager/manager";
import { handleClick } from "../interaction";
import { handleScreenshot } from "../observation";
import type { CdpRunner } from "../shared";
import { consumeVisualCapture, issueVisualCapture } from "../visual-capture";
import { captureVisualScreenshot, visualScreenshotScale } from "../visual-screenshot";
import { resolveVisualRegionNow, verifyVisualHit } from "../visual-target";
import type { VisualCandidate, VisualFramePath } from "../vom/visual-discovery";

const styles = {
  position: "static",
  visibility: "visible",
  opacity: "1",
  display: "block",
  "overflow-x": "visible",
  "overflow-y": "visible",
  transform: "none",
  zoom: "1",
  "clip-path": "none",
  "mask-image": "none",
  rotate: "none",
  scale: "none",
  perspective: "none",
  clip: "auto",
  contain: "none",
  "overflow-clip-margin": "0px",
};
const rect = (x = 10, y = 20, width = 100, height = 40) => ({ x, y, width, height });
const root = {
  attachmentId: "a",
  target: { tabId: 4 },
  frameId: "top",
  documentElementBackendNodeId: 1,
};
function row(id: number, tag: string, box = rect()) {
  return {
    node: { backend: id },
    tag,
    box,
    client: box,
    contentSize: { width: box.width, height: box.height },
    styles: { ...styles },
  };
}
function encode(value: unknown): unknown {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return { type: "array", value: value.map(encode) };
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("backend" in record) return { type: "node", value: { backendNodeId: record.backend } };
    return { type: "object", value: Object.entries(record).map(([k, v]) => [k, encode(v)]) };
  }
  return { type: typeof value, value };
}
function png(width: number, height: number) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return btoa(String.fromCharCode(...bytes));
}
function fixture(child = false, oopif = false) {
  const parent: VisualFramePath = { document: root };
  const frame: VisualFramePath = child
    ? {
        document: {
          ...root,
          frameId: "child",
          documentElementBackendNodeId: 11,
          target: oopif ? { tabId: 4, sessionId: "oopif" } : { tabId: 4 },
        },
        parent: { frame: parent, ownerBackendNodeId: 2 },
      }
    : parent;
  const crop = child ? rect(120, 240, 200, 80) : rect();
  const candidate: VisualCandidate = {
    document: frame.document,
    backendNodeId: child ? 12 : 3,
    parentBackendNodeId: frame.document.documentElementBackendNodeId,
    framePath: frame,
    region: { status: "available", borderBox: crop, crop },
  };
  const topRows = child
    ? [row(2, "iframe", rect(100, 200, 400, 200)), row(1, "html", rect(0, 0, 1200, 800))]
    : [row(3, "canvas"), row(1, "html", rect(0, 0, 1200, 800))];
  if (child) topRows[0].contentSize = { width: 200, height: 100 };
  const childRows = [row(12, "canvas"), row(11, "html", rect(0, 0, 200, 100))];
  let calls = 0;
  const control = {
    attachmentId: "a",
    detached: false,
    failIdentity: false,
    onShot: (_attempt: number) => {},
    wrongOwner: false,
    rootChanged: false,
    failRead: false,
    abortRead: false,
    dpr: 1,
    shots: [png(crop.width, crop.height)],
  };
  const controller = new AbortController();
  const send = vi.fn(
    async (
      target: CdpTarget,
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> => {
      if (method === "DOM.getFrameOwner") return { backendNodeId: control.wrongOwner ? 999 : 2 };
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: params.frameId === "child" ? 11 : 1 };
      if (method === "DOM.resolveNode" && control.failIdentity) throw new Error("target gone");
      if (method === "DOM.resolveNode")
        return { object: { objectId: String(params.backendNodeId) } };
      if (method === "Runtime.callFunctionOn") {
        const isChild = params.objectId === "12";
        if (control.detached) return { result: { deepSerializedValue: { type: "null" } } };
        if (!(params.functionDeclaration as string).includes("styleNames"))
          return {
            result: {
              deepSerializedValue: {
                type: "node",
                value: { backendNodeId: control.rootChanged ? 999 : isChild ? 11 : 1 },
              },
            },
          };
        if (control.failRead) throw new Error("read failed");
        if (control.abortRead) controller.abort();
        return {
          result: {
            deepSerializedValue: encode({
              top: !isChild,
              dpr: control.dpr,
              rows: isChild ? childRows : topRows,
            }),
          },
        };
      }
      if (method === "Runtime.releaseObjectGroup") return {};
      // OOPIF projection uses the full viewport for scale, independently of
      // the scrollbar-excluding layout viewport used for clipping.
      if (method === "Runtime.evaluate" && target.sessionId === "oopif") {
        expect(params).toMatchObject({
          expression: "({ width: window.innerWidth, height: window.innerHeight })",
          returnByValue: true,
        });
        return { result: { value: { width: 200, height: 100 } } };
      }
      if (method === "Page.getLayoutMetrics")
        return {
          cssLayoutViewport: { clientWidth: 1200, clientHeight: 800, pageX: 0, pageY: 0 },
          cssVisualViewport: { scale: 1, zoom: 1 },
        };
      if (method === "DOM.getBoxModel")
        return { model: { content: [100, 200, 500, 200, 500, 400, 100, 400] } };
      if (method === "Page.captureScreenshot") {
        const data = control.shots[Math.min(calls++, control.shots.length - 1)];
        control.onShot(calls);
        return { data };
      }
      throw new Error(`unexpected ${method} ${target.sessionId}`);
    },
  );
  const cdp = {
    send: ((tabId, method, params) =>
      send({ tabId }, method, params as Record<string, unknown>)) as CdpRunner["send"],
    sendToTarget: send as unknown as CdpRunner["sendToTarget"],
    getAttachmentId: () => control.attachmentId,
    getFrameGraph: vi.fn(async () => {
      throw new Error("whole page discovery forbidden");
    }),
  };
  return { candidate, cdp, send, control, controller, topRows, childRows };
}

describe("visual screenshot", () => {
  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])("screenshots the local target child=%s oopif=%s without whole-page discovery", async (child, oopif) => {
    const f = fixture(child, oopif);
    const result = await captureVisualScreenshot(f.cdp, f.candidate);
    expect(result).toMatchObject({ width: child ? 200 : 100, height: child ? 80 : 40 });
    expect(f.cdp.getFrameGraph).not.toHaveBeenCalled();
    const names = f.send.mock.calls.map((c) => c[1]);
    expect(names.filter((n) => n === "DOM.getFrameOwner")).toHaveLength(child ? 2 : 0);
    expect(names.filter((n) => n === "DOM.resolveNode")).toHaveLength(child ? 4 : 2);
    expect(names.some((n) => /scroll|DOMSnapshot|getFrameTree|Accessibility/.test(n))).toBe(false);
    expect(f.send.mock.calls.find((c) => c[1] === "Page.captureScreenshot")?.[2]).toMatchObject({
      clip: { ...f.candidate.region.crop, scale: 1 },
    });
  });
  it.each([
    false,
    true,
  ])("projects a nested child through a parent target oopif=%s", async (oopif) => {
    const f = fixture(true, oopif);
    const parent = f.candidate.framePath!;
    const document = {
      ...parent.document,
      frameId: "grandchild",
      documentElementBackendNodeId: 21,
    };
    const crop = rect(130, 250, 40, 20);
    const candidate: VisualCandidate = {
      ...f.candidate,
      document,
      backendNodeId: 22,
      framePath: { document, parent: { frame: parent, ownerBackendNodeId: 12 } },
      region: { status: "available", borderBox: crop, crop },
    };
    f.childRows[0].tag = "iframe";
    f.control.shots = [png(40, 20)];
    const original = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (target, method, params = {}) => {
      if (method === "DOM.getFrameOwner" && params.frameId === "grandchild")
        return { backendNodeId: 12 };
      if (method === "Runtime.callFunctionOn" && params.objectId === "22") {
        if (!(params.functionDeclaration as string).includes("styleNames"))
          return {
            result: { deepSerializedValue: { type: "node", value: { backendNodeId: 21 } } },
          };
        return {
          result: {
            deepSerializedValue: encode({
              top: false,
              dpr: 1,
              rows: [row(22, "canvas", rect(5, 5, 20, 10)), row(21, "html", rect(0, 0, 100, 40))],
            }),
          },
        };
      }
      if (method === "DOM.getBoxModel" && params.backendNodeId === 12)
        return {
          model: {
            content: oopif
              ? [10, 20, 110, 20, 110, 60, 10, 60]
              : [120, 240, 320, 240, 320, 320, 120, 320],
          },
        };
      if (method === "Page.getLayoutMetrics" && target.sessionId)
        return {
          cssLayoutViewport: { clientWidth: 200, clientHeight: 100, pageX: 0, pageY: 0 },
          cssVisualViewport: { scale: 1, zoom: 1 },
        };
      return original(target, method, params);
    });
    expect(await captureVisualScreenshot(f.cdp, candidate)).toMatchObject({
      width: 40,
      height: 20,
    });
    expect(f.send.mock.calls.filter((c) => c[1] === "DOM.getFrameOwner")).toHaveLength(4);
    expect(f.send.mock.calls.find((c) => c[1] === "Page.captureScreenshot")?.[2]).toMatchObject({
      clip: crop,
    });
    expect(f.cdp.getFrameGraph).not.toHaveBeenCalled();
  });

  it("runs the live reader on only connected local ancestry", async () => {
    const f = fixture();
    await captureVisualScreenshot(f.cdp, f.candidate);
    const params = f.send.mock.calls.find(
      (c) =>
        c[1] === "Runtime.callFunctionOn" &&
        String(c[2]?.functionDeclaration).includes("styleNames"),
    )![2]!;
    const read = new Function(`return (${params.functionDeclaration});`)() as (
      this: Element,
      names: string[],
    ) => { rows: { node: Element }[] } | null;
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    try {
      const result = read.call(canvas, ["display"]);
      expect(result?.rows.map((row) => row.node)).toEqual([
        canvas,
        document.body,
        document.documentElement,
      ]);
      canvas.remove();
      expect(read.call(canvas, ["display"])).toBeNull();
      const other = document.implementation.createHTMLDocument();
      const foreign = other.createElement("canvas");
      other.body.append(foreign);
      expect(foreign.ownerDocument).toBe(other);
      expect(read.call(foreign, ["display"])).toBeNull();
    } finally {
      canvas.remove();
    }
  });

  it("keeps requests constant as ordinary ancestry grows", async () => {
    const small = fixture(),
      large = fixture();
    large.topRows.splice(
      1,
      0,
      ...Array.from({ length: 100 }, (_, i) => row(100 + i, "div", rect(0, 0, 1200, 800))),
    );
    await captureVisualScreenshot(small.cdp, small.candidate);
    await captureVisualScreenshot(large.cdp, large.candidate);
    expect(large.send.mock.calls.map((c) => c[1])).toEqual(small.send.mock.calls.map((c) => c[1]));
  });
  it("preserves missing-path candidates but cannot execute them", async () => {
    const f = fixture();
    const { framePath: _, ...candidate } = f.candidate;
    expect(await captureVisualScreenshot(f.cdp, candidate)).toMatchObject({
      data: { reason: "visual_target_changed" },
    });
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each([0.249, 0.25, 0.251])("compares rectangle edges with tolerance %s", async (delta) => {
    const f = fixture();
    f.topRows[0].box.x += delta;
    const result = await captureVisualScreenshot(f.cdp, f.candidate);
    expect("code" in result).toBe(delta > 0.25);
  });
  it("rejects a new clipping ancestor even if the resulting crop is identical", async () => {
    const f = fixture();
    const clip = row(8, "div", rect(0, 0, 1200, 800));
    clip.styles["overflow-x"] = "hidden";
    f.topRows.splice(1, 0, clip);
    expect(await captureVisualScreenshot(f.cdp, f.candidate)).toMatchObject({
      data: { reason: "visual_target_changed" },
    });
    expect(f.send.mock.calls.some((c) => c[1] === "Page.captureScreenshot")).toBe(false);
  });
  it("rejects changed owner and changed DOM before capture", async () => {
    for (const kind of ["wrongOwner", "rootChanged"] as const) {
      const f = fixture(true);
      f.control[kind] = true;
      expect(await captureVisualScreenshot(f.cdp, f.candidate)).toMatchObject({
        data: { reason: "visual_target_changed" },
      });
      expect(f.send.mock.calls.some((c) => c[1] === "Page.captureScreenshot")).toBe(false);
    }
  });
  it("releases retained objects on read failure and cancellation", async () => {
    for (const kind of ["failRead", "abortRead"] as const) {
      const f = fixture();
      f.control[kind] = true;
      const result = await captureVisualScreenshot(f.cdp, f.candidate, f.controller.signal);
      expect(result).toMatchObject({ code: kind === "abortRead" ? "cancelled" : "cdp_failed" });
      expect(f.send.mock.calls.at(-1)?.[1]).toBe("Runtime.releaseObjectGroup");
    }
  });
  it("plans pixels without enlarging images and retries at most once", async () => {
    expect(visualScreenshotScale(4096, 2048, 2)).toBe(0.25);
    expect(visualScreenshotScale(4000, 4000, 1)).toBe(0.5);
    const f = fixture();
    f.control.shots = [png(3000, 3000), png(1800, 1800)];
    expect(await captureVisualScreenshot(f.cdp, f.candidate)).toMatchObject({
      width: 1800,
      height: 1800,
    });
    const shots = f.send.mock.calls.filter((c) => c[1] === "Page.captureScreenshot");
    expect(shots).toHaveLength(2);
    expect((shots[1][2]!.clip as { scale: number }).scale).toBeLessThan(1);
    const fail = fixture();
    fail.control.shots = [png(3000, 3000)];
    expect(await captureVisualScreenshot(fail.cdp, fail.candidate)).toMatchObject({
      data: { reason: "visual_pixel_budget_exceeded" },
    });
    expect(fail.send.mock.calls.filter((c) => c[1] === "Page.captureScreenshot")).toHaveLength(2);
  });
  it.each([
    "attachment",
    "root",
    "anchor",
    "owner",
    "unavailable",
    "cancel",
  ])("rejects %s changes during capture", async (change) => {
    const f = fixture(true, true);
    f.control.onShot = () => {
      if (change === "attachment") f.control.attachmentId = "new";
      if (change === "root") f.control.rootChanged = true;
      if (change === "anchor") f.control.detached = true;
      if (change === "owner") f.control.wrongOwner = true;
      if (change === "unavailable") f.control.failIdentity = true;
      if (change === "cancel") f.controller.abort();
    };
    const result = await captureVisualScreenshot(f.cdp, f.candidate, f.controller.signal);
    expect(result).toMatchObject(
      change === "cancel" ? { code: "cancelled" } : { data: { reason: "visual_target_changed" } },
    );
    expect(f.send.mock.calls.filter((c) => c[1] === "Page.captureScreenshot")).toHaveLength(1);
  });
  it("keeps the image viewable when post-capture mapping reads fail", async () => {
    const f = fixture();
    f.control.onShot = () => {
      f.topRows[0].box.x += 100;
      f.topRows[0].styles.opacity = "0.5";
      f.control.failRead = true;
    };
    expect(await captureVisualScreenshot(f.cdp, f.candidate)).toMatchObject({
      width: 100,
      height: 40,
      capture_unavailable: expect.any(String),
    });
    const after = f.send.mock.calls.slice(
      f.send.mock.calls.findIndex((c) => c[1] === "Page.captureScreenshot") + 1,
    );
    expect(after.filter((c) => c[1] === "DOM.resolveNode")).toHaveLength(2);
    expect(
      after.some(
        (c) =>
          c[1] === "Page.getLayoutMetrics" ||
          c[1] === "DOM.getBoxModel" ||
          String(c[2]?.functionDeclaration).includes("styleNames"),
      ),
    ).toBe(true);
  });
  it("remeasures geometry before a pixel-budget retry", async () => {
    const f = fixture();
    f.control.shots = [png(3000, 3000), png(100, 40)];
    f.control.onShot = () => {
      f.topRows[0].box.x += 100;
    };
    expect(await captureVisualScreenshot(f.cdp, f.candidate)).toMatchObject({
      data: { reason: "visual_target_changed" },
    });
    expect(f.send.mock.calls.filter((c) => c[1] === "Page.captureScreenshot")).toHaveLength(1);
  });
  it("also checks identity after the second raster attempt", async () => {
    const f = fixture();
    f.control.shots = [png(3000, 3000), png(100, 40)];
    f.control.onShot = (attempt) => {
      if (attempt === 2) f.control.rootChanged = true;
    };
    expect(await captureVisualScreenshot(f.cdp, f.candidate)).toMatchObject({
      data: { reason: "visual_target_changed" },
    });
    expect(f.send.mock.calls.filter((c) => c[1] === "Page.captureScreenshot")).toHaveLength(2);
  });
  it("rejects invalid PNG without guessing dimensions", async () => {
    const f = fixture();
    f.control.shots = ["invalid"];
    expect(await captureVisualScreenshot(f.cdp, f.candidate)).toMatchObject({
      data: { reason: "screenshot_capture_failed" },
    });
  });
  it("dispatches a visual ref through the screenshot tool and restores overlays", async () => {
    const f = fixture();
    const manager = new SessionManager({
      agentWindow: {
        create: async () => 100,
        remove: async () => {},
        ensureActiveTab: async () => 4,
      },
    });
    const ctx = await manager.start("test");
    ctx.refStore.replace([["e1", { kind: "visual-region", candidate: f.candidate }]]);
    const tab = { id: 4, windowId: 100, active: true } as chrome.tabs.Tab;
    const tabsApi = { get: async () => tab, query: async () => [tab] };
    const sendToTab = vi.fn(async () => ({}));
    const result = await handleScreenshot(
      manager,
      { session_id: "test", ref: "e1" },
      { cdp: f.cdp, tabsApi, captureApi: { ...tabsApi, captureVisibleTab: vi.fn() }, sendToTab },
    );
    expect(result).toMatchObject({ width: 100, height: 40, format: "png" });
    expect(sendToTab).toHaveBeenCalledTimes(2);
  });
});

async function pointFixture(child = false, oopif = false) {
  const f = fixture(child, oopif);
  const manager = new SessionManager({
    agentWindow: {
      create: async () => 100,
      remove: async () => {},
      ensureActiveTab: async () => 4,
    },
  });
  const ctx = await manager.start("point");
  ctx.refStore.replace([["e1", { kind: "visual-region", candidate: f.candidate }]]);
  const tab = { id: 4, windowId: 100, active: true } as chrome.tabs.Tab;
  const tabsApi = { get: async () => tab, query: async () => [tab] };
  const bypassOverlay = vi.fn(async (_tab: number, _enabled: boolean) => {});
  const original = f.send.getMockImplementation()!;
  const input: Record<string, unknown>[] = [];
  const hitPoints: number[][] = [];
  const control = { hit: true, onMove: () => {}, failPress: false };
  f.send.mockImplementation(async (target, method, params = {}) => {
    if (
      method === "Runtime.callFunctionOn" &&
      String(params.functionDeclaration).includes("elementFromPoint")
    ) {
      hitPoints.push((params.arguments as { value: number }[]).map((a) => a.value));
      return { result: { value: control.hit } };
    }
    if (method === "Input.dispatchMouseEvent") {
      input.push(params);
      if (params.type === "mouseMoved") control.onMove();
      if (params.type === "mousePressed" && control.failPress) throw new Error("transport lost");
      return {};
    }
    return original(target, method, params);
  });
  const shot = await handleScreenshot(
    manager,
    { session_id: "point", ref: "e1" },
    {
      cdp: f.cdp,
      tabsApi,
      captureApi: { ...tabsApi, captureVisibleTab: vi.fn() },
      sendToTab: vi.fn(async () => ({})),
    },
  );
  expect(shot).toHaveProperty("capture_id");
  const params = {
    session_id: "point",
    ref: "e1",
    capture_id: (shot as { capture_id: string }).capture_id,
    image_x: child ? 100 : 50,
    image_y: child ? 40 : 20,
  };
  return {
    ...f,
    manager,
    ctx,
    params,
    input,
    hitPoints,
    pointControl: control,
    deps: { cdp: f.cdp, tabsApi, bypassOverlay },
    shot,
  };
}

it.each([
  [false, false],
  [true, false],
  [true, true],
])("clicks only the captured Canvas through the frame path child=%s oopif=%s", async (child, oopif) => {
  const f = await pointFixture(child, oopif);
  const result = await handleClick(f.manager, f.params, f.deps);
  expect(result).toMatchObject({ x: child ? 220 : 60, y: child ? 280 : 40 });
  expect(f.hitPoints.at(-1)).toEqual([60, 40]);
  expect(f.input.map((e) => e.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
  expect(f.cdp.getFrameGraph).not.toHaveBeenCalled();
  const count = f.input.length;
  expect(await handleClick(f.manager, f.params, f.deps)).toHaveProperty(
    "data.reason",
    "visual_capture_stale",
  );
  expect(f.input).toHaveLength(count);
  expect(f.deps.bypassOverlay.mock.calls).toEqual([
    [4, true],
    [4, false],
  ]);
});

it.each([
  "replace",
  "geometry",
  "occluded",
  "expired",
  "wrong-ref",
  "wrong-session",
])("rejects unusable captures before moving: %s", async (kind) => {
  const f = await pointFixture();
  if (kind === "replace")
    f.ctx.refStore.replace([["e1", { kind: "visual-region", candidate: f.candidate }]]);
  if (kind === "geometry") f.topRows[0].box.x += 10;
  if (kind === "occluded") f.pointControl.hit = false;
  if (kind === "wrong-ref") f.params.ref = "e2";
  if (kind === "wrong-session") f.params.session_id = "other";
  const now = Date.now();
  const clock =
    kind === "expired" ? vi.spyOn(Date, "now").mockReturnValue(now + 120001) : undefined;
  try {
    expect(await handleClick(f.manager, f.params, f.deps)).toHaveProperty("code");
    expect(f.input).toHaveLength(0);
  } finally {
    clock?.mockRestore();
  }
});

it.each([
  "geometry",
  "occluded",
  "cancel",
  "press-failed",
])("does not silently replay after %s during click", async (kind) => {
  const f = await pointFixture();
  const controller = new AbortController();
  f.pointControl.onMove = () => {
    if (kind === "geometry") f.topRows[0].box.x += 10;
    if (kind === "occluded") f.pointControl.hit = false;
    if (kind === "cancel") controller.abort();
  };
  f.pointControl.failPress = kind === "press-failed";
  const result = await handleClick(f.manager, f.params, { ...f.deps, signal: controller.signal });
  expect(result).toHaveProperty("data.effect_state", kind === "press-failed" ? "unknown" : "none");
  expect(f.input.map((e) => e.type)).toEqual(
    kind === "press-failed" ? ["mouseMoved", "mousePressed", "mouseReleased"] : ["mouseMoved"],
  );
  expect(await handleClick(f.manager, f.params, f.deps)).toHaveProperty(
    "data.reason",
    "visual_capture_stale",
  );
});

it("dispatches two complete clicks with modifiers for a double-click", async () => {
  const f = await pointFixture();
  expect(
    await handleClick(f.manager, { ...f.params, click_count: 2, modifiers: ["shift"] }, f.deps),
  ).not.toHaveProperty("code");
  expect(f.input.map((e) => [e.type, e.clickCount])).toEqual([
    ["mouseMoved", undefined],
    ["mousePressed", 1],
    ["mouseReleased", 1],
    ["mousePressed", 2],
    ["mouseReleased", 2],
  ]);
  expect(f.input.every((e) => e.modifiers === 8)).toBe(true);
});

it("returns a viewable image without a click capture when the mapping changes during capture", async () => {
  const f = fixture();
  f.control.onShot = () => {
    f.topRows[0].box.x += 1;
  };
  const shot = await captureVisualScreenshot(f.cdp, f.candidate);
  expect(shot).toMatchObject({ width: 100, height: 40, capture_unavailable: expect.any(String) });
  expect(shot).not.toHaveProperty("mapping");
});

it("bounds capture storage and invalidates superseded images without retaining pixels", async () => {
  const f = await pointFixture();
  const shot = await captureVisualScreenshot(f.cdp, f.candidate);
  if ("code" in shot || !shot.mapping) throw new Error("expected mapping");
  f.ctx.refStore.replace(
    Array.from(
      { length: 33 },
      (_, i) => [`e${i + 1}`, { kind: "visual-region" as const, candidate: f.candidate }] as const,
    ),
  );
  const ids: string[] = [];
  for (let i = 1; i <= 33; i++) {
    const entry = f.ctx.refStore.resolveEntry(`e${i}`)!;
    if (entry.kind !== "visual-region") throw new Error("expected visual");
    ids.push(issueVisualCapture(f.ctx.refStore, `e${i}`, entry, shot.mapping, 100, 40)!);
  }
  const request = (ref: string, id: string) =>
    consumeVisualCapture(f.ctx.refStore, 4, {
      session_id: "point",
      ref,
      capture_id: id,
      image_x: 50,
      image_y: 20,
    });
  expect(request("e1", ids[0])).toHaveProperty("code");
  expect(request("e2", ids[1])).toHaveProperty("point", { x: 60, y: 40 });
  const entry = f.ctx.refStore.resolveEntry("e33")!;
  if (entry.kind !== "visual-region") throw new Error("expected visual");
  const newest = issueVisualCapture(f.ctx.refStore, "e33", entry, shot.mapping, 100, 40)!;
  expect(request("e33", ids[32])).toHaveProperty("code");
  expect(request("e33", newest)).toHaveProperty("point");
  f.ctx.refStore.clear();
  expect(issueVisualCapture(f.ctx.refStore, "e33", entry, shot.mapping, 100, 40)).toBeUndefined();
});

it.each([
  [-1, 0],
  [100, 0],
  [0, 40],
  [NaN, 0],
  [0, Infinity],
])("rejects invalid PNG point %s,%s without consuming its capture", async (x, y) => {
  const f = await pointFixture();
  expect(
    await handleClick(f.manager, { ...f.params, image_x: x, image_y: y }, f.deps),
  ).toHaveProperty("code", "invalid_params");
  expect(f.input).toHaveLength(0);
  expect(await handleClick(f.manager, f.params, f.deps)).not.toHaveProperty("code");
});

describe("visual hit shadow boundaries", () => {
  it.each([
    "plain",
    "open",
    "closed",
    "nested",
    "slotted",
    "iframe",
  ])("executes the hit script for %s targets and rejects occlusion in every scope", async (kind) => {
    const container = document.createElement("div");
    document.body.append(container);
    const target = document.createElement(kind === "iframe" ? "iframe" : "canvas");
    const scopes: { root: Document | ShadowRoot; node: Element }[] = [];
    let parent: Element | ShadowRoot = container;
    const modes: ShadowRootMode[] =
      kind === "nested"
        ? ["closed", "open", "closed"]
        : kind === "plain"
          ? []
          : [kind === "open" ? "open" : "closed"];
    let scope: Document | ShadowRoot = document;
    for (const mode of modes) {
      const host = document.createElement("div");
      parent.append(host);
      if (kind === "slotted") {
        host.attachShadow({ mode }).append(document.createElement("slot"));
        parent = host;
        break;
      }
      scopes.push({ root: scope, node: host });
      scope = host.attachShadow({ mode });
      if (mode === "closed") expect(host.shadowRoot).toBeNull();
      parent = scope;
    }
    parent.append(target);
    scopes.push({ root: scope, node: target });
    // happy-dom has no layout hit testing. Stub only the browser hit results;
    // execute the actual CDP script against real DOM roots, including closed ones.
    const hits = scopes.map(({ root, node }) => {
      const original = Object.getOwnPropertyDescriptor(root, "elementFromPoint");
      const hit = vi.fn((): Element | null => node);
      Object.defineProperty(root, "elementFromPoint", { configurable: true, value: hit });
      return { root, original, hit, node };
    });
    try {
      const f = fixture();
      const state = await resolveVisualRegionNow(f.cdp, f.candidate);
      if ("code" in state) throw new Error(state.message);
      const original = f.send.getMockImplementation()!;
      f.send.mockImplementation(async (cdpTarget, method, params = {}) => {
        if (
          method === "Runtime.callFunctionOn" &&
          String(params.functionDeclaration).includes("elementFromPoint")
        ) {
          const run = new Function(`return (${params.functionDeclaration});`)();
          return { result: { value: run.call(target, 20, 30) } };
        }
        return original(cdpTarget, method, params);
      });
      expect(await verifyVisualHit(f.cdp, state, { x: 20, y: 30 })).toBe(true);
      for (const { hit, node } of hits) {
        hit.mockReturnValue(document.createElement("div"));
        expect(await verifyVisualHit(f.cdp, state, { x: 20, y: 30 })).toBe(false);
        hit.mockReturnValue(node);
      }
      target.remove();
      expect(await verifyVisualHit(f.cdp, state, { x: 20, y: 30 })).toBe(false);
      expect(f.cdp.getFrameGraph).not.toHaveBeenCalled();
    } finally {
      for (const { root, original } of hits) {
        if (original) Object.defineProperty(root, "elementFromPoint", original);
        else Reflect.deleteProperty(root, "elementFromPoint");
      }
      container.remove();
    }
  });
});
