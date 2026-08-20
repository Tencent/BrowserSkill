import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { type DownloadsApi, handleDownload } from "../download";
import { uploadThroughFileChooser } from "../file-chooser";
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

function fakeEvent<T extends (...args: never[]) => void>() {
  const listeners = new Set<T>();
  return {
    addListener: (listener: T) => listeners.add(listener),
    removeListener: (listener: T) => listeners.delete(listener),
    hasListener: (listener: T) => listeners.has(listener),
    hasListeners: () => listeners.size > 0,
    emit: (...args: Parameters<T>) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

describe("file transfer tools", () => {
  it("enables chooser observation before clicking and injects only staged paths", async () => {
    const manager = sessions();
    const ctx = await manager.start("s1");
    ctx.refStore.set("e3", 123, { tabId: 4 });
    let eventHandler: Parameters<NonNullable<CdpRunner["onEvent"]>>[0] | undefined;
    const calls: Array<{ method: string; params?: object }> = [];
    const send = vi.fn(async (_tabId: number, method: string, params?: object) => {
      calls.push({ method, params });
      if (method === "Page.getLayoutMetrics")
        return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
      if (method === "DOM.getContentQuads") return { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] };
      if (
        method === "Input.dispatchMouseEvent" &&
        (params as { type?: string }).type === "mousePressed"
      ) {
        eventHandler?.({ tabId: 4 }, "Page.fileChooserOpened", {
          backendNodeId: 456,
          mode: "selectMultiple",
        });
      }
      return {};
    });
    const cdp: CdpRunner = {
      onEvent: (handler) => {
        eventHandler = handler;
        return { dispose: vi.fn() };
      },
      send: send as unknown as CdpRunner["send"],
    };

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
    expect(calls[0]).toMatchObject({
      method: "Page.enable",
      params: { enableFileChooserOpenedEvent: true },
    });
    expect(calls).toContainEqual({
      method: "DOM.setFileInputFiles",
      params: { files: ["/private/stage/one", "/private/stage/two"], backendNodeId: 456 },
    });
    expect(calls.at(-1)).toEqual({
      method: "Page.enable",
      params: { enableFileChooserOpenedEvent: false },
    });
  });

  it("reports File System Access pickers as an explicit manual fallback", async () => {
    let eventHandler: Parameters<NonNullable<CdpRunner["onEvent"]>>[0] | undefined;
    const cdp: CdpRunner = {
      onEvent: (handler) => {
        eventHandler = handler;
        return { dispose: vi.fn() };
      },
      send: vi.fn(async () => ({})) as unknown as CdpRunner["send"],
    };

    const result = await uploadThroughFileChooser({
      cdp,
      target: { tabId: 4 },
      files: ["/private/stage/one"],
      timeoutMs: 100,
      trigger: async () => {
        eventHandler?.({ tabId: 4 }, "Page.fileChooserOpened", { mode: "selectSingle" });
        return { tab_id: 4, x: 10, y: 10 };
      },
    });

    expect(result).toEqual({
      code: "unsupported",
      message: "this file chooser is not backed by an input element",
      data: {
        reason: "unsupported_file_chooser",
        chooser_kind: "non_input",
        manual_fallback_available: true,
      },
    });
  });

  it("bounds a stuck chooser-control command and resets uncertain CDP state", async () => {
    const detach = vi.fn(async () => {});
    const cdp: CdpRunner = {
      onEvent: () => ({ dispose: vi.fn() }),
      send: vi.fn(() => new Promise<never>(() => {})) as unknown as CdpRunner["send"],
      detach,
    };

    const result = await uploadThroughFileChooser({
      cdp,
      target: { tabId: 4 },
      files: ["/private/stage/one"],
      timeoutMs: 5,
      trigger: vi.fn(),
    });

    expect(result).toMatchObject({
      code: "timeout",
      data: { reason: "file_chooser_control_failed", phase: "enable_events" },
    });
    expect(detach).toHaveBeenCalledWith(4);
  });

  it("distinguishes a completed click that did not open a chooser", async () => {
    const send = vi.fn(async () => ({})) as unknown as CdpRunner["send"];
    const cdp: CdpRunner = {
      onEvent: () => ({ dispose: vi.fn() }),
      send,
    };

    const result = await uploadThroughFileChooser({
      cdp,
      target: { tabId: 4 },
      files: ["/private/stage/one"],
      timeoutMs: 5,
      trigger: async () => ({ tab_id: 4, x: 10, y: 10 }),
    });

    expect(result).toMatchObject({
      code: "timeout",
      data: { reason: "file_chooser_not_opened", phase: "await_event" },
    });
    expect(send).toHaveBeenLastCalledWith(4, "Page.enable", {
      enableFileChooserOpenedEvent: false,
    });
  });

  it("accepts chooser events only from the exact CDP target", async () => {
    let eventHandler: Parameters<NonNullable<CdpRunner["onEvent"]>>[0] | undefined;
    const setFiles = vi.fn();
    const cdp: CdpRunner = {
      onEvent: (handler) => {
        eventHandler = handler;
        return { dispose: vi.fn() };
      },
      send: vi.fn(async () => ({})) as unknown as CdpRunner["send"],
      sendToTarget: vi.fn(async (_target, method, params) => {
        if (method === "DOM.setFileInputFiles") setFiles(params);
        return {};
      }) as unknown as NonNullable<CdpRunner["sendToTarget"]>,
    };

    const result = await uploadThroughFileChooser({
      cdp,
      target: { tabId: 4, sessionId: "child-a" },
      files: ["/private/stage/one"],
      timeoutMs: 100,
      trigger: async () => {
        eventHandler?.({ tabId: 4, sessionId: "child-b" }, "Page.fileChooserOpened", {
          backendNodeId: 111,
        });
        eventHandler?.({ tabId: 4, sessionId: "child-a" }, "Page.fileChooserOpened", {
          backendNodeId: 222,
        });
        return { tab_id: 4, x: 10, y: 10 };
      },
    });

    expect(result).toMatchObject({ click: { tab_id: 4 } });
    expect(setFiles).toHaveBeenCalledOnce();
    expect(setFiles).toHaveBeenCalledWith({
      files: ["/private/stage/one"],
      backendNodeId: 222,
    });
  });

  it("captures the one download created under daemon staging", async () => {
    const manager = sessions();
    const ctx = await manager.start("s1");
    ctx.refStore.set("e3", 123, { tabId: 4 });
    const onCreated = fakeEvent<(item: chrome.downloads.DownloadItem) => void>();
    const onChanged = fakeEvent<(delta: chrome.downloads.DownloadDelta) => void>();
    const item = {
      id: 9,
      filename: "/private/stage/tr_1/result.zip",
      state: "complete",
      fileSize: 12,
      totalBytes: 12,
      mime: "application/zip",
      danger: "safe",
    } as chrome.downloads.DownloadItem;
    const downloads: DownloadsApi = {
      onCreated: onCreated as unknown as DownloadsApi["onCreated"],
      onChanged: onChanged as unknown as DownloadsApi["onChanged"],
      search: vi.fn(async () => [item]),
      cancel: vi.fn(async () => {}),
    };
    const send = vi.fn(async (_tabId: number, method: string, params?: object) => {
      if (method === "Page.getLayoutMetrics")
        return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
      if (method === "DOM.getContentQuads") return { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] };
      if (
        method === "Input.dispatchMouseEvent" &&
        (params as { type?: string }).type === "mousePressed"
      ) {
        onCreated.emit(item);
      }
      return {};
    });
    const cdp: CdpRunner = {
      send: send as unknown as CdpRunner["send"],
    };

    const result = await handleDownload(
      manager,
      { session_id: "s1", ref: "@e3", staging_path: "/private/stage/tr_1" },
      { cdp, tabsApi: tabsApi(), downloads },
    );

    expect(result).toMatchObject({
      tab_id: 4,
      suggested_filename: "result.zip",
      byte_size: 12,
      staged_path: item.filename,
    });
  });
});
