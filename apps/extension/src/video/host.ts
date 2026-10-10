import type { VideoHost, VideoHostCommand, VideoHostReply } from "./host-protocol";
import { VIDEO_HOST_MESSAGE } from "./types";

/** The extension has one offscreen document; concurrent callers share creation. */
export class BrowserVideoHost implements VideoHost {
  private creating?: Promise<void>;
  private lifecycle = Promise.resolve();
  private requests = 0;

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async ensure(): Promise<void> {
    this.creating ??= (async () => {
      if (await chrome.offscreen.hasDocument()) return;
      await chrome.offscreen.createDocument({
        url: "video-offscreen.html",
        reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS],
        justification: "Encode task videos in a worker and stream MP4 files to browser storage",
      });
    })().finally(() => {
      this.creating = undefined;
    });
    return this.creating;
  }

  async request<T>(command: VideoHostCommand): Promise<T> {
    await this.serialize(async () => {
      await this.ensure();
      this.requests++;
    });
    try {
      return await this.send<T>(command);
    } finally {
      this.requests--;
      if (["stop", "recover", "revoke_url"].includes(command.action))
        void this.closeWhenIdle().catch(() => {});
    }
  }

  private async send<T>(command: VideoHostCommand): Promise<T> {
    const id = crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([
        chrome.runtime.sendMessage({
          kind: VIDEO_HOST_MESSAGE,
          id,
          command,
        }) as Promise<VideoHostReply>,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Video encoder did not respond")), 30_000);
        }),
      ]);
      if (!reply || reply.id !== id) throw new Error("Video encoder returned an invalid response");
      if (reply.error) throw new Error(reply.error);
      return reply.result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async closeWhenIdle(): Promise<void> {
    await this.serialize(async () => {
      if (this.requests || !(await chrome.offscreen.hasDocument())) return;
      if (await this.send<boolean>({ action: "idle" })) await chrome.offscreen.closeDocument();
    });
  }
}
