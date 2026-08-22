import { attachRecordFrameAgent } from "@/content/recording/frame-agent";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  allFrames: true,
  matchAboutBlank: true,
  matchOriginAsFallback: true,

  main(ctx) {
    const dispose = attachRecordFrameAgent();
    ctx.onInvalidated(dispose);
  },
});
