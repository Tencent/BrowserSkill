import { attachCooperationCapture } from "@/content/cooperation-capture";
import { claimIdempotentContentScript } from "@/content/dom-primitives";

const COOPERATION_MOUNTED_SYMBOL = Symbol.for("bsk.cooperation.mounted");

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
      "cooperation",
      COOPERATION_MOUNTED_SYMBOL,
    );
    if (!releaseMount) return;
    const dispose = attachCooperationCapture();
    ctx.onInvalidated(() => {
      releaseMount();
      dispose();
    });
  },
});
