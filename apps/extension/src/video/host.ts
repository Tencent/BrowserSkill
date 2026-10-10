import { VideoError } from "./errors";
import type { VideoHost, VideoHostCommand, VideoHostReply } from "./host-protocol";
import { VIDEO_HOST_PORT } from "./types";

class HostDisconnectedError extends Error {}

/** One connection per offscreen lifetime, shared by control messages and frames. */
export class BrowserVideoHost implements VideoHost {
  private port?: chrome.runtime.Port;
  private lifecycle = Promise.resolve();
  private requests = 0;
  private readonly pending = new Map<
    string,
    (reply: VideoHostReply, disconnected?: boolean) => void
  >();

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async ensure(create = true): Promise<boolean> {
    if (this.port) return true;
    if (!(await chrome.offscreen.hasDocument())) {
      if (!create) return false;
      await chrome.offscreen.createDocument({
        url: "video-offscreen.html",
        reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS],
        justification: "Encode task videos in a worker and stream MP4 files to browser storage",
      });
    }
    const port = chrome.runtime.connect({ name: VIDEO_HOST_PORT });
    this.port = port;
    port.onMessage.addListener((reply: VideoHostReply) => {
      if (this.port === port) this.pending.get(reply.id)?.(reply);
    });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.port = undefined;
      for (const [id, respond] of this.pending) respond({ id }, true);
    });
    return true;
  }

  async request<T>(command: VideoHostCommand): Promise<T> {
    await this.serialize(async () => {
      await this.ensure();
      this.requests++;
    });
    try {
      try {
        return await this.send<T>(command);
      } catch (error) {
        // A closed document's disconnect event may arrive after the next request.
        // Only idempotent cleanup/recovery commands can safely cross that race.
        if (
          !(error instanceof HostDisconnectedError) ||
          !["stop", "recover", "idle"].includes(command.action)
        )
          throw error;
        await this.serialize(() => this.ensure());
        return await this.send<T>(command);
      }
    } finally {
      this.requests--;
      if (["stop", "recover", "revoke_url"].includes(command.action))
        void this.closeWhenIdle().catch(() => {});
    }
  }

  private send<T>(command: VideoHostCommand): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new VideoError({ code: "timeout", message: "Video encoder did not respond" }));
      }, 30_000);
      this.pending.set(id, (reply, disconnected) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (disconnected) reject(new HostDisconnectedError("Video encoder disconnected"));
        else if (reply.error) reject(new VideoError(reply.error));
        else resolve(reply.result as T);
      });
      try {
        if (!this.port) throw new Error("Video encoder disconnected");
        this.port.postMessage({ id, command });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async closeWhenIdle(): Promise<void> {
    await this.serialize(async () => {
      if (this.requests || !(await this.ensure(false))) return;
      if (await this.send<boolean>({ action: "idle" })) {
        const port = this.port;
        await chrome.offscreen.closeDocument();
        // A later caller reconnects; the previous port cannot invalidate it.
        if (this.port === port) this.port = undefined;
        port?.disconnect();
      }
    });
  }
}
