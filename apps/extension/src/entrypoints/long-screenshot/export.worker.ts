import { exportPng } from "@/long-screenshot/png";
import type { TiledScreenshot } from "@/long-screenshot/tiles";

const controller = new AbortController();
self.onmessage = (event: MessageEvent<{ shot?: TiledScreenshot; cancel?: boolean }>) => {
  if (event.data.cancel) {
    controller.abort();
    return;
  }
  if (event.data.shot)
    void exportPng(event.data.shot, controller.signal, (progress) =>
      self.postMessage({ progress }),
    ).then(
      (file) => self.postMessage({ file }),
      (error) =>
        self.postMessage({
          error: error instanceof Error ? error.message : String(error),
          cancelled: controller.signal.aborted,
        }),
    );
};
