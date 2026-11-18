import { claimIdempotentContentScript } from "@/content/dom-primitives";
import { createPageCapture, pageError } from "@/long-screenshot/page";
import {
  LONG_SCREENSHOT,
  LONG_SCREENSHOT_PAGE,
  type PageRequest,
  ScreenshotError,
} from "@/long-screenshot/types";

const LONG_SCREENSHOT_MOUNTED_SYMBOL = Symbol.for("bsk.long_screenshot_page.mounted");

export default defineContentScript({
  registration: "runtime",
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_end",
  allFrames: false,
  noScriptStartedPostMessage: true,
  main(ctx) {
    const releaseMount = claimIdempotentContentScript(
      ctx,
      "long-screenshot-page",
      LONG_SCREENSHOT_MOUNTED_SYMBOL,
    );
    if (!releaseMount) return;

    const capture = createPageCapture((id, reason) => {
      void chrome.runtime
        .sendMessage({ type: LONG_SCREENSHOT, action: "cancel", id, reason })
        .catch(() => {});
    });
    const listener = (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      respond: (reply: unknown) => void,
    ) => {
      if (sender.id !== chrome.runtime.id || !message || typeof message !== "object") return;
      const request = message as PageRequest;
      if (request.type !== LONG_SCREENSHOT_PAGE || typeof request.id !== "string") return;
      void capture.handle(request).then(
        (metrics) => respond({ ok: true, metrics }),
        (error) =>
          respond({
            ok: false,
            error: pageError(error),
            ...(error instanceof ScreenshotError && error.reason ? { reason: error.reason } : {}),
          }),
      );
      return true;
    };
    chrome.runtime.onMessage.addListener(listener);
    ctx.onInvalidated(() => {
      releaseMount();
      capture.dispose();
      chrome.runtime.onMessage.removeListener(listener);
    });
  },
});
