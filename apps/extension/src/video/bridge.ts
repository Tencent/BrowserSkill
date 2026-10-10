import { VideoDownloads } from "./downloads";
import type { VideoHost } from "./host-protocol";
import type { VideoManager } from "./manager";
import { VIDEO_OVERLAY } from "./overlay";
import { publicVideo, VIDEO_HOST_EVENT, VIDEO_MESSAGE } from "./types";

export function isVideoPage(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  return ["popup.html", "video.html"].some(
    (page) => sender.url?.split("?")[0] === chrome.runtime.getURL(page),
  );
}

export function attachVideoBridge(
  video: VideoManager,
  host: VideoHost,
  interrupt: (session: string) => Promise<unknown>,
): void {
  const downloads = new VideoDownloads(video, host);
  downloads.attach();
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.kind === VIDEO_HOST_EVENT) {
      if (
        sender.id === chrome.runtime.id &&
        sender.url === chrome.runtime.getURL("video-offscreen.html")
      )
        void (
          message.failed
            ? video.stop(message.recording_id, "encoding_failed")
            : video.finished(message.recording_id)
        ).catch(() => {});
      return false;
    }
    if (message?.type === VIDEO_OVERLAY) {
      if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || sender.tab?.id === undefined)
        return false;
      const tab = sender.tab.id;
      const execute = async () => {
        const current = await chrome.webNavigation.getFrame({ tabId: tab, frameId: 0 });
        if (sender.documentId && current?.documentId !== sender.documentId)
          throw new Error("Video overlay document changed");
        if (message.action === "query") {
          return { recording_id: await video.queryOverlay(tab, sender.documentId) };
        }
        if (!["interactive", "clean"].includes(message.action))
          throw new Error("Invalid overlay action");
        return {
          recording_id: await video.suspend(
            tab,
            message.action === "interactive" ? "interactive" : "clean",
            sender.documentId,
          ),
        };
      };
      void execute().then(respond, () => respond({ error: "Video overlay handshake failed" }));
      return true;
    }
    if (message?.kind !== VIDEO_MESSAGE) return false;
    if (!isVideoPage(sender)) {
      respond({ ok: false, error: "forbidden" });
      return false;
    }
    const execute = async () => {
      switch (message.action) {
        case "snapshot":
          return { tasks: await video.tasks(), recordings: (await video.list()).map(publicVideo) };
        case "start":
          return { recording: (await video.start(message.options)).recording };
        case "stop":
          return { recording: publicVideo(await video.stop(message.recording_id)) };
        case "discard":
          await video.discard(message.recording_id);
          return {};
        case "interrupt":
          return interrupt(message.session_id);
        case "save":
          return downloads.save(message.recording_id);
        default:
          throw new Error("Unsupported video UI action");
      }
    };
    void execute().then(
      (data) => respond({ ok: true, data }),
      (error: unknown) =>
        respond({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  });
}
