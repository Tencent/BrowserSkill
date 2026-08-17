import {
  handleRecordContentMessage,
  isRecordContentMessage,
  type RecordCaptureController,
} from "@/content/record-capture";
import {
  RECORD_QUERY,
  type RecordQueryResponse,
} from "@/lib/record-bridge";

/** Capture-only content script for child frames (no React overlay). */
export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_end",
  allFrames: true,
  matchAboutBlank: true,
  matchOriginAsFallback: true,

  main(ctx) {
    if (window.top === window) return;

    let recordCapture: RecordCaptureController | null = null;
    let activeRecordRequestId: string | null = null;

    const onMessage = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ) => {
      if (isRecordContentMessage(message)) {
        const needsAsync = handleRecordContentMessage(
          message,
          {
            activeRequestId: activeRecordRequestId,
            capture: recordCapture,
            setActiveRequestId: (id) => {
              activeRecordRequestId = id;
            },
            setCapture: (capture) => {
              recordCapture = capture;
            },
          },
          sendResponse as never,
        );
        return needsAsync;
      }
      return false;
    };

    async function queryActiveRecord(): Promise<void> {
      try {
        const recordQuery = (await chrome.runtime.sendMessage({
          type: RECORD_QUERY,
        })) as RecordQueryResponse | undefined;
        if (
          recordQuery?.active &&
          typeof recordQuery.requestId === "string" &&
          activeRecordRequestId === null
        ) {
          // Background rearm sends RECORD_START; nothing to mount locally.
        }
      } catch (err) {
        console.debug("[bsk record-frame] record query failed", err);
      }
    }

    chrome.runtime.onMessage.addListener(onMessage);
    void queryActiveRecord();

    ctx.onInvalidated(() => {
      chrome.runtime.onMessage.removeListener(onMessage);
      recordCapture?.dispose();
      recordCapture = null;
      activeRecordRequestId = null;
    });
  },
});
