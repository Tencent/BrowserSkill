import { describe, expect, it, vi } from "vitest";
import {
  createFrameDocumentInfo,
  rootEventSource,
  targetEventSource,
} from "@/browser-driver/frame-handles";
import type { InputPassthroughMessage } from "@/lib/input-passthrough-bridge";
import { SessionManager } from "@/session-manager/manager";
import { type DownloadsApi, handleDownload } from "../download";
import { captureBrowserDownload } from "../download-capture";
import { uploadThroughFileDrop } from "../file-drop-transaction";
import { uploadThroughActivatedFileInput } from "../file-input-transaction";
import type { ResolvedActionTarget } from "../interaction";
import { type CdpRunner, createStubCdpRunner } from "../shared";
import { handleUpload } from "../upload";

function sessions() {
  return new SessionManager({
    agentWindow: {
      create: vi.fn(async () => ({ windowId: 100, initialTabIds: [] })),
      remove: vi.fn(async () => {}),
      ensureActiveTab: vi.fn(async () => 1),
    },
  });
}

function tabsApi() {
  return {
    get: vi.fn(
      async (tabId: number) => ({ id: tabId, windowId: 100, active: true }) as chrome.tabs.Tab,
    ),
    query: vi.fn(async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab]),
  };
}

function fakeEvent<T extends (...args: never[]) => unknown>() {
  const listeners = new Set<T>();
  return {
    addListener: (listener: T) => listeners.add(listener),
    removeListener: (listener: T) => listeners.delete(listener),
    emit: (...args: Parameters<T>) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

function popupDownloadFakes() {
  const onCreated = fakeEvent<(item: chrome.downloads.DownloadItem) => void>();
  const onChanged = fakeEvent<(delta: chrome.downloads.DownloadDelta) => void>();
  const onDeterminingFilename =
    fakeEvent<
      (
        item: chrome.downloads.DownloadItem,
        suggest: (suggestion?: chrome.downloads.DownloadFilenameSuggestion) => void,
      ) => void | true
    >();
  const onCreatedNavigationTarget =
    fakeEvent<(details: chrome.webNavigation.WebNavigationSourceCallbackDetails) => void>();
  const completed = new Map<number, chrome.downloads.DownloadItem>();
  const downloads: DownloadsApi = {
    onCreated,
    onChanged,
    onDeterminingFilename,
    search: vi.fn(async ({ id }: chrome.downloads.DownloadQuery) => {
      const item = id === undefined ? undefined : completed.get(id);
      return item ? [item] : [];
    }),
    cancel: vi.fn(async () => {}),
    removeFile: vi.fn(async () => {}),
  };
  return {
    downloads,
    navigationTargets: { onCreatedNavigationTarget },
    item: (id: number, url: string, finalUrl = url) =>
      ({
        id,
        url,
        finalUrl,
        filename: `report-${id}.csv`,
        state: "in_progress",
        fileSize: -1,
        totalBytes: 4,
      }) as chrome.downloads.DownloadItem,
    /** Resolves with the suggestion Chrome would receive for this candidate. */
    offer: (item: chrome.downloads.DownloadItem) =>
      new Promise<chrome.downloads.DownloadFilenameSuggestion | undefined>((resolve) => {
        onDeterminingFilename.emit(item, resolve);
      }),
    finish: (
      item: chrome.downloads.DownloadItem,
      filename = `/profile/Downloads/BrowserSkill/tr_${item.id}/${item.filename}`,
    ) => {
      const done = {
        ...item,
        filename,
        state: "complete",
        fileSize: 4,
      } as chrome.downloads.DownloadItem;
      completed.set(item.id, done);
      onCreated.emit(done);
    },
    finishChanged: (item: chrome.downloads.DownloadItem, filename: string) => {
      completed.set(item.id, {
        ...item,
        filename,
        state: "complete",
        fileSize: 4,
      } as chrome.downloads.DownloadItem);
      onChanged.emit({
        id: item.id,
        state: { current: "complete" },
      } as chrome.downloads.DownloadDelta);
    },
    popup: (sourceTabId: number, url: string) =>
      onCreatedNavigationTarget.emit({
        sourceTabId,
        sourceFrameId: 0,
        sourceProcessId: 1,
        tabId: 99,
        url,
        timeStamp: 0,
      } as chrome.webNavigation.WebNavigationSourceCallbackDetails),
  };
}

function silentCdp(
  send: CdpRunner["send"] = vi.fn(async () => ({})) as CdpRunner["send"],
): CdpRunner {
  return createStubCdpRunner({
    send,
    onEvent: () => ({ dispose: vi.fn() }),
  });
}

function actionTarget(frameId = "", loaderId = ""): ResolvedActionTarget {
  return {
    tab: { tabId: 4, windowId: 100, active: true },
    backendNodeId: 123,
    handle: { tabId: 4, frameId, loaderId, backendNodeId: 123 },
    ...(frameId ? { frameId } : {}),
    usedRef: "e3",
  };
}

function withoutOverlay<T>(operation: () => Promise<T>): Promise<T> {
  return operation();
}

function uploadCdp(
  options: {
    inputCount?: number;
    multiple?: boolean;
    chooser?: { frameId?: string; backendNodeId?: number; mode?: string };
    pendingResolve?: boolean;
    overlayHit?: () => string;
  } = {},
) {
  const calls: Array<{ method: string; params?: object }> = [];
  let cdpEvent: Parameters<NonNullable<CdpRunner["onEvent"]>>[1] | undefined;
  const send = vi.fn(async (_tabId: number, method: string, params?: object) => {
    if (
      method === "Runtime.evaluate" &&
      (params as { expression?: string })?.expression === "document.visibilityState"
    )
      return { result: { value: "visible" } };
    calls.push({ method, params });
    if (
      method === "Runtime.evaluate" &&
      String((params as { expression?: string })?.expression).includes('return "absent"')
    )
      return { result: { value: options.overlayHit?.() ?? "clear" } };
    if (method === "DOM.scrollIntoViewIfNeeded") return {};
    if (method === "Page.setInterceptFileChooserDialog") return {};
    if (method === "Page.getLayoutMetrics")
      return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
    if (method === "DOM.getContentQuads") return { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] };
    if (method === "DOM.resolveNode") {
      if (options.pendingResolve) return new Promise<never>(() => {});
      return { object: { objectId: "trigger-object" } };
    }
    if (method === "Runtime.callFunctionOn") {
      const declaration = (params as { functionDeclaration?: string }).functionDeclaration ?? "";
      if (declaration.includes("Object.defineProperty")) return { result: { value: true } };
      if (declaration.includes("count: state.inputs.length")) {
        return {
          result: {
            value: {
              count: options.inputCount ?? 1,
              multiple: options.multiple ?? true,
            },
          },
        };
      }
      if (declaration.includes("inputs[0]")) {
        return { result: { objectId: "input-object" } };
      }
      return { result: { value: true } };
    }
    if (method === "DOM.describeNode") return { node: { backendNodeId: 456 } };
    if (
      method === "Input.dispatchMouseEvent" &&
      (params as { type?: string }).type === "mousePressed" &&
      options.chooser
    ) {
      cdpEvent?.(rootEventSource(4), "Page.fileChooserOpened", options.chooser);
    }
    return {};
  });
  const cdp: CdpRunner = createStubCdpRunner({
    send: send as unknown as CdpRunner["send"],
    onEvent: (_tabId, handler) => {
      cdpEvent = handler;
      return { dispose: vi.fn() };
    },
  });
  return {
    calls,
    emitChooser: (event: { frameId?: string; backendNodeId?: number; mode?: string }) =>
      cdpEvent?.(rootEventSource(4), "Page.fileChooserOpened", event),
    cdp,
  };
}

function dropCdp(
  options: {
    targetContainsPoint?: boolean;
    dispatchError?: (type: string) => Error | Promise<never> | undefined;
    onCall?: (method: string) => void;
  } = {},
) {
  const calls: Array<{ method: string; params?: object }> = [];
  const detach = vi.fn(async () => {});
  const send = vi.fn(async (_tabId: number, method: string, params?: object) => {
    if (
      method === "Runtime.evaluate" &&
      (params as { expression?: string })?.expression === "document.visibilityState"
    ) {
      return { result: { value: "visible" } };
    }
    calls.push({ method, params });
    options.onCall?.(method);
    if (method === "DOM.scrollIntoViewIfNeeded") return {};
    if (method === "Page.getLayoutMetrics") {
      return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
    }
    if (method === "DOM.getContentQuads") {
      return { quads: [[10, 20, 210, 20, 210, 120, 10, 120]] };
    }
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "DOM.getNodeForLocation") return { backendNodeId: 124, frameId: "main" };
    if (method === "DOM.resolveNode") {
      const id = (params as { backendNodeId?: number }).backendNodeId;
      return { object: { objectId: id === 123 ? "drop-target" : "hit-target" } };
    }
    if (method === "Runtime.callFunctionOn") {
      return { result: { value: options.targetContainsPoint ?? true } };
    }
    if (method === "Input.dispatchDragEvent") {
      const type = (params as { type?: string }).type ?? "";
      const error = options.dispatchError?.(type);
      if (error instanceof Promise) return error;
      if (error) throw error;
      return {};
    }
    if (method === "Runtime.releaseObjectGroup") return {};
    throw new Error(`unexpected drop CDP command ${method}`);
  });
  const cdp: CdpRunner = createStubCdpRunner({
    send: send as unknown as CdpRunner["send"],
    detach,
  });
  return { calls, cdp, detach };
}

describe("file transfer tools", () => {
  it.each([
    false,
    true,
  ])("uploads staged paths through the requested click (covered=%s)", async (covered) => {
    const manager = sessions();
    const ctx = await manager.start("s1");
    ctx.refStore.set("e3", 123, { tabId: 4 });
    let passthrough = false;
    const sendInputPassthrough = vi.fn(async (_tab: number, message: InputPassthroughMessage) => {
      passthrough = message.phase === "begin";
    });
    const { cdp, calls } = uploadCdp({
      overlayHit: () => (covered && !passthrough ? "covered" : "clear"),
    });

    const result = await handleUpload(
      manager,
      {
        session_id: "s1",
        ref: "@e3",
        files: [
          { transfer_id: "tr_1", name: "one.png", staged_path: "/private/stage/one" },
          { transfer_id: "tr_2", name: "two.png", staged_path: "/private/stage/two" },
        ],
      },
      { cdp, tabsApi: tabsApi(), sendInputPassthrough },
    );
    expect(sendInputPassthrough.mock.calls.map(([, m]) => m.phase)).toEqual(
      covered ? ["begin", "end"] : [],
    );
    expect(passthrough).toBe(false);

    expect(result).toMatchObject({ tab_id: 4, file_names: ["one.png", "two.png"] });
    expect(calls[0]).toEqual({
      method: "Page.setInterceptFileChooserDialog",
      params: { enabled: true },
    });
    expect(calls).toContainEqual({
      method: "Page.setInterceptFileChooserDialog",
      params: { enabled: false, cancel: true },
    });
    expect(calls).toContainEqual({
      method: "DOM.setFileInputFiles",
      params: { files: ["/private/stage/one", "/private/stage/two"], backendNodeId: 456 },
    });
  });

  it("fails immediately when the trigger does not activate a file input", async () => {
    const { cdp } = uploadCdp({ inputCount: 0 });
    const result = await uploadThroughActivatedFileInput({
      cdp,
      actionTarget: actionTarget(),
      files: ["/private/stage/one"],
      timeoutMs: 100,
      trigger: async () => ({ tab_id: 4, x: 10, y: 10 }),
    });

    expect(result).toMatchObject({
      code: "unsupported",
      data: { reason: "file_input_not_activated", phase: "resolve_input" },
    });
  });

  it("fails before clicking when chooser interception is unavailable", async () => {
    const trigger = vi.fn(async () => ({ tab_id: 4, x: 10, y: 10 }));
    const cdp: CdpRunner = createStubCdpRunner({
      send: vi.fn(async (_tabId: number, method: string) => {
        if (method === "Page.setInterceptFileChooserDialog") {
          throw new Error("method unavailable");
        }
        return {};
      }) as CdpRunner["send"],
    });

    const result = await uploadThroughActivatedFileInput({
      cdp,
      actionTarget: actionTarget(),
      files: ["/private/stage/one"],
      timeoutMs: 100,
      trigger,
    });

    expect(result).toMatchObject({
      code: "cdp_failed",
      data: { effect_state: "none", phase: "arm_interception" },
    });
    expect(trigger).not.toHaveBeenCalled();
  });

  it("uses an exact chooser event as an independent input-location signal", async () => {
    const { cdp, calls, emitChooser } = uploadCdp({ inputCount: 0 });
    const result = await uploadThroughActivatedFileInput({
      cdp,
      actionTarget: actionTarget("f1"),
      files: ["/private/stage/one"],
      timeoutMs: 100,
      trigger: async () => {
        emitChooser({ frameId: "f1", backendNodeId: 789, mode: "selectSingle" });
        return { tab_id: 4, x: 10, y: 10 };
      },
    });

    expect(result).toMatchObject({ multiple: false });
    expect(calls).toContainEqual({
      method: "DOM.setFileInputFiles",
      params: { files: ["/private/stage/one"], backendNodeId: 789 },
    });
  });

  it("reports a File System Access picker without waiting for a timeout", async () => {
    const { cdp, emitChooser } = uploadCdp({
      inputCount: 0,
    });
    const result = await uploadThroughActivatedFileInput({
      cdp,
      actionTarget: actionTarget("f1"),
      files: ["/private/stage/one"],
      timeoutMs: 100,
      trigger: async () => {
        emitChooser({ frameId: "f1", mode: "selectSingle" });
        return { tab_id: 4, x: 10, y: 10 };
      },
    });

    expect(result).toMatchObject({
      code: "unsupported",
      message: "upload trigger invoked a non-input file picker",
      data: { reason: "file_input_not_activated", phase: "resolve_input" },
    });
  });

  it("bounds a stuck file-input probe", async () => {
    const { cdp } = uploadCdp({ pendingResolve: true });

    const result = await uploadThroughActivatedFileInput({
      cdp,
      actionTarget: actionTarget(),
      files: ["/private/stage/one"],
      timeoutMs: 5,
      trigger: vi.fn(),
    });

    expect(result).toMatchObject({
      code: "timeout",
      data: { reason: "file_input_probe_failed", phase: "arm_input_probe" },
    });
  });

  it("marks a timed-out file assignment unknown and detaches browser state", async () => {
    const fixture = uploadCdp();
    const originalSend = fixture.cdp.send;
    const detach = vi.fn(async () => {});
    fixture.cdp.detach = detach;
    fixture.cdp.send = vi.fn((tabId: number, method: string, params?: object) => {
      if (method === "DOM.setFileInputFiles") return new Promise<never>(() => {});
      return originalSend(tabId, method, params);
    }) as CdpRunner["send"];

    const result = await uploadThroughActivatedFileInput({
      cdp: fixture.cdp,
      actionTarget: actionTarget(),
      files: ["/private/stage/one"],
      timeoutMs: 10,
      trigger: async () => ({ tab_id: 4, x: 10, y: 10 }),
    });

    expect(result).toMatchObject({
      code: "timeout",
      data: { effect_state: "unknown", phase: "set_files" },
    });
    expect(detach).toHaveBeenCalledWith(4);
  });

  it("delivers staged files through one explicit native drop without clicking", async () => {
    const manager = sessions();
    const ctx = await manager.start("s1");
    ctx.refStore.set("e3", 123, { tabId: 4 });
    const lifecycle: string[] = [];
    const { cdp, calls } = dropCdp({ onCall: (method) => lifecycle.push(method) });
    const overlayPhases: string[] = [];

    const result = await handleUpload(
      manager,
      {
        session_id: "s1",
        ref: "@e3",
        mode: "drop",
        files: [{ transfer_id: "tr_1", name: "one.png", staged_path: "/stage/one.png" }],
      },
      {
        cdp,
        tabsApi: tabsApi(),
        sendToTab: vi.fn(async (_tabId, message) => {
          overlayPhases.push(message.phase);
          lifecycle.push(`overlay:${message.phase}`);
        }),
      },
    );

    expect(result).toMatchObject({ tab_id: 4, used_ref: "e3", file_names: ["one.png"] });
    expect(calls.filter((call) => call.method === "Input.dispatchDragEvent")).toEqual([
      {
        method: "Input.dispatchDragEvent",
        params: {
          type: "dragEnter",
          x: 110,
          y: 70,
          data: { items: [], files: ["/stage/one.png"], dragOperationsMask: 1 },
        },
      },
      {
        method: "Input.dispatchDragEvent",
        params: {
          type: "dragOver",
          x: 110,
          y: 70,
          data: { items: [], files: ["/stage/one.png"], dragOperationsMask: 1 },
        },
      },
      {
        method: "Input.dispatchDragEvent",
        params: {
          type: "drop",
          x: 110,
          y: 70,
          data: { items: [], files: ["/stage/one.png"], dragOperationsMask: 1 },
        },
      },
    ]);
    expect(calls.some((call) => call.method === "Input.dispatchMouseEvent")).toBe(false);
    expect(overlayPhases).toEqual(["begin", "end"]);
    expect(lifecycle.indexOf("DOM.getContentQuads")).toBeLessThan(
      lifecycle.indexOf("overlay:begin"),
    );
    expect(lifecycle.indexOf("overlay:begin")).toBeLessThan(
      lifecycle.indexOf("DOM.getNodeForLocation"),
    );
    expect(lifecycle.lastIndexOf("Input.dispatchDragEvent")).toBeLessThan(
      lifecycle.indexOf("overlay:end"),
    );
    expect(lifecycle.indexOf("DOM.getNodeForLocation")).toBeLessThan(
      lifecycle.indexOf("Runtime.releaseObjectGroup"),
    );
  });

  it("fails closed before dragging when another element owns the action point", async () => {
    const { cdp, calls } = dropCdp({ targetContainsPoint: false });
    const result = await uploadThroughFileDrop({
      cdp,
      actionTarget: actionTarget(),
      files: ["/stage/one.png"],
      timeoutMs: 100,
      withOverlayHidden: withoutOverlay,
    });

    expect(result).toMatchObject({
      code: "permission_denied",
      data: {
        reason: "file_drop_target_unavailable",
        mechanism: "drop",
        effect_state: "none",
        phase: "resolve_target",
      },
    });
    expect(calls.some((call) => call.method === "Input.dispatchDragEvent")).toBe(false);
  });

  it("dispatches an OOPIF file drop in the child target's local coordinates", async () => {
    const rootCalls: Array<{ method: string; params?: object }> = [];
    const childCalls: Array<{ method: string; params?: object }> = [];
    const rootSend = vi.fn(async (_tabId: number, method: string, params?: object) => {
      rootCalls.push({ method, params });
      if (method === "DOM.scrollIntoViewIfNeeded") return {};
      if (method === "DOM.getBoxModel") {
        return { model: { content: [100, 100, 300, 100, 300, 200, 100, 200] } };
      }
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
      }
      if (method === "DOM.getNodeForLocation") {
        return { backendNodeId: 10, frameId: "main" };
      }
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "owner-iframe" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: true } };
      }
      if (method === "Runtime.releaseObjectGroup") return {};
      throw new Error(`unexpected root command ${method}`);
    });
    const cdp: CdpRunner = createStubCdpRunner({
      send: rootSend as CdpRunner["send"],
      sendToFrame: vi.fn(async (handle, method, params) => {
        if (handle.frameId !== "child") {
          return rootSend(handle.tabId, method, params);
        }
        childCalls.push({ method, params });
        if (method === "DOM.scrollIntoViewIfNeeded") return {};
        if (method === "DOM.getContentQuads") {
          return { quads: [[10, 20, 210, 20, 210, 120, 10, 120]] };
        }
        if (method === "Runtime.evaluate")
          return { result: { value: { width: 400, height: 300 } } };
        if (method === "Page.getLayoutMetrics") {
          return { cssLayoutViewport: { clientWidth: 400, clientHeight: 300 } };
        }
        if (method === "DOM.getNodeForLocation") {
          return { backendNodeId: 124, frameId: "child" };
        }
        if (method === "DOM.resolveNode") {
          const id = (params as { backendNodeId?: number }).backendNodeId;
          return { object: { objectId: id === 123 ? "drop-target" : "hit-target" } };
        }
        if (method === "Runtime.callFunctionOn") return { result: { value: true } };
        if (method === "Input.dispatchDragEvent" || method === "Runtime.releaseObjectGroup") {
          return {};
        }
        throw new Error(`unexpected child command ${method}`);
      }) as CdpRunner["sendToFrame"],
      getFrameDocuments: vi.fn(async () => ({
        rootFrameId: "main",
        frames: [
          createFrameDocumentInfo({ tabId: 4, frameId: "main" }),
          createFrameDocumentInfo({
            tabId: 4,
            frameId: "child",
            parentFrameId: "main",
            ownerBackendNodeId: 10,
            processKey: "oopif:child",
            isOutOfProcess: true,
            loaderId: "child-loader",
          }),
        ],
      })),
    });

    const result = await uploadThroughFileDrop({
      cdp,
      actionTarget: actionTarget("child", "child-loader"),
      files: ["/stage/one.png"],
      timeoutMs: 100,
      withOverlayHidden: withoutOverlay,
    });

    expect(result).toMatchObject({ x: 110, y: 70 });
    expect(
      childCalls
        .filter((call) => call.method === "Input.dispatchDragEvent")
        .map((call) => call.params),
    ).toEqual([
      expect.objectContaining({ type: "dragEnter", x: 110, y: 70 }),
      expect.objectContaining({ type: "dragOver", x: 110, y: 70 }),
      expect.objectContaining({ type: "drop", x: 110, y: 70 }),
    ]);
    expect(rootCalls.some((call) => call.method === "Input.dispatchDragEvent")).toBe(false);
  });

  it("reports a missing native drag command as unsupported before commit", async () => {
    const { cdp } = dropCdp({
      dispatchError: (type) =>
        type === "dragEnter" ? new Error("'Input.dispatchDragEvent' wasn't found") : undefined,
    });
    const result = await uploadThroughFileDrop({
      cdp,
      actionTarget: actionTarget(),
      files: ["/stage/one.png"],
      timeoutMs: 100,
      withOverlayHidden: withoutOverlay,
    });

    expect(result).toMatchObject({
      code: "unsupported",
      data: {
        reason: "upload_mechanism_unsupported",
        effect_state: "none",
        phase: "drag_enter",
      },
    });
  });

  it("reports a drag_enter CDP refusal without sending dragCancel or detaching", async () => {
    const { cdp, calls, detach } = dropCdp({
      dispatchError: (type) =>
        type === "dragEnter"
          ? new Error("Input.dispatchDragEvent failed: -32000 Not allowed")
          : undefined,
    });
    const result = await uploadThroughFileDrop({
      cdp,
      actionTarget: actionTarget(),
      files: ["/stage/one.png"],
      timeoutMs: 1000,
      withOverlayHidden: withoutOverlay,
    });

    expect(result).toMatchObject({
      code: "cdp_failed",
      message: "Input.dispatchDragEvent failed: -32000 Not allowed",
      data: {
        reason: "file_drop_failed",
        effect_state: "none",
        phase: "drag_enter",
      },
    });
    expect((result as { data?: Record<string, unknown> }).data).not.toHaveProperty("cleanup_state");
    expect(calls).not.toContainEqual({
      method: "Input.dispatchDragEvent",
      params: expect.objectContaining({ type: "dragCancel" }),
    });
    expect(detach).not.toHaveBeenCalled();
  });

  it("cancels an unresolved drag before returning a pre-commit timeout", async () => {
    const { cdp, calls } = dropCdp({
      dispatchError: (type) => (type === "dragEnter" ? new Promise<never>(() => {}) : undefined),
    });
    const result = await uploadThroughFileDrop({
      cdp,
      actionTarget: actionTarget(),
      files: ["/stage/one.png"],
      timeoutMs: 10,
      withOverlayHidden: withoutOverlay,
    });

    expect(result).toMatchObject({
      code: "timeout",
      data: { reason: "file_drop_failed", effect_state: "none", phase: "drag_enter" },
    });
    expect(calls).toContainEqual({
      method: "Input.dispatchDragEvent",
      params: expect.objectContaining({ type: "dragCancel" }),
    });
  });

  it("marks an unresolved drop unknown and detaches browser state", async () => {
    const { cdp, detach } = dropCdp({
      dispatchError: (type) => (type === "drop" ? new Promise<never>(() => {}) : undefined),
    });
    const result = await uploadThroughFileDrop({
      cdp,
      actionTarget: actionTarget(),
      files: ["/stage/one.png"],
      timeoutMs: 10,
      withOverlayHidden: withoutOverlay,
    });

    expect(result).toMatchObject({
      code: "timeout",
      data: { reason: "file_drop_failed", effect_state: "unknown", phase: "drop" },
    });
    expect(detach).toHaveBeenCalledWith(4);
  });

  it.each([false, true])("routes an exact-target download (covered=%s)", async (covered) => {
    const manager = sessions();
    const ctx = await manager.start("s1");
    ctx.refStore.set("e3", 123, { tabId: 4 });
    const onCreated = fakeEvent<(item: chrome.downloads.DownloadItem) => void>();
    const onChanged = fakeEvent<(delta: chrome.downloads.DownloadDelta) => void>();
    const onDeterminingFilename =
      fakeEvent<
        (
          item: chrome.downloads.DownloadItem,
          suggest: (suggestion?: chrome.downloads.DownloadFilenameSuggestion) => void,
        ) => void | true
      >();
    const initial = {
      id: 9,
      url: "https://example.test/result.zip",
      finalUrl: "https://example.test/result.zip",
      filename: "result.zip",
      state: "in_progress",
      fileSize: -1,
      totalBytes: 12,
      mime: "application/zip",
      danger: "safe",
    } as chrome.downloads.DownloadItem;
    const completed = {
      ...initial,
      filename: "C:\\Users\\tester\\Downloads\\BrowserSkill\\tr_1\\result.zip",
      state: "complete",
      fileSize: 12,
    } as chrome.downloads.DownloadItem;
    const downloads: DownloadsApi = {
      onCreated,
      onChanged,
      onDeterminingFilename,
      search: vi.fn(async () => [completed]),
      cancel: vi.fn(async () => {}),
      removeFile: vi.fn(async () => {}),
    };
    let cdpEvent: Parameters<NonNullable<CdpRunner["onEvent"]>>[1] | undefined;
    let suggested: chrome.downloads.DownloadFilenameSuggestion | undefined;
    let passthrough = false;
    const sendInputPassthrough = vi.fn(async (_tab: number, message: InputPassthroughMessage) => {
      passthrough = message.phase === "begin";
    });
    const send = vi.fn(async (_tabId: number, method: string, params?: object) => {
      if (
        method === "Runtime.evaluate" &&
        (params as { expression?: string })?.expression === "document.visibilityState"
      )
        return { result: { value: "visible" } };
      if (
        method === "Runtime.evaluate" &&
        String((params as { expression?: string })?.expression).includes('return "absent"')
      )
        return { result: { value: covered && !passthrough ? "covered" : "clear" } };
      if (method === "Page.getLayoutMetrics")
        return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
      if (method === "DOM.getContentQuads") return { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] };
      if (
        method === "Input.dispatchMouseEvent" &&
        (params as { type?: string }).type === "mousePressed"
      ) {
        cdpEvent?.(rootEventSource(4), "Page.downloadWillBegin", {
          url: initial.url,
          suggestedFilename: "result.zip",
        });
        await new Promise<void>((resolve) => {
          onDeterminingFilename.emit(initial, (value) => {
            suggested = value;
            resolve();
          });
        });
        onCreated.emit(completed);
      }
      return {};
    });
    const cdp: CdpRunner = createStubCdpRunner({
      send: send as unknown as CdpRunner["send"],
      onEvent: (_tabId, handler) => {
        cdpEvent = handler;
        return { dispose: vi.fn() };
      },
    });

    const result = await handleDownload(
      manager,
      { session_id: "s1", ref: "@e3", browser_relative_dir: "BrowserSkill/tr_1" },
      {
        cdp,
        tabsApi: tabsApi(),
        downloads,
        navigationTargets: popupDownloadFakes().navigationTargets,
        sendInputPassthrough,
      },
    );
    expect(sendInputPassthrough.mock.calls.map(([, m]) => m.phase)).toEqual(
      covered ? ["begin", "end"] : [],
    );
    expect(passthrough).toBe(false);

    expect(suggested).toEqual({
      filename: "BrowserSkill/tr_1/result.zip",
      conflictAction: "overwrite",
    });
    expect(result).toMatchObject({
      tab_id: 4,
      suggested_filename: "result.zip",
      byte_size: 12,
      browser_path: completed.filename,
    });
  });

  it("does not claim a download without an intent from the exact target", async () => {
    const onCreated = fakeEvent<(item: chrome.downloads.DownloadItem) => void>();
    const onChanged = fakeEvent<(delta: chrome.downloads.DownloadDelta) => void>();
    const onDeterminingFilename =
      fakeEvent<
        (
          item: chrome.downloads.DownloadItem,
          suggest: (suggestion?: chrome.downloads.DownloadFilenameSuggestion) => void,
        ) => void | true
      >();
    const downloads: DownloadsApi = {
      onCreated,
      onChanged,
      onDeterminingFilename,
      search: vi.fn(async () => []),
      cancel: vi.fn(async () => {}),
      removeFile: vi.fn(async () => {}),
    };
    let cdpEvent: Parameters<NonNullable<CdpRunner["onEvent"]>>[1] | undefined;
    const cdp: CdpRunner = createStubCdpRunner({
      send: vi.fn(async () => ({})) as unknown as CdpRunner["send"],
      isEventFromFrame: (source, handle) =>
        source.tabId === handle.tabId && source.targetKey === "expected-child",
      onEvent: (_tabId, handler) => {
        cdpEvent = handler;
        return { dispose: vi.fn() };
      },
    });
    const unrelated = {
      id: 17,
      url: "https://example.test/unrelated.zip",
      finalUrl: "https://example.test/unrelated.zip",
      filename: "unrelated.zip",
      state: "in_progress",
    } as chrome.downloads.DownloadItem;
    let defaultSuggestionCalled = false;

    const result = await captureBrowserDownload({
      cdp,
      handle: { tabId: 4, frameId: "expected-child", loaderId: "child-loader" },
      downloads,
      browserRelativeDir: "BrowserSkill/tr_1",
      timeoutMs: 5,
      trigger: async (markDispatched) => {
        markDispatched();
        cdpEvent?.(targetEventSource(4, "other-child"), "Page.downloadWillBegin", {
          url: unrelated.url,
          suggestedFilename: unrelated.filename,
        });
        onDeterminingFilename.emit(unrelated, (suggestion) => {
          defaultSuggestionCalled = suggestion === undefined;
        });
        return { tab_id: 4, x: 10, y: 10 };
      },
    });

    expect(defaultSuggestionCalled).toBe(true);
    expect(downloads.cancel).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      code: "cdp_failed",
      data: { reason: "download_capture_failed" },
    });
  });

  it("correlates a filename candidate that arrives before the CDP intent", async () => {
    const onCreated = fakeEvent<(item: chrome.downloads.DownloadItem) => void>();
    const onChanged = fakeEvent<(delta: chrome.downloads.DownloadDelta) => void>();
    const onDeterminingFilename =
      fakeEvent<
        (
          item: chrome.downloads.DownloadItem,
          suggest: (suggestion?: chrome.downloads.DownloadFilenameSuggestion) => void,
        ) => void | true
      >();
    const initial = {
      id: 21,
      url: "https://example.test/candidate-first.bin",
      finalUrl: "https://example.test/candidate-first.bin",
      filename: "candidate-first.bin",
      state: "in_progress",
      fileSize: -1,
      totalBytes: 4,
      bytesReceived: 0,
    } as chrome.downloads.DownloadItem;
    const complete = {
      ...initial,
      filename: "/profile/Downloads/BrowserSkill/tr_21/candidate-first.bin",
      state: "complete",
      fileSize: 4,
    } as chrome.downloads.DownloadItem;
    const downloads: DownloadsApi = {
      onCreated,
      onChanged,
      onDeterminingFilename,
      search: vi.fn(async () => [complete]),
      cancel: vi.fn(async () => {}),
      removeFile: vi.fn(async () => {}),
    };
    let cdpEvent: Parameters<NonNullable<CdpRunner["onEvent"]>>[1] | undefined;
    const cdp: CdpRunner = createStubCdpRunner({
      send: vi.fn(async () => ({})) as CdpRunner["send"],
      onEvent: (_tabId, handler) => {
        cdpEvent = handler;
        return { dispose: vi.fn() };
      },
    });
    let suggestion: chrome.downloads.DownloadFilenameSuggestion | undefined;

    const result = await captureBrowserDownload({
      cdp,
      handle: { tabId: 4, frameId: "", loaderId: "" },
      downloads,
      browserRelativeDir: "BrowserSkill/tr_21",
      timeoutMs: 1_000,
      trigger: async (markDispatched) => {
        markDispatched();
        const suggested = new Promise<void>((resolve) => {
          onDeterminingFilename.emit(initial, (value) => {
            suggestion = value;
            resolve();
          });
        });
        cdpEvent?.(rootEventSource(4), "Page.downloadWillBegin", {
          url: initial.url,
          suggestedFilename: initial.filename,
        });
        await suggested;
        onCreated.emit(complete);
        return { tab_id: 4, x: 10, y: 10 };
      },
    });

    expect(suggestion).toEqual({
      filename: "BrowserSkill/tr_21/candidate-first.bin",
      conflictAction: "overwrite",
    });
    expect(result).toMatchObject({ item: { id: 21, state: "complete" } });
  });

  it("removes a completed download when the final size exceeds the limit", async () => {
    const onCreated = fakeEvent<(item: chrome.downloads.DownloadItem) => void>();
    const onChanged = fakeEvent<(delta: chrome.downloads.DownloadDelta) => void>();
    const onDeterminingFilename =
      fakeEvent<
        (
          item: chrome.downloads.DownloadItem,
          suggest: (suggestion?: chrome.downloads.DownloadFilenameSuggestion) => void,
        ) => void | true
      >();
    const initial = {
      id: 22,
      url: "https://example.test/oversized.bin",
      finalUrl: "https://example.test/oversized.bin",
      filename: "oversized.bin",
      state: "in_progress",
      fileSize: -1,
      totalBytes: -1,
      bytesReceived: 0,
    } as chrome.downloads.DownloadItem;
    const complete = {
      ...initial,
      filename: "/profile/Downloads/BrowserSkill/tr_22/oversized.bin",
      state: "complete",
      fileSize: 8,
      totalBytes: 8,
      bytesReceived: 8,
    } as chrome.downloads.DownloadItem;
    const downloads: DownloadsApi = {
      onCreated,
      onChanged,
      onDeterminingFilename,
      search: vi.fn(async () => [complete]),
      cancel: vi.fn(async () => {}),
      removeFile: vi.fn(async () => {}),
    };
    let cdpEvent: Parameters<NonNullable<CdpRunner["onEvent"]>>[1] | undefined;
    const cdp: CdpRunner = createStubCdpRunner({
      send: vi.fn(async () => ({})) as CdpRunner["send"],
      onEvent: (_tabId, handler) => {
        cdpEvent = handler;
        return { dispose: vi.fn() };
      },
    });

    const result = await captureBrowserDownload({
      cdp,
      handle: { tabId: 4, frameId: "", loaderId: "" },
      downloads,
      browserRelativeDir: "BrowserSkill/tr_22",
      maxByteSize: 4,
      timeoutMs: 1_000,
      trigger: async (markDispatched) => {
        markDispatched();
        cdpEvent?.(rootEventSource(4), "Page.downloadWillBegin", {
          url: initial.url,
          suggestedFilename: initial.filename,
        });
        await new Promise<void>((resolve) => {
          onDeterminingFilename.emit(initial, () => resolve());
        });
        onCreated.emit(initial);
        onChanged.emit({ id: initial.id, state: { current: "complete" } });
        return { tab_id: 4, x: 10, y: 10 };
      },
    });

    expect(result).toMatchObject({
      code: "cdp_failed",
      data: { reason: "download_capture_failed", effect_state: "committed" },
    });
    expect(downloads.removeFile).toHaveBeenCalledWith(initial.id);
    expect(downloads.cancel).not.toHaveBeenCalled();
  });

  it("reconciles a download that completes while cancellation is being requested", async () => {
    const onCreated = fakeEvent<(item: chrome.downloads.DownloadItem) => void>();
    const onChanged = fakeEvent<(delta: chrome.downloads.DownloadDelta) => void>();
    const onDeterminingFilename =
      fakeEvent<
        (
          item: chrome.downloads.DownloadItem,
          suggest: (suggestion?: chrome.downloads.DownloadFilenameSuggestion) => void,
        ) => void | true
      >();
    const initial = {
      id: 23,
      url: "https://example.test/racing.bin",
      finalUrl: "https://example.test/racing.bin",
      filename: "racing.bin",
      state: "in_progress",
      fileSize: -1,
      totalBytes: -1,
      bytesReceived: 0,
    } as chrome.downloads.DownloadItem;
    const complete = {
      ...initial,
      filename: "/profile/Downloads/BrowserSkill/tr_23/racing.bin",
      state: "complete",
      fileSize: 4,
      totalBytes: 4,
      bytesReceived: 4,
    } as chrome.downloads.DownloadItem;
    const downloads: DownloadsApi = {
      onCreated,
      onChanged,
      onDeterminingFilename,
      search: vi.fn().mockResolvedValueOnce([initial]).mockResolvedValueOnce([complete]),
      cancel: vi.fn(async () => {
        throw new Error("download already complete");
      }),
      removeFile: vi.fn(async () => {}),
    };
    let cdpEvent: Parameters<NonNullable<CdpRunner["onEvent"]>>[1] | undefined;
    const cdp: CdpRunner = createStubCdpRunner({
      send: vi.fn(async () => ({})) as CdpRunner["send"],
      onEvent: (_tabId, handler) => {
        cdpEvent = handler;
        return { dispose: vi.fn() };
      },
    });

    const result = await captureBrowserDownload({
      cdp,
      handle: { tabId: 4, frameId: "", loaderId: "" },
      downloads,
      browserRelativeDir: "BrowserSkill/tr_23",
      timeoutMs: 80,
      trigger: async (markDispatched) => {
        markDispatched();
        cdpEvent?.(rootEventSource(4), "Page.downloadWillBegin", {
          url: initial.url,
          suggestedFilename: initial.filename,
        });
        await new Promise<void>((resolve) => {
          onDeterminingFilename.emit(initial, () => resolve());
        });
        onCreated.emit(initial);
        return { tab_id: 4, x: 10, y: 10 };
      },
    });

    expect(result).toMatchObject({
      code: "cdp_failed",
      data: { reason: "download_capture_failed", effect_state: "committed" },
    });
    expect(downloads.cancel).toHaveBeenCalledWith(initial.id);
    expect(downloads.removeFile).toHaveBeenCalledWith(initial.id);
    expect(result).not.toMatchObject({ data: { cleanup_state: "failed" } });
  });

  it("rejects ambiguous attribution without cancelling either unclaimed download", async () => {
    const onCreated = fakeEvent<(item: chrome.downloads.DownloadItem) => void>();
    const onChanged = fakeEvent<(delta: chrome.downloads.DownloadDelta) => void>();
    const onDeterminingFilename =
      fakeEvent<
        (
          item: chrome.downloads.DownloadItem,
          suggest: (suggestion?: chrome.downloads.DownloadFilenameSuggestion) => void,
        ) => void | true
      >();
    const downloads: DownloadsApi = {
      onCreated,
      onChanged,
      onDeterminingFilename,
      search: vi.fn(async () => []),
      cancel: vi.fn(async () => {}),
      removeFile: vi.fn(async () => {}),
    };
    let cdpEvent: Parameters<NonNullable<CdpRunner["onEvent"]>>[1] | undefined;
    const cdp: CdpRunner = createStubCdpRunner({
      send: vi.fn(async () => ({})) as CdpRunner["send"],
      onEvent: (_tabId, handler) => {
        cdpEvent = handler;
        return { dispose: vi.fn() };
      },
    });
    const defaults: number[] = [];
    const candidate = (id: number) =>
      ({
        id,
        url: "https://example.test/same.bin",
        finalUrl: "https://example.test/same.bin",
        filename: "same.bin",
        state: "in_progress",
      }) as chrome.downloads.DownloadItem;

    const result = await captureBrowserDownload({
      cdp,
      handle: { tabId: 4, frameId: "", loaderId: "" },
      downloads,
      browserRelativeDir: "BrowserSkill/tr_ambiguous",
      timeoutMs: 100,
      trigger: async (markDispatched) => {
        markDispatched();
        cdpEvent?.(rootEventSource(4), "Page.downloadWillBegin", {
          url: "https://example.test/same.bin",
          suggestedFilename: "same.bin",
        });
        for (const id of [31, 32]) {
          onDeterminingFilename.emit(candidate(id), (value) => {
            if (value === undefined) defaults.push(id);
          });
        }
        return { tab_id: 4, x: 10, y: 10 };
      },
    });

    expect(defaults.sort()).toEqual([31, 32]);
    expect(downloads.cancel).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      code: "cdp_failed",
      data: { effect_state: "unknown", phase: "attribution" },
    });
  });

  it("routes an attachment that the clicked link opens in a new tab", async () => {
    const manager = sessions();
    const ctx = await manager.start("s1");
    ctx.refStore.set("e3", 123, { tabId: 4 });
    const fakes = popupDownloadFakes();
    const download = fakes.item(50, "https://example.test/export?id=50");
    let suggested: Promise<chrome.downloads.DownloadFilenameSuggestion | undefined> | undefined;
    const send = vi.fn(async (_tabId: number, method: string, params?: object) => {
      if (
        method === "Runtime.evaluate" &&
        (params as { expression?: string })?.expression === "document.visibilityState"
      )
        return { result: { value: "visible" } };
      if (method === "Page.getLayoutMetrics")
        return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
      if (method === "DOM.getContentQuads") return { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] };
      if (
        method === "Input.dispatchMouseEvent" &&
        (params as { type?: string }).type === "mousePressed"
      ) {
        fakes.popup(4, download.url);
        suggested = fakes.offer(download);
        fakes.finish(download);
      }
      return {};
    });

    const result = await handleDownload(
      manager,
      {
        session_id: "s1",
        ref: "@e3",
        browser_relative_dir: "BrowserSkill/tr_50",
        timeout_ms: 1_000,
      },
      {
        cdp: silentCdp(send as unknown as CdpRunner["send"]),
        tabsApi: tabsApi(),
        downloads: fakes.downloads,
        navigationTargets: fakes.navigationTargets,
      },
    );

    await expect(suggested).resolves.toEqual({
      filename: "BrowserSkill/tr_50/report-50.csv",
      conflictAction: "overwrite",
    });
    expect(result).toMatchObject({
      tab_id: 4,
      suggested_filename: "report-50.csv",
      browser_path: "/profile/Downloads/BrowserSkill/tr_50/report-50.csv",
    });
  });

  it.each([
    "C:\\Users\\tester\\Downloads\\report-60.csv",
    "C:\\Users\\tester\\Documents\\report-60.csv",
  ])("rejects a download outside its transfer directory without deleting %s", async (filename) => {
    const fakes = popupDownloadFakes();
    const download = fakes.item(60, "https://example.test/export?id=60");

    const result = await captureBrowserDownload({
      cdp: silentCdp(),
      handle: { tabId: 4, frameId: "", loaderId: "" },
      downloads: fakes.downloads,
      navigationTargets: fakes.navigationTargets,
      browserRelativeDir: "BrowserSkill/tr_60",
      timeoutMs: 1_000,
      trigger: async (markDispatched) => {
        markDispatched();
        fakes.popup(4, download.url);
        await fakes.offer(download);
        fakes.finishChanged(download, filename);
        return { tab_id: 4, x: 10, y: 10 };
      },
    });

    expect(result).toMatchObject({
      code: "cdp_failed",
      data: { reason: "download_path_mismatch", effect_state: "committed" },
    });
    expect(fakes.downloads.removeFile).not.toHaveBeenCalled();
    expect(fakes.downloads.cancel).not.toHaveBeenCalled();
    expect(result).not.toMatchObject({ data: { cleanup_state: "failed" } });
  });

  it.each([
    "navigation-first",
    "candidate-first",
  ])("correlates a new-tab download in either arrival order (%s)", async (order) => {
    const fakes = popupDownloadFakes();
    const download = fakes.item(
      51,
      "https://example.test/export?id=51",
      "https://cdn.example.test/report.csv",
    );
    let suggested: Promise<chrome.downloads.DownloadFilenameSuggestion | undefined> | undefined;

    const result = await captureBrowserDownload({
      cdp: silentCdp(),
      handle: { tabId: 4, frameId: "", loaderId: "" },
      downloads: fakes.downloads,
      navigationTargets: fakes.navigationTargets,
      browserRelativeDir: "BrowserSkill/tr_51",
      timeoutMs: 1_000,
      trigger: async (markDispatched) => {
        markDispatched();
        if (order === "navigation-first") fakes.popup(4, download.url);
        suggested = fakes.offer(download);
        if (order === "candidate-first") fakes.popup(4, download.url);
        fakes.finish(download);
        return { tab_id: 4, x: 10, y: 10 };
      },
    });

    await expect(suggested).resolves.toEqual({
      filename: "BrowserSkill/tr_51/report-51.csv",
      conflictAction: "overwrite",
    });
    expect(result).toMatchObject({ item: { id: 51, state: "complete" } });
  });

  it("ignores new tabs opened before mouse press or by another tab", async () => {
    const fakes = popupDownloadFakes();
    const url = "https://example.test/export?id=52";
    let suggested: Promise<chrome.downloads.DownloadFilenameSuggestion | undefined> | undefined;

    const result = await captureBrowserDownload({
      cdp: silentCdp(),
      handle: { tabId: 4, frameId: "", loaderId: "" },
      downloads: fakes.downloads,
      navigationTargets: fakes.navigationTargets,
      browserRelativeDir: "BrowserSkill/tr_52",
      timeoutMs: 100,
      trigger: async (markDispatched) => {
        fakes.popup(4, url);
        markDispatched();
        fakes.popup(5, url);
        suggested = fakes.offer(fakes.item(52, url));
        return { tab_id: 4, x: 10, y: 10 };
      },
    });

    await expect(suggested).resolves.toBeUndefined();
    expect(fakes.downloads.cancel).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      code: "cdp_failed",
      data: { reason: "download_capture_failed", phase: "attribution" },
    });
  });

  it("does not attribute a same-URL download observed before mouse press", async () => {
    const fakes = popupDownloadFakes();
    const url = "https://example.test/export?id=53";
    const own = fakes.item(54, url);
    let earlier: Promise<chrome.downloads.DownloadFilenameSuggestion | undefined> | undefined;
    let suggested: Promise<chrome.downloads.DownloadFilenameSuggestion | undefined> | undefined;

    const result = await captureBrowserDownload({
      cdp: silentCdp(),
      handle: { tabId: 4, frameId: "", loaderId: "" },
      downloads: fakes.downloads,
      navigationTargets: fakes.navigationTargets,
      browserRelativeDir: "BrowserSkill/tr_54",
      timeoutMs: 1_000,
      trigger: async (markDispatched) => {
        earlier = fakes.offer(fakes.item(53, url));
        markDispatched();
        fakes.popup(4, url);
        suggested = fakes.offer(own);
        fakes.finish(own);
        return { tab_id: 4, x: 10, y: 10 };
      },
    });

    expect(result).toMatchObject({ item: { id: 54, state: "complete" } });
    await expect(suggested).resolves.toMatchObject({
      filename: "BrowserSkill/tr_54/report-54.csv",
    });
    await expect(earlier).resolves.toBeUndefined();
    expect(fakes.downloads.cancel).not.toHaveBeenCalled();
  });

  it("rejects ambiguous new-tab attribution without cancelling either download", async () => {
    const fakes = popupDownloadFakes();
    const url = "https://example.test/export?id=55";
    const suggestions: Array<Promise<chrome.downloads.DownloadFilenameSuggestion | undefined>> = [];

    const result = await captureBrowserDownload({
      cdp: silentCdp(),
      handle: { tabId: 4, frameId: "", loaderId: "" },
      downloads: fakes.downloads,
      navigationTargets: fakes.navigationTargets,
      browserRelativeDir: "BrowserSkill/tr_55",
      timeoutMs: 1_000,
      trigger: async (markDispatched) => {
        markDispatched();
        fakes.popup(4, url);
        suggestions.push(fakes.offer(fakes.item(55, url)), fakes.offer(fakes.item(56, url)));
        return { tab_id: 4, x: 10, y: 10 };
      },
    });

    await expect(Promise.all(suggestions)).resolves.toEqual([undefined, undefined]);
    expect(fakes.downloads.cancel).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      code: "cdp_failed",
      data: { effect_state: "unknown", phase: "attribution" },
    });
  });

  it("reports an unknown effect when the click fails after opening a new tab", async () => {
    const fakes = popupDownloadFakes();

    const result = await captureBrowserDownload({
      cdp: silentCdp(),
      handle: { tabId: 4, frameId: "", loaderId: "" },
      downloads: fakes.downloads,
      navigationTargets: fakes.navigationTargets,
      browserRelativeDir: "BrowserSkill/tr_57",
      timeoutMs: 1_000,
      trigger: async (markDispatched) => {
        markDispatched();
        fakes.popup(4, "https://example.test/export?id=57");
        return { code: "cdp_failed", message: "mouseReleased failed" };
      },
    });

    expect(result).toMatchObject({
      code: "cdp_failed",
      data: { effect_state: "unknown", phase: "trigger" },
    });
  });

  it.each([
    "timeout",
    "abort",
  ] as const)("cleans up file chooser interception when arming ends on %s", async (boundary) => {
    const calls: Array<{ method: string; params?: object }> = [];
    const abort = new AbortController();
    const cdp: CdpRunner = createStubCdpRunner({
      send: vi.fn(async (_tabId: number, method: string, params?: object) => {
        calls.push({ method, params });
        if (
          method === "Page.setInterceptFileChooserDialog" &&
          (params as { enabled?: boolean })?.enabled
        ) {
          if (boundary === "abort") abort.abort();
          return new Promise<never>(() => {});
        }
        return {};
      }) as CdpRunner["send"],
      onEvent: () => ({ dispose: vi.fn() }),
    });

    const result = await uploadThroughActivatedFileInput({
      cdp,
      actionTarget: actionTarget(),
      files: ["/private/stage/one"],
      timeoutMs: 15,
      signal: abort.signal,
      trigger: async () => ({ tab_id: 4, x: 10, y: 10 }),
    });

    expect(result).toMatchObject({
      code: boundary === "abort" ? "cancelled" : "timeout",
      data: { reason: "file_input_probe_failed", effect_state: "none", phase: "arm_interception" },
    });
    expect(calls).toContainEqual({
      method: "Page.setInterceptFileChooserDialog",
      params: { enabled: false, cancel: true },
    });
  });

  it("cleans up the capture-phase click probe and chooser interception on arming timeout", async () => {
    const calls: Array<{ method: string; params?: object }> = [];
    let callFnCount = 0;
    const cdp: CdpRunner = createStubCdpRunner({
      send: vi.fn(async (_tabId: number, method: string, params?: object) => {
        calls.push({ method, params });
        if (method === "DOM.resolveNode") return { object: { objectId: "trigger-object" } };
        if (method === "Runtime.callFunctionOn") {
          callFnCount++;
          if (callFnCount === 1) return new Promise<never>(() => {});
          return { result: { value: true } };
        }
        return {};
      }) as CdpRunner["send"],
      onEvent: () => ({ dispose: vi.fn() }),
    });

    const result = await uploadThroughActivatedFileInput({
      cdp,
      actionTarget: actionTarget(),
      files: ["/private/stage/one"],
      timeoutMs: 15,
      trigger: async () => ({ tab_id: 4, x: 10, y: 10 }),
    });

    expect(result).toMatchObject({
      code: "timeout",
      data: { reason: "file_input_probe_failed", effect_state: "none", phase: "arm_input_probe" },
    });
    expect(
      calls.some(
        (c) =>
          c.method === "Runtime.callFunctionOn" &&
          String((c.params as { functionDeclaration?: string })?.functionDeclaration).includes(
            "removeEventListener",
          ),
      ),
    ).toBe(true);
    expect(calls).toContainEqual({
      method: "Page.setInterceptFileChooserDialog",
      params: { enabled: false, cancel: true },
    });
  });

  it("blocks an OOPIF drop target occluded by a parent-page overlay before dispatching drag events", async () => {
    const childCalls: Array<{ method: string; params?: object }> = [];
    const rootSend = vi.fn(async (_tabId: number, method: string, params?: object) => {
      if (method === "DOM.scrollIntoViewIfNeeded") return {};
      if (method === "Page.getLayoutMetrics")
        return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
      if (method === "DOM.getBoxModel")
        return { model: { content: [100, 50, 300, 50, 300, 250, 100, 250] } };
      if (method === "DOM.getNodeForLocation") return { backendNodeId: 999, frameId: "main" };
      if (method === "DOM.resolveNode") {
        const id = (params as { backendNodeId?: number }).backendNodeId;
        return { object: { objectId: id === 10 ? "iframe-owner" : "parent-modal" } };
      }
      if (method === "Runtime.callFunctionOn") return { result: { value: false } };
      if (method === "Runtime.releaseObjectGroup") return {};
      throw new Error(`unexpected root command ${method}`);
    });
    const childSend = vi.fn(async (_tabId: number, method: string, params?: object) => {
      childCalls.push({ method, params });
      if (method === "DOM.scrollIntoViewIfNeeded") return {};
      if (method === "Runtime.evaluate") return { result: { value: { width: 200, height: 200 } } };
      if (method === "Page.getLayoutMetrics")
        return { cssLayoutViewport: { clientWidth: 200, clientHeight: 200 } };
      if (method === "DOM.getContentQuads")
        return { quads: [[10, 20, 210, 20, 210, 120, 10, 120]] };
      if (method === "Runtime.releaseObjectGroup") return {};
      throw new Error(`unexpected child command ${method}`);
    });
    const cdp: CdpRunner = createStubCdpRunner({
      send: rootSend as CdpRunner["send"],
      sendToFrame: vi.fn(async (handle, method, params) =>
        handle.frameId === "child"
          ? childSend(handle.tabId, method, params)
          : rootSend(handle.tabId, method, params),
      ) as CdpRunner["sendToFrame"],
      hasOwnFrameTarget: (_tabId, frameId) => frameId === "child",
      getFrameDocuments: vi.fn(async () => ({
        rootFrameId: "main",
        frames: [
          createFrameDocumentInfo({ tabId: 4, frameId: "main" }),
          createFrameDocumentInfo({
            tabId: 4,
            frameId: "child",
            parentFrameId: "main",
            ownerBackendNodeId: 10,
            processKey: "oopif:child",
            isOutOfProcess: true,
            loaderId: "child-loader",
          }),
        ],
      })),
    });

    const result = await uploadThroughFileDrop({
      cdp,
      actionTarget: actionTarget("child", "child-loader"),
      files: ["/stage/one.png"],
      timeoutMs: 100,
      withOverlayHidden: withoutOverlay,
    });

    expect(result).toMatchObject({
      code: "permission_denied",
      data: {
        reason: "file_drop_target_unavailable",
        effect_state: "none",
        phase: "resolve_target",
      },
    });
    expect(childCalls.some((c) => c.method === "Input.dispatchDragEvent")).toBe(false);
  });

  it.each([
    "dynamic-hidden-iframe",
    "preexisting-cross-origin-iframe",
  ] as const)("attributes a download triggered via %s descendant of the main frame", async (kind) => {
    const fakes = popupDownloadFakes();
    const download = fakes.item(71, "https://cdn.example.test/export.csv");
    let cdpEvent: Parameters<NonNullable<CdpRunner["onEvent"]>>[1] | undefined;
    let suggested: Promise<chrome.downloads.DownloadFilenameSuggestion | undefined> | undefined;
    const cdp: CdpRunner = createStubCdpRunner({
      send: vi.fn(async () => ({})) as CdpRunner["send"],
      getFrameDocuments: vi.fn(async () => ({
        rootFrameId: "main",
        frames: [
          createFrameDocumentInfo({ tabId: 4, frameId: "main" }),
          createFrameDocumentInfo({
            tabId: 4,
            frameId: "cdn-iframe",
            parentFrameId: "main",
            processKey: "oopif:cdn-iframe",
            isOutOfProcess: true,
          }),
        ],
      })),
      onEvent: (_tabId, handler) => {
        cdpEvent = handler;
        return { dispose: vi.fn() };
      },
    });

    const result = await captureBrowserDownload({
      cdp,
      handle: { tabId: 4, frameId: "main", loaderId: "main-loader" },
      downloads: fakes.downloads,
      navigationTargets: fakes.navigationTargets,
      browserRelativeDir: "BrowserSkill/tr_71",
      timeoutMs: 1_000,
      trigger: async (markDispatched) => {
        markDispatched();
        if (kind === "dynamic-hidden-iframe") {
          cdpEvent?.(rootEventSource(4), "Page.frameAttached", {
            frameId: "hidden-iframe",
            parentFrameId: "main",
          });
          cdpEvent?.(rootEventSource(4), "Page.downloadWillBegin", {
            frameId: "hidden-iframe",
            url: download.url,
            suggestedFilename: download.filename,
          });
        } else {
          cdpEvent?.(targetEventSource(4, "oopif:cdn-iframe"), "Page.downloadWillBegin", {
            frameId: "cdn-iframe",
            url: download.url,
            suggestedFilename: download.filename,
          });
        }
        suggested = fakes.offer(download);
        fakes.finish(download);
        return { tab_id: 4, x: 10, y: 10 };
      },
    });

    await expect(suggested).resolves.toEqual({
      filename: "BrowserSkill/tr_71/report-71.csv",
      conflictAction: "overwrite",
    });
    expect(result).toMatchObject({ item: { id: 71, state: "complete" } });
  });

  it("aborts a queued chooser-enable guard on timeout so enabled:true cannot dispatch after cleanup", async () => {
    const dispatched: Array<{ method: string; params?: object }> = [];
    let releaseQueue!: () => void;
    const queued = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const cdp: CdpRunner = createStubCdpRunner({
      send: vi.fn(async () => ({})) as CdpRunner["send"],
      sendToFrame: vi.fn(
        async (
          _handle,
          method: string,
          params?: object,
          guard?: { signal?: AbortSignal; onDispatch?: () => void },
        ) => {
          if (
            method === "Page.setInterceptFileChooserDialog" &&
            (params as { enabled?: boolean })?.enabled
          ) {
            await queued;
            if (guard?.signal?.aborted) throw new DOMException("aborted", "AbortError");
          }
          guard?.onDispatch?.();
          dispatched.push({ method, params });
          return {};
        },
      ) as CdpRunner["sendToFrame"],
      onEvent: () => ({ dispose: vi.fn() }),
    });

    const result = await uploadThroughActivatedFileInput({
      cdp,
      actionTarget: actionTarget(),
      files: ["/private/stage/one"],
      timeoutMs: 15,
      trigger: async () => ({ tab_id: 4, x: 10, y: 10 }),
    });
    releaseQueue();
    await new Promise((r) => setTimeout(r, 10));

    expect(result).toMatchObject({
      code: "timeout",
      data: { reason: "file_input_probe_failed", effect_state: "none", phase: "arm_interception" },
    });
    expect(dispatched).not.toContainEqual({
      method: "Page.setInterceptFileChooserDialog",
      params: { enabled: true },
    });
  });

  it("keeps a matching download candidate pending while frame hierarchy lookup exceeds 750ms", async () => {
    vi.useFakeTimers();
    try {
      const fakes = popupDownloadFakes();
      const download = fakes.item(72, "https://cdn.example.test/slow-hierarchy.csv");
      let cdpEvent: Parameters<NonNullable<CdpRunner["onEvent"]>>[1] | undefined;
      let suggested: Promise<chrome.downloads.DownloadFilenameSuggestion | undefined> | undefined;
      const cdp: CdpRunner = createStubCdpRunner({
        send: vi.fn(async () => ({})) as CdpRunner["send"],
        getFrameDocuments: vi.fn(
          () =>
            new Promise((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    rootFrameId: "main",
                    frames: [
                      createFrameDocumentInfo({ tabId: 4, frameId: "main" }),
                      createFrameDocumentInfo({
                        tabId: 4,
                        frameId: "slow-cdn",
                        parentFrameId: "main",
                      }),
                    ],
                  }),
                850,
              ),
            ),
        ) as CdpRunner["getFrameDocuments"],
        onEvent: (_tabId, handler) => {
          cdpEvent = handler;
          return { dispose: vi.fn() };
        },
      });

      const pending = captureBrowserDownload({
        cdp,
        handle: { tabId: 4, frameId: "main", loaderId: "main-loader" },
        downloads: fakes.downloads,
        navigationTargets: fakes.navigationTargets,
        browserRelativeDir: "BrowserSkill/tr_72",
        timeoutMs: 3_000,
        trigger: async (markDispatched) => {
          markDispatched();
          cdpEvent?.(targetEventSource(4, "oopif:slow-cdn"), "Page.downloadWillBegin", {
            frameId: "slow-cdn",
            url: download.url,
            suggestedFilename: download.filename,
          });
          suggested = fakes.offer(download);
          return { tab_id: 4, x: 10, y: 10 };
        },
      });

      await vi.advanceTimersByTimeAsync(900);
      await expect(suggested).resolves.toEqual({
        filename: "BrowserSkill/tr_72/report-72.csv",
        conflictAction: "overwrite",
      });
      fakes.finish(download);
      expect(await pending).toMatchObject({ item: { id: 72, state: "complete" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a stale frame rejected before drop dispatch as pre-commit without detaching", async () => {
    const { StaleFrameHandleError } = await import("@/browser-driver/frame-handles");
    const calls: Array<{ method: string; params?: object }> = [];
    const detach = vi.fn(async () => {});
    const onDropSent = vi.fn();
    const { cdp: base } = dropCdp();
    const cdp: CdpRunner = createStubCdpRunner({
      detach,
      send: base.send,
      sendToFrame: vi.fn(
        async (handle, method: string, params?: object, guard?: { onDispatch?: () => void }) => {
          if (
            method === "Input.dispatchDragEvent" &&
            (params as { type?: string })?.type === "drop"
          ) {
            throw new StaleFrameHandleError({ tabId: 4, frameId: "child" });
          }
          guard?.onDispatch?.();
          calls.push({ method, params });
          return base.send(handle.tabId, method, params) as never;
        },
      ) as CdpRunner["sendToFrame"],
    });

    const result = await uploadThroughFileDrop({
      cdp,
      actionTarget: actionTarget(),
      files: ["/stage/one.png"],
      timeoutMs: 500,
      onDropSent,
      withOverlayHidden: withoutOverlay,
    });

    expect(result).toMatchObject({
      code: "not_found",
      data: { reason: "ref_not_found", effect_state: "none", phase: "drop" },
    });
    expect(onDropSent).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
    expect(calls).toContainEqual({
      method: "Input.dispatchDragEvent",
      params: expect.objectContaining({ type: "dragCancel" }),
    });
  });

  it("ignores pre-dispatch CDP download intents and candidates before mouse press", async () => {
    const fakes = popupDownloadFakes();
    const url = "https://example.test/earlier-export.csv";
    const earlier = fakes.item(80, url);
    let cdpEvent: Parameters<NonNullable<CdpRunner["onEvent"]>>[1] | undefined;
    let suggested: Promise<chrome.downloads.DownloadFilenameSuggestion | undefined> | undefined;
    const cdp: CdpRunner = createStubCdpRunner({
      send: vi.fn(async () => ({})) as CdpRunner["send"],
      onEvent: (_tabId, handler) => {
        cdpEvent = handler;
        return { dispose: vi.fn() };
      },
    });

    const result = await captureBrowserDownload({
      cdp,
      handle: { tabId: 4, frameId: "main", loaderId: "main-loader" },
      downloads: fakes.downloads,
      navigationTargets: fakes.navigationTargets,
      browserRelativeDir: "BrowserSkill/tr_80",
      timeoutMs: 80,
      trigger: async (markDispatched) => {
        // An earlier child-frame download arrives BEFORE mouse press dispatch.
        cdpEvent?.(rootEventSource(4), "Page.downloadWillBegin", {
          frameId: "child-earlier",
          url: earlier.url,
          suggestedFilename: earlier.filename,
        });
        suggested = fakes.offer(earlier);
        markDispatched();
        return { tab_id: 4, x: 10, y: 10 };
      },
    });

    await expect(suggested).resolves.toBeUndefined();
    expect(result).toMatchObject({
      code: "cdp_failed",
      data: { reason: "download_capture_failed", phase: "attribution" },
    });
  });

  it("releases unrelated concurrent download candidates immediately when claiming the winner", async () => {
    const fakes = popupDownloadFakes();
    const winner = fakes.item(81, "https://example.test/winner.csv");
    const unrelated = fakes.item(82, "https://other.test/unrelated.zip");
    let cdpEvent: Parameters<NonNullable<CdpRunner["onEvent"]>>[1] | undefined;
    let winnerSuggested:
      | Promise<chrome.downloads.DownloadFilenameSuggestion | undefined>
      | undefined;
    let unrelatedSuggested:
      | Promise<chrome.downloads.DownloadFilenameSuggestion | undefined>
      | undefined;
    let unrelatedResolved = false;
    const cdp: CdpRunner = createStubCdpRunner({
      send: vi.fn(async () => ({})) as CdpRunner["send"],
      onEvent: (_tabId, handler) => {
        cdpEvent = handler;
        return { dispose: vi.fn() };
      },
    });

    const pending = captureBrowserDownload({
      cdp,
      handle: { tabId: 4, frameId: "", loaderId: "" },
      downloads: fakes.downloads,
      navigationTargets: fakes.navigationTargets,
      browserRelativeDir: "BrowserSkill/tr_81",
      timeoutMs: 2_000,
      trigger: async (markDispatched) => {
        markDispatched();
        cdpEvent?.(rootEventSource(4), "Page.downloadWillBegin", {
          url: winner.url,
          suggestedFilename: winner.filename,
        });
        winnerSuggested = fakes.offer(winner);
        unrelatedSuggested = fakes.offer(unrelated).then((s) => {
          unrelatedResolved = true;
          return s;
        });
        return { tab_id: 4, x: 10, y: 10 };
      },
    });

    // Winner claim happens after UNIQUE_SETTLE_MS (~100ms), long before winner completes!
    await expect(winnerSuggested).resolves.toEqual({
      filename: "BrowserSkill/tr_81/report-81.csv",
      conflictAction: "overwrite",
    });
    await expect(unrelatedSuggested).resolves.toBeUndefined();
    expect(unrelatedResolved).toBe(true);
    // Now finish the winner so the capture settles cleanly.
    fakes.finish(winner);
    expect(await pending).toMatchObject({ item: { id: 81, state: "complete" } });
  });

  it("does not abort an already-dispatched upload probe guard on timeout and installs a self-expiring TTL", async () => {
    let probeSignal: AbortSignal | undefined;
    let injectedFn = "";
    let injectedArgs: Array<{ value: unknown }> = [];
    const cdp: CdpRunner = createStubCdpRunner({
      send: vi.fn(async () => ({})) as CdpRunner["send"],
      sendToFrame: vi.fn(
        async (
          _handle,
          method: string,
          params?: object,
          guard?: { signal?: AbortSignal; onDispatch?: () => void },
        ) => {
          guard?.onDispatch?.();
          if (method === "DOM.resolveNode") return { object: { objectId: "trigger-object" } };
          if (method === "Runtime.callFunctionOn") {
            const decl = String((params as { functionDeclaration?: string })?.functionDeclaration);
            if (decl.includes("addEventListener")) {
              probeSignal = guard?.signal;
              injectedFn = decl;
              injectedArgs = (params as { arguments?: Array<{ value: unknown }> })?.arguments ?? [];
              return new Promise<never>(() => {});
            }
            return { result: { value: true } };
          }
          return {};
        },
      ) as CdpRunner["sendToFrame"],
      onEvent: () => ({ dispose: vi.fn() }),
    });

    const result = await uploadThroughActivatedFileInput({
      cdp,
      actionTarget: actionTarget(),
      files: ["/private/stage/one"],
      timeoutMs: 15,
      trigger: async () => ({ tab_id: 4, x: 10, y: 10 }),
    });

    expect(result).toMatchObject({
      code: "timeout",
      data: { reason: "file_input_probe_failed", effect_state: "none", phase: "arm_input_probe" },
    });
    // Already-dispatched probe must NOT abort its guard signal (avoids tripping CdpReadGate).
    expect(probeSignal?.aborted).toBe(false);
    // Verify injected probe self-expires after TTL even without CDP cleanup.
    expect(injectedArgs).toHaveLength(2);
    const key = String(injectedArgs[0].value);
    const host = document.createElement("button");
    const input = document.createElement("input");
    input.type = "file";
    document.body.append(host, input);
    try {
      const arm = new Function(`return (${injectedFn})`)();
      expect(arm.call(host, key, 10)).toBe(true);
      await new Promise((r) => setTimeout(r, 25));
      expect(
        input.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
      ).toBe(true);
      expect((window as unknown as Record<string, unknown>)[key]).toBeUndefined();
    } finally {
      host.remove();
      input.remove();
    }
  });

  it("aborts a queued drag event on local timeout so it cannot dispatch after effect_state: none", async () => {
    const dispatchedDrags: string[] = [];
    let releaseQueue!: () => void;
    const queued = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const { cdp: base } = dropCdp();
    const cdp: CdpRunner = createStubCdpRunner({
      send: base.send,
      sendToFrame: vi.fn(
        async (
          handle,
          method: string,
          params?: object,
          guard?: { signal?: AbortSignal; onDispatch?: () => void },
        ) => {
          if (
            method === "Input.dispatchDragEvent" &&
            (params as { type?: string })?.type === "dragEnter"
          ) {
            await queued;
            if (guard?.signal?.aborted) throw new DOMException("aborted", "AbortError");
          }
          guard?.onDispatch?.();
          if (method === "Input.dispatchDragEvent") {
            dispatchedDrags.push(String((params as { type?: string })?.type));
          }
          return base.send(handle.tabId, method, params) as never;
        },
      ) as CdpRunner["sendToFrame"],
    });

    const result = await uploadThroughFileDrop({
      cdp,
      actionTarget: actionTarget(),
      files: ["/stage/one.png"],
      timeoutMs: 15,
      withOverlayHidden: withoutOverlay,
    });
    releaseQueue();
    await new Promise((r) => setTimeout(r, 10));

    expect(result).toMatchObject({
      code: "timeout",
      data: { reason: "file_drop_failed", effect_state: "none", phase: "drag_enter" },
    });
    expect(dispatchedDrags).toEqual([]);
  });
});
