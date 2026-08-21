import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { type DownloadsApi, handleDownload } from "../download";
import { captureBrowserDownload } from "../download-capture";
import { uploadThroughActivatedFileInput } from "../file-input-transaction";
import type { ResolvedActionTarget } from "../interaction";
import type { CdpRunner } from "../shared";
import { handleUpload } from "../upload";

function sessions() {
  return new SessionManager({
    agentWindow: {
      create: vi.fn(async () => 100),
      remove: vi.fn(async () => {}),
      ensureActiveTab: vi.fn(async () => {}),
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

function actionTarget(frameId?: string): ResolvedActionTarget {
  return {
    tab: { tabId: 4, windowId: 100, active: true },
    backendNodeId: 123,
    cdpTarget: { tabId: 4 },
    ...(frameId ? { frameId } : {}),
    usedRef: "e3",
  };
}

function uploadCdp(
  options: {
    inputCount?: number;
    multiple?: boolean;
    chooser?: { frameId?: string; backendNodeId?: number; mode?: string };
    pendingResolve?: boolean;
  } = {},
) {
  const calls: Array<{ method: string; params?: object }> = [];
  let cdpEvent: Parameters<NonNullable<CdpRunner["onEvent"]>>[0] | undefined;
  const send = vi.fn(async (_tabId: number, method: string, params?: object) => {
    calls.push({ method, params });
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
      cdpEvent?.({ tabId: 4 }, "Page.fileChooserOpened", options.chooser);
    }
    return {};
  });
  const cdp: CdpRunner = {
    send: send as unknown as CdpRunner["send"],
    onEvent: (handler) => {
      cdpEvent = handler;
      return { dispose: vi.fn() };
    },
  };
  return {
    calls,
    emitChooser: (event: { frameId?: string; backendNodeId?: number; mode?: string }) =>
      cdpEvent?.({ tabId: 4 }, "Page.fileChooserOpened", event),
    cdp,
  };
}

describe("file transfer tools", () => {
  it("captures the file input activated by the requested click and injects only staged paths", async () => {
    const manager = sessions();
    const ctx = await manager.start("s1");
    ctx.refStore.set("e3", 123, { tabId: 4 });
    const { cdp, calls } = uploadCdp();

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
      { cdp, tabsApi: tabsApi() },
    );

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
    const cdp: CdpRunner = {
      send: vi.fn(async (_tabId: number, method: string) => {
        if (method === "Page.setInterceptFileChooserDialog") {
          throw new Error("method unavailable");
        }
        return {};
      }) as CdpRunner["send"],
    };

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

  it("routes one exact-target download through a browser-relative capability", async () => {
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
      filename: "/profile/Downloads/BrowserSkill/tr_1/result.zip",
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
    let cdpEvent: Parameters<NonNullable<CdpRunner["onEvent"]>>[0] | undefined;
    let suggested: chrome.downloads.DownloadFilenameSuggestion | undefined;
    const send = vi.fn(async (_tabId: number, method: string, params?: object) => {
      if (method === "Page.getLayoutMetrics")
        return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
      if (method === "DOM.getContentQuads") return { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] };
      if (
        method === "Input.dispatchMouseEvent" &&
        (params as { type?: string }).type === "mousePressed"
      ) {
        cdpEvent?.({ tabId: 4 }, "Page.downloadWillBegin", {
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
    const cdp: CdpRunner = {
      send: send as unknown as CdpRunner["send"],
      onEvent: (handler) => {
        cdpEvent = handler;
        return { dispose: vi.fn() };
      },
    };

    const result = await handleDownload(
      manager,
      { session_id: "s1", ref: "@e3", browser_relative_dir: "BrowserSkill/tr_1" },
      { cdp, tabsApi: tabsApi(), downloads },
    );

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
    let cdpEvent: Parameters<NonNullable<CdpRunner["onEvent"]>>[0] | undefined;
    const cdp: CdpRunner = {
      send: vi.fn(async () => ({})) as unknown as CdpRunner["send"],
      onEvent: (handler) => {
        cdpEvent = handler;
        return { dispose: vi.fn() };
      },
    };
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
      target: { tabId: 4, sessionId: "expected-child" },
      downloads,
      browserRelativeDir: "BrowserSkill/tr_1",
      timeoutMs: 5,
      trigger: async () => {
        cdpEvent?.({ tabId: 4, sessionId: "other-child" }, "Page.downloadWillBegin", {
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
    const complete = { ...initial, state: "complete", fileSize: 4 } as chrome.downloads.DownloadItem;
    const downloads: DownloadsApi = {
      onCreated,
      onChanged,
      onDeterminingFilename,
      search: vi.fn(async () => [complete]),
      cancel: vi.fn(async () => {}),
      removeFile: vi.fn(async () => {}),
    };
    let cdpEvent: Parameters<NonNullable<CdpRunner["onEvent"]>>[0] | undefined;
    const cdp: CdpRunner = {
      send: vi.fn(async () => ({})) as CdpRunner["send"],
      onEvent: (handler) => {
        cdpEvent = handler;
        return { dispose: vi.fn() };
      },
    };
    let suggestion: chrome.downloads.DownloadFilenameSuggestion | undefined;

    const result = await captureBrowserDownload({
      cdp,
      target: { tabId: 4 },
      downloads,
      browserRelativeDir: "BrowserSkill/tr_21",
      timeoutMs: 1_000,
      trigger: async () => {
        const suggested = new Promise<void>((resolve) => {
          onDeterminingFilename.emit(initial, (value) => {
            suggestion = value;
            resolve();
          });
        });
        cdpEvent?.({ tabId: 4 }, "Page.downloadWillBegin", {
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
    let cdpEvent: Parameters<NonNullable<CdpRunner["onEvent"]>>[0] | undefined;
    const cdp: CdpRunner = {
      send: vi.fn(async () => ({})) as CdpRunner["send"],
      onEvent: (handler) => {
        cdpEvent = handler;
        return { dispose: vi.fn() };
      },
    };
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
      target: { tabId: 4 },
      downloads,
      browserRelativeDir: "BrowserSkill/tr_ambiguous",
      timeoutMs: 100,
      trigger: async () => {
        cdpEvent?.({ tabId: 4 }, "Page.downloadWillBegin", {
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
});
