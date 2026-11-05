import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { handleDownload } from "../download";
import type { CdpRunner } from "../shared";
import { handleUpload } from "../upload";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function event<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>();
  return {
    addListener: (listener: (...args: T) => void) => listeners.add(listener),
    removeListener: (listener: (...args: T) => void) => listeners.delete(listener),
    fire: (...args: T) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

async function fixture(kind: "upload" | "download", hidden = true) {
  const manager = new SessionManager({
    agentWindow: {
      create: async () => ({ windowId: 100, initialTabIds: [7] }),
      remove: async () => {},
      ensureActiveTab: async () => 7,
    },
  });
  const ctx = await manager.start("transfer-readiness");
  ctx.refStore.set("e1", 123, { tabId: 7 });
  const abort = new AbortController();
  const paint = deferred<boolean>();
  const press = deferred<object>();
  const enableFocus = deferred<void>();
  const disableFocus = deferred<void>();
  let holdDownload = false;
  let holdDisable = false;
  let holdPress = false;
  let holdEnable = false;
  let focusQueued = false;
  const calls: Array<{ method: string; params?: object }> = [];
  const inputs: string[] = [];
  let painted = !hidden;
  let delivered = false;
  let uploads = 0;
  let listener: Parameters<NonNullable<CdpRunner["onEvent"]>>[0] | undefined;
  const onCreated = event<[chrome.downloads.DownloadItem]>();
  const onChanged = event<[chrome.downloads.DownloadDelta]>();
  const onDeterminingFilename =
    event<
      [
        chrome.downloads.DownloadItem,
        (suggestion?: chrome.downloads.DownloadFilenameSuggestion) => void,
      ]
    >();
  const item = {
    id: 9,
    url: "https://example.test/file",
    finalUrl: "https://example.test/file",
    filename: "/downloads/BrowserSkill/ready/sample.bin",
    state: "complete",
    fileSize: 4,
    totalBytes: 4,
  } as chrome.downloads.DownloadItem;
  let attachment: string | undefined = "owned";
  const detach = vi.fn(async (_tabId: number, expected?: string) => {
    if (attachment === expected) attachment = undefined;
  });
  const cdp: CdpRunner = {
    detach,
    getAttachmentId: () => attachment,
    sendGuarded: async (target, method, params, guard) => {
      if (
        holdEnable &&
        method === "Emulation.setFocusEmulationEnabled" &&
        (params as { enabled: boolean }).enabled
      ) {
        focusQueued = true;
        await enableFocus.promise;
      }
      if (guard.signal?.aborted) throw new DOMException("aborted", "AbortError");
      guard.onDispatch?.();
      return cdp.send(target.tabId, method, params);
    },
    onEvent: (callback) => {
      listener = callback;
      return {
        dispose() {
          listener = undefined;
        },
      };
    },
    send: (async (_tabId, method, params) => {
      calls.push({ method, params });
      if (
        holdDisable &&
        method === "Emulation.setFocusEmulationEnabled" &&
        !(params as { enabled: boolean }).enabled
      )
        return disableFocus.promise;
      if (
        method === "Runtime.evaluate" &&
        String((params as { expression?: string }).expression).includes("requestAnimationFrame")
      ) {
        painted = await paint.promise;
        return { result: { value: painted } };
      }
      if (method === "Runtime.evaluate")
        return {
          result: {
            value:
              (params as { expression: string }).expression === "document.visibilityState"
                ? hidden
                  ? "hidden"
                  : "visible"
                : "absent",
          },
        };
      if (method === "Page.getLayoutMetrics")
        return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
      if (method === "DOM.getContentQuads") return { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] };
      if (method === "DOM.resolveNode") return { object: { objectId: "trigger" } };
      if (method === "Runtime.callFunctionOn") {
        const declaration = (params as { functionDeclaration: string }).functionDeclaration;
        if (declaration.includes("count: state.inputs.length"))
          return { result: { value: { count: delivered ? 1 : 0, multiple: false } } };
        if (declaration.includes("inputs[0]")) return { result: { objectId: "input" } };
        return { result: { value: true } };
      }
      if (method === "DOM.describeNode") return { node: { backendNodeId: 456 } };
      if (method === "DOM.setFileInputFiles") uploads++;
      if (method === "Input.dispatchMouseEvent") {
        const type = (params as { type: string }).type;
        inputs.push(type);
        if (holdPress && type === "mousePressed") return press.promise;
        if (type === "mouseReleased" && painted) {
          delivered = true;
          if (kind === "download" && !holdDownload) finishDownload();
        }
      }
      return {};
    }) as CdpRunner["send"],
  };
  const tab = { id: 7, windowId: 100, active: true } as chrome.tabs.Tab;
  const deps = {
    cdp,
    signal: abort.signal,
    tabsApi: { get: async () => tab, query: async () => [tab] },
  };
  const finishDownload = () => {
    listener?.({ tabId: 7 }, "Page.downloadWillBegin", {
      url: item.url,
      suggestedFilename: "sample.bin",
    });
    onDeterminingFilename.fire(item, () => onCreated.fire(item));
  };
  const run = (timeoutMs = 500) =>
    kind === "upload"
      ? handleUpload(
          manager,
          {
            session_id: ctx.sessionId,
            ref: "e1",
            timeout_ms: timeoutMs,
            files: [{ name: "sample.bin", transfer_id: "ready", staged_path: "/stage/sample.bin" }],
          },
          deps,
        )
      : handleDownload(
          manager,
          {
            session_id: ctx.sessionId,
            ref: "e1",
            timeout_ms: timeoutMs,
            browser_relative_dir: "BrowserSkill/ready",
          },
          {
            ...deps,
            navigationTargets: { onCreatedNavigationTarget: event<[]>() },
            downloads: {
              onCreated,
              onChanged,
              onDeterminingFilename,
              search: async () => [item],
              cancel: async () => {},
              removeFile: async () => {},
            },
          },
        );
  return {
    abort,
    detach,
    replaceAttachment: () => {
      attachment = "replacement";
    },
    calls,
    disableFocus,
    finishDownload,
    holdDownload: () => {
      holdDownload = true;
      holdDisable = true;
    },
    inputs,
    paint,
    press,
    run,
    uploaded: () => uploads,
    holdPress: () => {
      holdPress = true;
    },
    holdEnable: () => {
      holdEnable = true;
    },
    focusQueued: () => focusQueued,
    enableFocus,
  };
}

afterEach(() => vi.useRealTimers());

describe.each(["upload", "download"] as const)("%s native input readiness", (kind) => {
  it("waits for the first background frame and sends exactly one click", async () => {
    vi.useFakeTimers();
    const f = await fixture(kind);
    const pending = f.run();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(
        f.calls.some(
          (c) =>
            c.method === "Runtime.evaluate" &&
            String((c.params as { expression?: string })?.expression).includes(
              "requestAnimationFrame",
            ),
        ),
      ).toBe(true);
      expect(f.inputs).toEqual([]);
      expect(f.calls.some((c) => c.method === "Page.captureScreenshot")).toBe(false);
      f.paint.resolve(true);
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).not.toHaveProperty("code");
      expect(f.inputs).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
      expect(
        f.calls
          .filter((c) => c.method === "Emulation.setFocusEmulationEnabled")
          .map((c) => c.params),
      ).toEqual([{ enabled: true }, { enabled: false }]);
      if (kind === "upload") expect(f.uploaded()).toBe(1);
    } finally {
      f.abort.abort();
      f.paint.resolve(true);
      await vi.advanceTimersByTimeAsync(1000);
      await pending;
    }
  });

  it.each([
    "abort",
    "timeout",
    "missing-frame",
  ])("releases preparation on %s without a late click", async (boundary) => {
    vi.useFakeTimers();
    const f = await fixture(kind);
    const pending = f.run();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(
        f.calls.some(
          (c) =>
            c.method === "Runtime.evaluate" &&
            String((c.params as { expression?: string })?.expression).includes(
              "requestAnimationFrame",
            ),
        ),
      ).toBe(true);
      if (boundary === "abort") f.abort.abort();
      if (boundary === "missing-frame") f.paint.resolve(false);
      await vi.advanceTimersByTimeAsync(600);
      expect(await pending).toMatchObject({ data: { effect_state: "none" } });
      expect(f.inputs).toEqual([]);
      expect(f.uploaded()).toBe(0);
      expect(
        f.calls
          .filter((c) => c.method === "Emulation.setFocusEmulationEnabled")
          .map((c) => c.params),
      ).toEqual([{ enabled: true }, { enabled: false }]);
      f.paint.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.inputs).toEqual([]);
      if (kind === "upload")
        expect(f.calls).toContainEqual({
          method: "Page.setInterceptFileChooserDialog",
          params: { enabled: false, cancel: true },
        });
    } finally {
      f.abort.abort();
      f.paint.resolve(true);
      await vi.advanceTimersByTimeAsync(1000);
      await pending;
    }
  });

  it.each([
    "abort",
    "timeout",
  ])("does not enable focus after %s during attachment", async (boundary) => {
    vi.useFakeTimers();
    const f = await fixture(kind);
    f.holdEnable();
    const pending = f.run();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.focusQueued()).toBe(true);
      if (boundary === "abort") f.abort.abort();
      await vi.advanceTimersByTimeAsync(600);
      expect(await pending).toHaveProperty("data.effect_state", "none");
      const calls = [...f.calls];
      expect(calls).not.toContainEqual({
        method: "Emulation.setFocusEmulationEnabled",
        params: { enabled: true },
      });
      f.enableFocus.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.calls).toEqual(calls);
      expect(f.inputs).toEqual([]);
    } finally {
      f.abort.abort();
      f.enableFocus.resolve();
      await vi.advanceTimersByTimeAsync(1000);
      await pending;
    }
  });

  it.each([
    "abort",
    "timeout",
  ])("releases hidden input resources on %s during a pending press", async (boundary) => {
    vi.useFakeTimers();
    const f = await fixture(kind);
    f.holdPress();
    f.paint.resolve(true);
    const pending = f.run();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.inputs).toEqual(["mouseMoved", "mousePressed"]);
      if (boundary === "abort") f.abort.abort();
      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;
      expect(result).toHaveProperty("code");
      expect(result).not.toHaveProperty("data.cleanup_state", "failed");
      expect(f.calls).toContainEqual({
        method: "Emulation.setFocusEmulationEnabled",
        params: { enabled: false },
      });
      const released = [...f.inputs];
      expect(released).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
      f.press.resolve({});
      await vi.advanceTimersByTimeAsync(0);
      expect(f.inputs).toEqual(released);
      expect(
        f.calls
          .filter((c) => c.method === "Emulation.setFocusEmulationEnabled")
          .map((c) => c.params),
      ).toEqual([{ enabled: true }, { enabled: false }]);
      expect(f.uploaded()).toBe(0);
    } finally {
      f.abort.abort();
      f.press.resolve({});
      await vi.advanceTimersByTimeAsync(1000);
      await pending;
    }
  });

  it("keeps foreground input free of rendering overrides", async () => {
    const f = await fixture(kind, false);
    expect(await f.run()).not.toHaveProperty("code");
    expect(
      f.calls.some((c) =>
        ["Page.captureScreenshot", "Emulation.setFocusEmulationEnabled"].includes(c.method),
      ),
    ).toBe(false);
    expect(f.inputs).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
  });
});

it("keeps download attribution alive while a background focus-restore reply is delayed", async () => {
  vi.useFakeTimers();
  const f = await fixture("download");
  f.holdDownload();
  f.paint.resolve(true);
  let settled = false;
  const pending = f.run(10_000).then((result) => {
    settled = true;
    return result;
  });
  try {
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);
    expect(f.inputs).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(
      f.calls.filter((c) => c.method === "Emulation.setFocusEmulationEnabled").map((c) => c.params),
    ).toEqual([{ enabled: true }, { enabled: false }]);
    f.disableFocus.resolve();
    f.finishDownload();
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({
      byte_size: 4,
      browser_path: "/downloads/BrowserSkill/ready/sample.bin",
    });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    f.abort.abort();
    f.disableFocus.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
  }
});

it.each([
  false,
  true,
])("fences timed-out focus cleanup only on its owned attachment (replacement=%s)", async (replacement) => {
  vi.useFakeTimers();
  const f = await fixture("download");
  f.holdDownload();
  f.paint.resolve(true);
  const pending = f.run(10_000);
  try {
    await vi.advanceTimersByTimeAsync(100);
    if (replacement) f.replaceAttachment();
    f.abort.abort();
    await vi.advanceTimersByTimeAsync(1100);
    expect(await pending).toHaveProperty("data.cleanup_state", "failed");
    if (replacement) expect(f.detach).not.toHaveBeenCalled();
    else expect(f.detach).toHaveBeenCalledWith(7, "owned");
    f.disableFocus.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.inputs).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    f.disableFocus.resolve();
    f.abort.abort();
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
  }
});
