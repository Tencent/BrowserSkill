import type { VideoHostCommand, VideoHostReply } from "./host-protocol";
import { VideoArtifactStore } from "./store";
import { VIDEO_HOST_EVENT, VIDEO_HOST_MESSAGE } from "./types";

export function attachVideoOffscreen(): void {
  const pending = new Map<string, (reply: VideoHostReply) => void>();
  const urls = new Set<string>();
  const store = new VideoArtifactStore();
  let activeId: string | undefined;
  let worker = createWorker();

  function resetWorker(): void {
    worker.terminate();
    for (const [id, respond] of pending)
      respond({ id, error: "Video worker stopped unexpectedly" });
    pending.clear();
    worker = createWorker();
    if (activeId) {
      // Recovery is independent of the failed caller's response. A timeout or
      // worker crash must not require restarting the whole browser to salvage.
      worker.postMessage({
        id: crypto.randomUUID(),
        command: { action: "recover", recording_id: activeId, reason: "encoding_failed" },
      });
      void chrome.runtime
        .sendMessage({ kind: VIDEO_HOST_EVENT, recording_id: activeId, failed: true })
        .catch(() => {});
      activeId = undefined;
    }
  }

  function createWorker(): Worker {
    const next = new Worker(new URL("./encoder.worker.ts", import.meta.url), { type: "module" });
    next.addEventListener("message", (event) => {
      if (next !== worker) return;
      if (event.data.event === "finished") {
        activeId = undefined;
        void chrome.runtime
          .sendMessage({ kind: VIDEO_HOST_EVENT, recording_id: event.data.recording_id })
          .catch(() => {});
        return;
      }
      const callback = pending.get(event.data.id);
      pending.delete(event.data.id);
      callback?.(event.data);
    });
    next.addEventListener("error", () => {
      if (next === worker) resetWorker();
    });
    return next;
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.kind !== VIDEO_HOST_MESSAGE) return false;
    if (
      sender.id !== chrome.runtime.id ||
      sender.tab ||
      (sender.url && sender.url !== chrome.runtime.getURL("background.js"))
    )
      return false;
    const id = message.id as string;
    const command = message.command as VideoHostCommand;
    const execute = async () => {
      if (command.action === "download_url") {
        const value = await store.get(command.recording_id);
        if (value?.state !== "ready") throw new Error("Video is not ready to save");
        const url = URL.createObjectURL(await store.file(command.recording_id));
        urls.add(url);
        return url;
      }
      if (command.action === "revoke_url") {
        if (urls.delete(command.url)) URL.revokeObjectURL(command.url);
        return;
      }
      if (command.action === "idle" && urls.size > 0) return false;
      if (command.action === "start") activeId = command.recording.recording_id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resetWorker();
        }, 29_000);
        pending.set(id, (reply) => {
          clearTimeout(timer);
          if (reply.error) reject(new Error(reply.error));
          else resolve(reply.result);
        });
        worker.postMessage({ id, command });
      });
    };
    void execute().then(
      (result) => respond({ id, result }),
      (error: unknown) =>
        respond({ id, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  });
}
