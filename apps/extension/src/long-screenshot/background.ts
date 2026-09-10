import { i18n } from "@browser-skill/i18n";
import { capturePage } from "./capture";
import { openScreenshotSource } from "./source";
import { saveScreenshot } from "./storage";
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

/** This entry point has no dependency on the CLI, transport or Agent sessions. */
export function attachLongScreenshot(options: { isTabBusy(tabId: number): boolean }) {
  let state: CaptureState | null = null;
  let running: { id: string; controller: AbortController } | null = null;
  let writes = Promise.resolve();
  const ready = chrome.storage.session
    .get(LONG_SCREENSHOT_STATE)
    .then((stored) => {
      state = stored[LONG_SCREENSHOT_STATE] ?? null;
      // A restarted worker cannot resume an in-memory canvas.
      if (isCapturing(state) && state) publish({ ...state, phase: "error", error: "interrupted" });
    })
    .catch(() => {});

  function publish(next: CaptureState) {
    state = next;
    writes = writes
      .then(() => chrome.storage.session.set({ [LONG_SCREENSHOT_STATE]: next }))
      .catch(() => {});
  }

  async function preview(id: string) {
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`/long-screenshot.html?id=${encodeURIComponent(id)}`),
    });
  }

  async function start() {
    if (running) throw new ScreenshotError("busy");
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !tab.url || !/^https?:\/\//.test(tab.url))
      throw new ScreenshotError("unsupported");
    if (running || options.isTabBusy(tab.id)) throw new ScreenshotError("busy");
    const id = crypto.randomUUID();
    const controller = new AbortController();
    running = { id, controller };
    const tabId = tab.id;
    const windowId = tab.windowId;
    const url = tab.url;
    publish({
      id,
      tabId,
      title: tab.title || new URL(url).hostname,
      phase: "preparing",
      progress: 0,
      frames: 0,
    });

    async function checkTab() {
      controller.signal.throwIfAborted();
      const current = await chrome.tabs.get(tabId);
      if (
        !current.active ||
        current.windowId !== windowId ||
        current.url !== url ||
        current.status === "loading" ||
        options.isTabBusy(tabId)
      ) {
        throw new ScreenshotError("changed");
      }
    }

    let documentId: string | undefined;
    async function page(command: PageCommand) {
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
    }

    async function execute() {
      let source: Awaited<ReturnType<typeof openScreenshotSource>> | undefined;
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
      const attached = (attachedId: number) => {
        if (attachedId === tabId) changed();
      };
      chrome.tabs.onActivated.addListener(activated);
      chrome.tabs.onUpdated.addListener(updated);
      chrome.tabs.onRemoved.addListener(removed);
      chrome.tabs.onAttached.addListener(attached);
      const stopWatching = () => {
        chrome.tabs.onActivated.removeListener(activated);
        chrome.tabs.onUpdated.removeListener(updated);
        chrome.tabs.onRemoved.removeListener(removed);
        chrome.tabs.onAttached.removeListener(attached);
      };
      try {
        const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
        documentId = frame?.documentId;
        if (!documentId) throw new ScreenshotError("unavailable");
        // Fail with a refresh/unsupported-page hint before acquiring any capture
        // backend if this document cannot receive the extension content script.
        await page({ action: "probe" });
        await checkTab();
        source = await openScreenshotSource(tabId, windowId, controller.signal, checkTab);
        const result = await capturePage({
          page,
          signal: controller.signal,
          label: i18n.t("longScreenshot.pageProgress", { ns: "extension" }),
          cancelLabel: i18n.t("longScreenshot.cancel", { ns: "extension" }),
          progress: (phase, progress, frames) => {
            if (state?.id === id) publish({ ...state, phase, progress, frames });
          },
          screenshot: async () => {
            const dataUrl = await source!.capture();
            await checkTab();
            const response = await fetch(dataUrl);
            return createImageBitmap(await response.blob());
          },
        });
        await source.close();
        source = undefined;
        controller.signal.throwIfAborted();
        try {
          await saveScreenshot({
            id,
            title: state?.title ?? "Screenshot",
            createdAt: Date.now(),
            ...result,
          });
        } catch {
          throw new ScreenshotError("saveFailed");
        }
        controller.signal.throwIfAborted();
        stopWatching();
        if (state?.id === id)
          publish({ ...state, phase: "complete", width: result.width, height: result.height });
        // The result remains available from the popup if opening the tab fails.
        await preview(id).catch(() => {});
      } catch (error) {
        const reason = controller.signal.aborted ? controller.signal.reason : error;
        const cancelled = controller.signal.aborted && !(reason instanceof ScreenshotError);
        if (state?.id === id)
          publish({
            ...state,
            phase: cancelled ? "cancelled" : "error",
            error: cancelled
              ? undefined
              : reason instanceof ScreenshotError
                ? reason.code
                : "captureFailed",
          });
      } finally {
        await source?.close();
        stopWatching();
        if (running?.id === id) running = null;
      }
    }
    void execute();
  }

  async function handle(
    request: CaptureRequest,
    sender: chrome.runtime.MessageSender,
  ): Promise<CaptureReply> {
    await ready;
    // Web pages may only cancel their own active job; start/preview/status are
    // reserved for extension UI, even though content scripts share runtime.id.
    const extensionUi = sender.url?.startsWith(chrome.runtime.getURL("/"));
    if (!extensionUi && sender.tab) {
      if (
        request.action !== "cancel" ||
        sender.tab.id !== state?.tabId ||
        sender.frameId !== 0 ||
        request.id !== running?.id
      ) {
        return { ok: false, error: "unsupported" };
      }
    } else if (!extensionUi) {
      return { ok: false, error: "unsupported" };
    }
    try {
      if (request.action === "start") await start();
      else if (request.action === "cancel" && request.id === running?.id)
        running.controller.abort();
      else if (request.action === "preview") {
        if (!state || state.id !== request.id || state.phase !== "complete")
          throw new ScreenshotError("unavailable");
        await preview(request.id);
      }
      return { ok: true, state };
    } catch (error) {
      return { ok: false, error: error instanceof ScreenshotError ? error.code : "captureFailed" };
    }
  }

  chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message !== "object") return;
    const request = message as CaptureRequest;
    if (
      request.type !== LONG_SCREENSHOT ||
      !["start", "cancel", "status", "preview"].includes(request.action)
    )
      return;
    void handle(request, sender).then(respond);
    return true;
  });
}
