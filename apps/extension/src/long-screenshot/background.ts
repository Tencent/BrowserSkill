import { i18n } from "@browser-skill/i18n";
import { capturePage } from "./capture";
import { captureManual } from "./manual";
import { openScreenshotSource } from "./source";
import { readTiledScreenshot, removeTiledScreenshot, TileWriter } from "./tiles";
import {
  type CaptureReply,
  type CaptureRequest,
  type CaptureState,
  isCapturing,
  LONG_SCREENSHOT,
  LONG_SCREENSHOT_PAGE,
  LONG_SCREENSHOT_STATE,
  type PageCommand,
  type PageReply,
  ScreenshotError,
} from "./types";
import { waitForReply } from "./wait";

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
  function publish(next: CaptureState) {
    state = next;
    writes = writes
      .then(() => chrome.storage.session.set({ [LONG_SCREENSHOT_STATE]: next }))
      .catch(() => {});
  }
  async function preview(id: string) {
    const notice =
      state?.id === id && state.partial && state.notice
        ? `&notice=${encodeURIComponent(state.notice)}`
        : "";
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`/long-screenshot.html?id=${encodeURIComponent(id)}${notice}`),
    });
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
        current.status === "loading" ||
        options.isTabBusy(tabId)
      )
        throw new ScreenshotError("changed");
    };
    let documentId: string | undefined;
    const page = async (command: PageCommand) => {
      if (command.action !== "finish") await checkTab();
      let response: PageReply;
      try {
        response = await waitForReply(
          chrome.tabs.sendMessage(
            tabId,
            { type: LONG_SCREENSHOT_PAGE, id, ...command },
            documentId ? { documentId } : { frameId: 0 },
          ),
          command.action === "finish" ? undefined : controller.signal,
          command.action === "finish" ? 2000 : 8000,
        );
      } catch (error) {
        if (error instanceof ScreenshotError || controller.signal.aborted) throw error;
        throw new ScreenshotError("unavailable");
      }
      if (!response?.ok) throw new ScreenshotError(response?.error ?? "unavailable");
      return response.metrics;
    };
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
        if (updatedId === tabId && (info.status === "loading" || info.url)) changed();
      };
      const removed = (removedId: number) => {
        if (removedId === tabId) changed();
      };
      chrome.tabs.onActivated.addListener(activated);
      chrome.tabs.onUpdated.addListener(updated);
      chrome.tabs.onRemoved.addListener(removed);
      chrome.tabs.onAttached.addListener(removed);
      // Paused manual jobs have no content script traffic. Keep this user-started
      // operation alive; durable tile checkpoints also survive a worker restart.
      const heartbeat = setInterval(() => {
        void chrome.runtime.getPlatformInfo().catch(() => {});
      }, 20_000);
      try {
        let mode = requested;
        if (mode === "auto") {
          try {
            const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
            documentId = frame?.documentId;
            if (!documentId) throw new ScreenshotError("unavailable");
            await page({ action: "probe" });
          } catch {
            controller.signal.throwIfAborted();
            mode = "manual";
          }
        }
        if (state?.id === id) publish({ ...state, mode });
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
