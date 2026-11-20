import { claimIdempotentContentScript } from "@/content/dom-primitives";
import { attachRecordFrameAgent } from "@/content/recording/frame-agent";

const RECORD_FRAME_MOUNTED_SYMBOL = Symbol.for("bsk.record_frame.mounted");

export default defineContentScript({
  registration: "runtime",
  matches: ["<all_urls>"],
  runAt: "document_start",
  allFrames: true,
  matchAboutBlank: true,
  matchOriginAsFallback: true,
  noScriptStartedPostMessage: true,

  main(ctx) {
    const releaseMount = claimIdempotentContentScript(
      ctx,
      "record-frame",
      RECORD_FRAME_MOUNTED_SYMBOL,
    );
    if (!releaseMount) return;
    const dispose = attachRecordFrameAgent();
    ctx.onInvalidated(() => {
      releaseMount();
      dispose();
    });
  },
});
