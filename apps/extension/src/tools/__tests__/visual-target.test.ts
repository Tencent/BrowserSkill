import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CdpDebuggee,
  type CdpDebuggerApi,
  ChromiumCdp,
  DEFAULT_IDLE_DETACH_MS,
} from "@/browser-driver/chromium-cdp";
import { pointerTransactionDeps } from "../pointer-transaction";
import { sessionCdpRunner } from "../shared";
import { captureVisualScreenshot } from "../visual-screenshot";
import { resolveVisualRegionNow } from "../visual-target";
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

function fakeChromeEvent<TArgs extends unknown[]>() {
  const listeners = new Set<(...args: TArgs) => void>();
  return {
    listeners,
    addListener: vi.fn((cb: (...args: TArgs) => void) => listeners.add(cb)),
    removeListener: vi.fn((cb: (...args: TArgs) => void) => listeners.delete(cb)),
    fire: (...args: TArgs) => {
      for (const cb of listeners) cb(...args);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function softDetachVisualFixture(oopif = false) {
  const onEvent = fakeChromeEvent<[CdpDebuggee, string, unknown]>();
  const onDetach = fakeChromeEvent<[chrome.debugger.Debuggee, string]>();
  let attachGeneration = 0;
  let rootState = {
    loaderId: "root-loader-1",
    url: "https://visual-soft.test/",
    backendNodeId: 1,
  };
  const activeChildSessions = new Set<string>();

  const topRows = oopif
    ? [row(2, "iframe", rect(100, 200, 400, 200)), row(1, "html", rect(0, 0, 1200, 800))]
    : [row(3, "canvas"), row(1, "html", rect(0, 0, 1200, 800))];
  if (oopif) topRows[0].contentSize = { width: 200, height: 100 };
  const childRows = [row(12, "canvas"), row(11, "html", rect(0, 0, 200, 100))];
  const crop = oopif ? rect(120, 240, 200, 80) : rect();

  const api: CdpDebuggerApi = {
    attach: vi.fn(async () => {
      attachGeneration += 1;
      activeChildSessions.clear();
    }),
    detach: vi.fn(async () => {
      activeChildSessions.clear();
    }),
    sendCommand: vi.fn(async (target, method, rawParams) => {
      const params = (rawParams ?? {}) as Record<string, unknown>;
      if (target.sessionId && !activeChildSessions.has(target.sessionId)) {
        throw new Error(`Session with given id not found: ${target.sessionId}`);
      }
      if (!target.sessionId && method === "Target.setAutoAttach") {
        if (oopif) {
          const childSession = `oopif-${attachGeneration}`;
          activeChildSessions.add(childSession);
          onEvent.fire({ tabId: 4 }, "Target.attachedToTarget", {
            sessionId: childSession,
            targetInfo: { type: "iframe", targetId: "child-target", url: "https://child.test/" },
          });
        }
        return {};
      }
      if (method === "Page.enable" || method === "Network.enable") return {};
      if (method === "Page.getFrameTree") {
        if (!target.sessionId) {
          return {
            frameTree: {
              frame: { id: "top", loaderId: rootState.loaderId, url: rootState.url },
              ...(oopif
                ? {
                    childFrames: [
                      { frame: { id: "child", parentId: "top", url: "https://child.test/" } },
                    ],
                  }
                : {}),
            },
          };
        }
        return {
          frameTree: {
            frame: {
              id: "child",
              parentId: "top",
              loaderId: "child-loader-1",
              url: "https://child.test/",
            },
          },
        };
      }
      if (method === "DOM.getDocument") {
        return {
          root: { backendNodeId: rootState.backendNodeId, documentURL: rootState.url },
        };
      }
      if (method === "DOM.getFrameOwner") return { backendNodeId: 2 };
      if (method === "Page.createIsolatedWorld") {
        return { executionContextId: params.frameId === "child" ? 11 : 1 };
      }
      if (method === "DOM.resolveNode") {
        return { object: { objectId: String(params.backendNodeId) } };
      }
      if (method === "Runtime.callFunctionOn") {
        const isChild = params.objectId === "12";
        if (!(params.functionDeclaration as string).includes("styleNames")) {
          return {
            result: {
              deepSerializedValue: {
                type: "node",
                value: { backendNodeId: isChild ? 11 : rootState.backendNodeId },
              },
            },
          };
        }
        return {
          result: {
            deepSerializedValue: encode({
              top: !isChild,
              dpr: 1,
              rows: isChild ? childRows : topRows,
            }),
          },
        };
      }
      if (method === "Runtime.releaseObjectGroup") return {};
      if (method === "Runtime.evaluate" && target.sessionId) {
        return { result: { value: { width: 200, height: 100 } } };
      }
      if (method === "Page.getLayoutMetrics") {
        return {
          cssLayoutViewport: { clientWidth: 1200, clientHeight: 800, pageX: 0, pageY: 0 },
          cssVisualViewport: { scale: 1, zoom: 1 },
        };
      }
      if (method === "DOM.getBoxModel") {
        return { model: { content: [100, 200, 500, 200, 500, 400, 100, 400] } };
      }
      if (method === "Page.captureScreenshot") {
        return { data: png(crop.width, crop.height) };
      }
      return {};
    }),
    // biome-ignore lint/suspicious/noExplicitAny: minimal chrome.events.Event shim
    onEvent: onEvent as any,
    // biome-ignore lint/suspicious/noExplicitAny: minimal chrome.events.Event shim
    onDetach: onDetach as any,
  };

  const onDocumentChanged = vi.fn();
  const cdp = new ChromiumCdp(api, {
    onDocumentChanged,
    idleDetachMs: DEFAULT_IDLE_DETACH_MS,
  });
  await cdp.ensureAttached(4);
  await vi.advanceTimersByTimeAsync(50);

  const attachmentId = cdp.getAttachmentId(4)!;
  const rootDoc = {
    attachmentId,
    target: { tabId: 4 },
    frameId: "top",
    documentElementBackendNodeId: 1,
  };
  const parentPath: VisualFramePath = { document: rootDoc };
  const framePath: VisualFramePath = oopif
    ? {
        document: {
          attachmentId,
          target: { tabId: 4, sessionId: "oopif-1" },
          frameId: "child",
          documentElementBackendNodeId: 11,
        },
        parent: { frame: parentPath, ownerBackendNodeId: 2 },
      }
    : parentPath;
  const candidate: VisualCandidate = {
    document: framePath.document,
    backendNodeId: oopif ? 12 : 3,
    parentBackendNodeId: framePath.document.documentElementBackendNodeId,
    framePath,
    region: { status: "available", borderBox: crop, crop },
  };

  const runner = sessionCdpRunner(cdp, "vis-session", () => true);
  return {
    api,
    cdp,
    runner,
    candidate,
    onDocumentChanged,
    mutateRootDocument: () => {
      rootState = {
        loaderId: "root-loader-2",
        url: "https://visual-soft.test/navigated",
        backendNodeId: 99,
      };
    },
  };
}

describe("visual target across idle CDP soft-detach", () => {
  it.each([
    false,
    true,
  ])("preserves @vN visual refs and remaps OOPIF=%s sessions across 75s soft-detach when root document is unchanged", async (oopif) => {
    vi.useFakeTimers();
    const f = await softDetachVisualFixture(oopif);
    try {
      await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_DETACH_MS);
      expect(f.cdp.isAttached(4)).toBe(false);
      expect(f.api.detach).toHaveBeenCalledExactlyOnceWith({ tabId: 4 });

      // Pointer transaction wrapper also forwards `reattachIfSoftDetached` and `resolveTarget`.
      const txDeps = pointerTransactionDeps({
        cdp: f.runner,
        tabsApi: {
          get: async () => ({ id: 4, windowId: 1, active: true }) as chrome.tabs.Tab,
          query: async () => [],
        },
      });
      const resolution = resolveVisualRegionNow(txDeps.deps.cdp, f.candidate);
      await vi.advanceTimersByTimeAsync(50);
      const resolved = await resolution;
      expect(resolved).toMatchObject({
        crop: f.candidate.region.crop,
      });
      expect(f.cdp.isAttached(4)).toBe(true);
      expect(f.cdp.getAttachmentId(4)).toBe(f.candidate.document.attachmentId);
      expect(f.onDocumentChanged).not.toHaveBeenCalled();

      // Soft-detach a second time and verify `captureVisualScreenshot` also transparently reattaches.
      await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_DETACH_MS);
      expect(f.cdp.isAttached(4)).toBe(false);

      const capture = captureVisualScreenshot(f.runner, f.candidate);
      await vi.advanceTimersByTimeAsync(50);
      const shot = await capture;
      expect(shot).toMatchObject({
        width: oopif ? 200 : 100,
        height: oopif ? 80 : 40,
      });
      expect(f.onDocumentChanged).not.toHaveBeenCalled();
    } finally {
      f.cdp.dispose();
    }
  });

  it("rotates attachmentId and returns visual_target_changed when root document changed while soft-detached", async () => {
    vi.useFakeTimers();
    const f = await softDetachVisualFixture(false);
    try {
      await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_DETACH_MS);
      expect(f.cdp.isAttached(4)).toBe(false);

      f.mutateRootDocument();

      const resolved = await resolveVisualRegionNow(f.runner, f.candidate);
      expect(resolved).toMatchObject({
        code: "not_found",
        data: { reason: "visual_target_changed" },
      });
      expect(f.onDocumentChanged).toHaveBeenCalledExactlyOnceWith(4);
      expect(f.cdp.getAttachmentId(4)).not.toBe(f.candidate.document.attachmentId);

      const shot = await captureVisualScreenshot(f.runner, f.candidate);
      expect(shot).toMatchObject({
        code: "not_found",
        data: { reason: "visual_target_changed" },
      });
    } finally {
      f.cdp.dispose();
    }
  });

  it("returns visual_target_changed without reconnecting when tab was hard-detached", async () => {
    vi.useFakeTimers();
    const f = await softDetachVisualFixture(false);
    try {
      const attachCallsBefore = vi.mocked(f.api.attach).mock.calls.length;
      await f.cdp.detach(4);
      expect(f.cdp.isAttached(4)).toBe(false);

      const resolved = await resolveVisualRegionNow(f.runner, f.candidate);
      expect(resolved).toMatchObject({
        code: "not_found",
        data: { reason: "visual_target_changed" },
      });
      expect(f.api.attach).toHaveBeenCalledTimes(attachCallsBefore);
    } finally {
      f.cdp.dispose();
    }
  });
});
