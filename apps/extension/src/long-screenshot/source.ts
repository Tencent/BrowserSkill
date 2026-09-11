import { ScreenshotError } from "./types";
import { waitForReply } from "./wait";

/** Select a capture backend before measuring the page: attaching a debugger can
 * change the viewport through Chrome's infobar. Never switch midway through a PNG. */
export async function openScreenshotSource(
  tabId: number,
  windowId: number,
  signal: AbortSignal,
  checkTab: () => Promise<void>,
  allowDebugger = true,
  // Agent requests can reuse their session's debugger instead of attaching a
  // second owner. Popup captures keep the standalone attachment below.
  fallback?: () => Promise<{ capture(): Promise<string>; close(): Promise<void> }>,
) {
  let lastShot = Date.now();
  try {
    // A short probe keeps ordinary captures free of debugger attachments, while
    // handling platforms on which window-surface readback fails or never returns.
    await waitForReply(chrome.tabs.captureVisibleTab(windowId, { format: "png" }), signal, 2000);
    return {
      async capture() {
        const delay = Math.max(0, 600 - (Date.now() - lastShot));
        if (delay) await waitForReply(new Promise((resolve) => setTimeout(resolve, delay)), signal);
        await checkTab();
        lastShot = Date.now();
        return waitForReply(chrome.tabs.captureVisibleTab(windowId, { format: "png" }), signal);
      },
      async close() {},
    };
  } catch (error) {
    if (signal.aborted) throw error;
    if (!allowDebugger) throw new ScreenshotError("unavailable");
  }
  await checkTab();
  if (fallback) return fallback();
  const target = { tabId };
  const attaching = chrome.debugger.attach(target, "1.3");
  try {
    await waitForReply(attaching, signal);
  } catch (error) {
    // If cancellation wins the race with a successful attach, still release
    // only that attachment. A failed attach never detaches another debugger.
    void attaching.then(() => chrome.debugger.detach(target)).catch(() => {});
    if (signal.aborted || error instanceof ScreenshotError) throw error;
    throw new ScreenshotError("busy");
  }
  return {
    async capture() {
      await checkTab();
      const result = (await waitForReply(
        chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
        }),
        signal,
      )) as { data?: string };
      if (!result?.data) throw new ScreenshotError("captureFailed");
      return `data:image/png;base64,${result.data}`;
    },
    async close() {
      await waitForReply(chrome.debugger.detach(target), undefined, 2000).catch(() => {});
    },
  };
}
