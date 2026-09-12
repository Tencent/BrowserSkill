import { i18n } from "@browser-skill/i18n";
import { capturePage } from "./capture";
import { captureManual } from "./manual";
import { createPageClient } from "./page-client";
import { openScreenshotSource } from "./source";
import { readTiledScreenshot, removeTiledScreenshot, TileWriter } from "./tiles";
import {
  type CaptureReply,
  type CaptureRequest,
  type CaptureState,
  isCapturing,
  LONG_SCREENSHOT,
  LONG_SCREENSHOT_STATE,
  type PageCommand,
  ScreenshotError,
} from "./types";

/** Screenshot-only controller. No CLI/Agent transport dependency. */
export function attachLongScreenshot(options: { isTabBusy(tabId: number): boolean }) {
  let state: CaptureState | null = null;
  type Job = {
    id: string;
    controller: AbortController;
    paused: boolean;
    finished: boolean;
    page?: (command: PageCommand) => Promise<unknown>;
  };
  let running: Job | null = null;
  let openingPreviews = 0;
  let writes = Promise.resolve();
  const ready = chrome.storage.session
    .get(LONG_SCREENSHOT_STATE)
    .then(async (stored) => {
      state = stored[LONG_SCREENSHOT_STATE] ?? null;
      if (isCapturing(state) && state) {
        const saved = await readTiledScreenshot(state.id).catch(() => undefined);
        publish(
          saved?.height
            ? {
                ...state,
                phase: "complete",
                width: saved.width,
                height: saved.height,
                partial: true,
                notice: "interrupted",
              }
            : { ...state, phase: "error", error: "interrupted" },
        );
      }
    })
    .catch(() => {});
  function publish(next: CaptureState | null) {
    state = next;
    writes = writes
      .then(() => chrome.storage.session.set({ [LONG_SCREENSHOT_STATE]: next }))
      .catch(() => {});
  }
  function clearResult() {
    // Active jobs own their cancellation and partial-result lifecycle.
    if (state && !running && !openingPreviews && !isCapturing(state)) publish(null);
  }
  async function clearResultOnPageChange() {
    await ready;
    const previous = state;
    if (!previous || running || openingPreviews || isCapturing(previous)) return;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (state !== previous || running || openingPreviews || !tab) return;
    const pageUrl = tab.pendingUrl ?? tab.url;
    if (!pageUrl) return;
    if (tab.id === previous.tabId && (!previous.pageUrl || pageUrl === previous.pageUrl)) return;
    // Opening the result's own preview is part of the same capture flow.
    const previewUrl = chrome.runtime.getURL("/long-screenshot.html");
    if (
      pageUrl.startsWith(`${previewUrl}?`) &&
      new URL(pageUrl).searchParams.get("id") === previous.id
    )
      return;
    clearResult();
  }
  const pageChanged = () => {
    void clearResultOnPageChange().catch(() => {});
  };
  chrome.tabs.onActivated.addListener(pageChanged);
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId !== chrome.windows.WINDOW_ID_NONE) pageChanged();
  });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (!info.url) return;
    void ready.then(() => {
      if (state?.tabId === tabId && info.url !== state.pageUrl) clearResult();
      else pageChanged();
    });
  });
  chrome.webNavigation.onCommitted.addListener((info) => {
    if (info.frameId !== 0) return;
    void ready.then(() => {
      if (state?.tabId === info.tabId) clearResult();
      else pageChanged();
    });
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void ready.then(() => {
      if (state?.tabId === tabId) clearResult();
    });
  });
  async function preview(id: string) {
    const notice =
      state?.id === id && state.partial && state.notice
        ? `&notice=${encodeURIComponent(state.notice)}`
        : "";
    // Chrome activates a newly created tab before its preview URL commits.
    openingPreviews++;
    try {
      await chrome.tabs.create({
        url: chrome.runtime.getURL(`/long-screenshot.html?id=${encodeURIComponent(id)}${notice}`),
      });
    } finally {
      openingPreviews--;
    }
  }
  async function start(requested: "auto" | "manual" | "visible" = "auto") {
    if (running) throw new ScreenshotError("busy");
    if (!["auto", "manual", "visible"].includes(requested))
      throw new ScreenshotError("unsupported");
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !tab.url) throw new ScreenshotError("unsupported");
    if (running || options.isTabBusy(tab.id)) throw new ScreenshotError("busy");
    const id = crypto.randomUUID(),
      controller = new AbortController();
    const job: Job = { id, controller, paused: false, finished: false };
    running = job;
    const tabId = tab.id,
      windowId = tab.windowId,
      url = tab.url;
    const writer = new TileWriter(id, tab.title || new URL(url).hostname || "Screenshot");
    publish({
      id,
      tabId,
      pageUrl: url,
      title: writer.shot.title,
      mode: requested,
      phase: "preparing",
      progress: 0,
      frames: 0,
    });
    const checkTab = async () => {
      controller.signal.throwIfAborted();
      const current = await chrome.tabs.get(tabId);
      if (
        !current.active ||
        current.windowId !== windowId ||
        current.url !== url ||
        options.isTabBusy(tabId)
      )
        throw new ScreenshotError("changed");
    };
    const client = createPageClient(tabId, id, controller.signal, checkTab);
    const page = client.page;
    const checkpoint = async () => {
      while (job.paused && !job.finished) {
        controller.signal.throwIfAborted();
        if (job.page) await page({ action: "pause", paused: true });
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      controller.signal.throwIfAborted();
    };
    async function execute() {
      let source: Awaited<ReturnType<typeof openScreenshotSource>> | undefined;
      let complete = false;
      const changed = () => controller.abort(new ScreenshotError("changed"));
      const activated = (info: chrome.tabs.TabActiveInfo) => {
        if (info.windowId === windowId && info.tabId !== tabId) changed();
      };
      const updated = (updatedId: number, info: chrome.tabs.TabChangeInfo) => {
        if (updatedId === tabId && info.url && info.url !== url) changed();
      };
      // Tab loading status also includes ads and other subframes. Only a
      // top-level navigation invalidates the document being stitched.
      const navigated = (info: { tabId: number; frameId: number }) => {
        if (info.tabId === tabId && info.frameId === 0) changed();
      };
      const removed = (removedId: number) => {
        if (removedId === tabId) changed();
      };
      chrome.tabs.onActivated.addListener(activated);
      chrome.tabs.onUpdated.addListener(updated);
      chrome.tabs.onRemoved.addListener(removed);
      chrome.tabs.onAttached.addListener(removed);
      chrome.webNavigation.onBeforeNavigate.addListener(navigated);
      chrome.webNavigation.onCommitted.addListener(navigated);
      // Paused manual jobs have no content script traffic. Keep this user-started
      // operation alive; durable tile checkpoints also survive a worker restart.
      const heartbeat = setInterval(() => {
        void chrome.runtime.getPlatformInfo().catch(() => {});
      }, 20_000);
      try {
        const mode = requested;
        if (mode === "auto") await client.prepare();
        await checkTab();
        source = await openScreenshotSource(
          tabId,
          windowId,
          controller.signal,
          checkTab,
          mode === "auto",
        );
        const screenshot = async () => {
          const dataUrl = await source!.capture();
          await checkTab();
          return createImageBitmap(await (await fetch(dataUrl)).blob());
        };
        const write = (
          bitmap: ImageBitmap,
          width: number,
          sourceY: number,
          targetY: number,
          height: number,
        ) => writer.write(bitmap, width, sourceY, targetY, height, controller.signal);
        const progress = (frames: number, value: number, notice?: "alignment") => {
          if (state?.id === id)
            publish({
              ...state,
              phase: job.paused ? "paused" : "capturing",
              progress: value,
              frames,
              width: writer.shot.width,
              height: writer.shot.height,
              notice,
            });
        };
        if (mode === "auto") {
          await capturePage({
            page,
            prepared: () => {
              job.page = page;
            },
            screenshot,
            write,
            signal: controller.signal,
            checkpoint,
            finished: () => job.finished,
            label: i18n.t("longScreenshot.pageProgress", { ns: "extension" }),
            cancelLabel: i18n.t("longScreenshot.cancel", { ns: "extension" }),
            progress: (_phase, value, frames) => progress(frames, value),
          });
        } else {
          await captureManual({
            screenshot,
            write,
            signal: controller.signal,
            checkpoint,
            finished: () => job.finished,
            visible: mode === "visible",
            progress: (frames, notice) => progress(frames, 0, notice),
          });
        }
        controller.signal.throwIfAborted();
        if (!writer.shot.height) throw new ScreenshotError("captureFailed");
        await writer.finish();
        controller.signal.throwIfAborted();
        complete = true;
        if (state?.id === id)
          publish({
            ...state,
            phase: "complete",
            progress: 100,
            notice: undefined,
            width: writer.shot.width,
            height: writer.shot.height,
          });
      } catch (error) {
        const reason = controller.signal.aborted ? controller.signal.reason : error;
        const cancelled = controller.signal.aborted && !(reason instanceof ScreenshotError);
        const code =
          reason instanceof ScreenshotError
            ? reason.code
            : reason instanceof DOMException && reason.name === "QuotaExceededError"
              ? "storageFull"
              : "captureFailed";
        if (cancelled) {
          await removeTiledScreenshot(id).catch(() => {});
          if (state?.id === id) publish({ ...state, phase: "cancelled", notice: undefined });
        } else if (writer.shot.height) {
          await writer.finish(code).catch(() => {});
          complete = true;
          if (state?.id === id)
            publish({
              ...state,
              phase: "complete",
              partial: true,
              notice: code,
              width: writer.shot.width,
              height: writer.shot.height,
            });
        } else {
          await removeTiledScreenshot(id).catch(() => {});
          if (state?.id === id) publish({ ...state, phase: "error", error: code });
        }
      } finally {
        clearInterval(heartbeat);
        await source?.close();
        chrome.tabs.onActivated.removeListener(activated);
        chrome.tabs.onUpdated.removeListener(updated);
        chrome.tabs.onRemoved.removeListener(removed);
        chrome.tabs.onAttached.removeListener(removed);
        chrome.webNavigation.onBeforeNavigate.removeListener(navigated);
        chrome.webNavigation.onCommitted.removeListener(navigated);
        if (running?.id === id) running = null;
      }
      if (complete) await preview(id).catch(() => {});
    }
    void execute();
  }
  async function handle(
    request: CaptureRequest,
    sender: chrome.runtime.MessageSender,
  ): Promise<CaptureReply> {
    await ready;
    const extensionUi = sender.url?.startsWith(chrome.runtime.getURL("/"));
    if (!extensionUi && sender.tab) {
      if (
        request.action !== "cancel" ||
        sender.tab.id !== state?.tabId ||
        sender.frameId !== 0 ||
        request.id !== running?.id
      )
        return { ok: false, error: "unsupported" };
    } else if (!extensionUi) return { ok: false, error: "unsupported" };
    try {
      if (request.action === "status" || request.action === "preview")
        await clearResultOnPageChange();
      if (request.action === "start") await start(request.mode);
      else if (request.action === "preview") {
        if (!state || state.id !== request.id || state.phase !== "complete")
          throw new ScreenshotError("unavailable");
        await preview(request.id);
      } else if (request.action !== "status" && running && request.id === running.id) {
        if (request.action === "cancel") running.controller.abort();
        else if (request.action === "finish") {
          running.finished = true;
          running.paused = false;
        } else if (request.action === "pause" || request.action === "resume") {
          running.paused = request.action === "pause";
          await running.page?.({ action: "pause", paused: running.paused });
          if (state) publish({ ...state, phase: running.paused ? "paused" : "capturing" });
        }
      }
      return { ok: true, state };
    } catch (error) {
      return { ok: false, error: error instanceof ScreenshotError ? error.code : "captureFailed" };
    }
  }
  chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message !== "object") return;
    const request = message as CaptureRequest;
    if (request.type !== LONG_SCREENSHOT) return;
    void handle(request, sender).then(respond);
    return true;
  });
}
