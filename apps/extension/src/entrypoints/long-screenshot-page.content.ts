import { createPageCapture, pageError } from "@/long-screenshot/page";
import { LONG_SCREENSHOT, LONG_SCREENSHOT_PAGE, type PageRequest } from "@/long-screenshot/types";

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_end",
  allFrames: false,
  main(ctx) {
    const capture = createPageCapture((id) => {
      void chrome.runtime
        .sendMessage({ type: LONG_SCREENSHOT, action: "cancel", id })
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
        (error) => respond({ ok: false, error: pageError(error) }),
      );
      return true;
    };
    chrome.runtime.onMessage.addListener(listener);
    ctx.onInvalidated(() => {
      capture.dispose();
      chrome.runtime.onMessage.removeListener(listener);
    });
  },
});
