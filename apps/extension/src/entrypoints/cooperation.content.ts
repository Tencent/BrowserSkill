import { attachCooperationCapture } from "@/content/cooperation-capture";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  allFrames: true,
  matchAboutBlank: true,
  matchOriginAsFallback: true,
  main(ctx) {
    ctx.onInvalidated(attachCooperationCapture());
  },
});
