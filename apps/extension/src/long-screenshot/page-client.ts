import { LONG_SCREENSHOT_PAGE, type PageCommand, type PageReply, ScreenshotError } from "./types";
import { waitForReply } from "./wait";

/** Bind every command (including cleanup and reinjection) to one document. */
export function createPageClient(
  tabId: number,
  id: string,
  signal: AbortSignal,
  checkTab: () => Promise<void>,
) {
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
        command.action === "finish" ? undefined : signal,
        command.action === "finish" ? 2000 : 8000,
      );
    } catch (error) {
      if (error instanceof ScreenshotError || signal.aborted) throw error;
      throw new ScreenshotError("unavailable");
    }
    if (!response?.ok) throw new ScreenshotError(response?.error ?? "unavailable");
    return response.metrics;
  };
  return {
    page,
    get documentId() {
      return documentId;
    },
    async prepare() {
      const frame = await waitForReply(
        chrome.webNavigation.getFrame({ tabId, frameId: 0 }),
        signal,
      );
      documentId = frame?.documentId;
      if (!documentId) throw new ScreenshotError("autoUnavailable");
      try {
        await page({ action: "probe" });
      } catch (error) {
        // Tabs open before an extension reload may lack this content script.
        // Repair only that case; timeout, navigation and page errors stay errors.
        if (!(error instanceof ScreenshotError) || error.code !== "unavailable") throw error;
        await checkTab();
        try {
          await waitForReply(
            chrome.scripting.executeScript({
              target: { tabId, documentIds: [documentId] },
              files: ["content-scripts/long-screenshot-page.js"],
            }),
            signal,
          );
          await page({ action: "probe" });
        } catch (error) {
          await checkTab();
          if (error instanceof ScreenshotError && error.code !== "unavailable") throw error;
          throw new ScreenshotError("autoUnavailable");
        }
      }
    },
  };
}
