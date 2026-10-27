import type { VideoHost } from "./host-protocol";
import type { VideoManager } from "./manager";
import { videoFilename } from "./types";

const PREFIX = "bsk-video-download-";
interface DownloadJob {
  recording: string;
  url: string;
}

/** Persist the download ID across service-worker suspension. Mark saved only
 * after Chrome reports a completed file, including when the preview is closed. */
export class VideoDownloads {
  private readonly settling = new Map<number, Promise<void>>();
  constructor(
    private readonly video: VideoManager,
    private readonly host: VideoHost,
  ) {}

  attach(): void {
    chrome.downloads.onChanged.addListener((delta) => {
      void this.settle(delta.id).catch(() => {});
    });
    void chrome.storage.session
      .get(null)
      .then(async (values) => {
        for (const key of Object.keys(values)) {
          if (key.startsWith(PREFIX)) await this.settle(Number(key.slice(PREFIX.length)));
        }
      })
      .catch(() => {});
  }

  private settle(id: number): Promise<void> {
    // A completion event can precede persistence of the download job. Queue a
    // fresh lookup instead of dropping overlapping notifications or save().
    const pending = (this.settling.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.settleOnce(id))
      .finally(() => {
        if (this.settling.get(id) === pending) this.settling.delete(id);
      });
    this.settling.set(id, pending);
    return pending;
  }

  private async settleOnce(id: number): Promise<void> {
    const key = `${PREFIX}${id}`;
    const job = (await chrome.storage.session.get(key))[key] as DownloadJob | undefined;
    if (!job) return;
    const [download] = await chrome.downloads.search({ id });
    if (download?.state === "in_progress") return;
    // A record may expire or be deleted while Save As is open. The completed
    // file still belongs to the user; always release its temporary Blob URL.
    if (download?.state === "complete") await this.video.exported(job.recording).catch(() => {});
    await this.host.request({ action: "revoke_url", url: job.url });
    await chrome.storage.session.remove(key);
  }

  async save(recordingId: string): Promise<{ download_id: number }> {
    const value = await this.video.get(recordingId);
    if (value.state !== "ready") throw new Error("Video is not ready to save");
    const url = await this.host.request<string>({
      action: "download_url",
      recording_id: recordingId,
    });
    try {
      const id = await chrome.downloads.download({
        url,
        filename: videoFilename(value),
        saveAs: true,
      });
      await chrome.storage.session.set({
        [`${PREFIX}${id}`]: { recording: recordingId, url } satisfies DownloadJob,
      });
      await this.settle(id);
      return { download_id: id };
    } catch (error) {
      await this.host.request({ action: "revoke_url", url }).catch(() => {});
      throw error;
    }
  }
}
