import { describe, expect, it, vi } from "vitest";
import { captureBrowserDownload, type DownloadsApi } from "../download-capture";
import type { CdpRunner } from "../shared";

describe("download trigger effect state", () => {
  it.each(["returned", "thrown"])("distinguishes pre/post-dispatch %s failures", async (kind) => {
    for (const dispatched of [false, true]) {
      const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
      const downloads: DownloadsApi = {
        onCreated: event(),
        onChanged: event(),
        onDeterminingFilename: event(),
        search: vi.fn(async () => []),
        cancel: vi.fn(async () => {}),
        removeFile: vi.fn(async () => {}),
      };
      const cdp: CdpRunner = { send: vi.fn(), onEvent: () => ({ dispose: vi.fn() }) };
      const result = await captureBrowserDownload({
        cdp,
        downloads,
        target: { tabId: 4 },
        browserRelativeDir: "BrowserSkill/effect",
        timeoutMs: 1_000,
        trigger: async (markDispatched) => {
          if (dispatched) markDispatched();
          if (kind === "thrown") throw new Error("trigger failed");
          return { code: "cancelled", message: "click aborted", data: { effect_state: "none" } };
        },
      });
      expect(result).toMatchObject({ data: { effect_state: dispatched ? "unknown" : "none" } });
      expect(downloads.cancel).not.toHaveBeenCalled();
      expect(downloads.removeFile).not.toHaveBeenCalled();
    }
  });
});
