import { describe, expect, it, vi } from "vitest";
import { resolveDownloadTriggerUrl } from "../download-trigger-intent";
import type { ResolvedActionTarget } from "../interaction";
import type { CdpRunner } from "../shared";

const target: ResolvedActionTarget = {
  tab: { tabId: 4, windowId: 100, active: true },
  backendNodeId: 123,
  cdpTarget: { tabId: 4 },
};

describe("download trigger intent", () => {
  it("returns a validated HTTP URL from a target-blank anchor", async () => {
    const send = vi.fn(async (_tabId: number, method: string) => {
      if (method === "DOM.resolveNode") return { object: { objectId: "anchor" } };
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: "https://example.test/report.csv" } };
      }
      return {};
    }) as unknown as CdpRunner["send"];

    await expect(resolveDownloadTriggerUrl({ send }, target)).resolves.toBe(
      "https://example.test/report.csv",
    );
    expect(send).toHaveBeenCalledWith(4, "Runtime.releaseObject", { objectId: "anchor" });
  });

  it("rejects non-HTTP results", async () => {
    const send = vi.fn(async (_tabId: number, method: string) => {
      if (method === "DOM.resolveNode") return { object: { objectId: "anchor" } };
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: "javascript:download()" } };
      }
      return {};
    }) as unknown as CdpRunner["send"];

    await expect(resolveDownloadTriggerUrl({ send }, target)).resolves.toBeUndefined();
  });
});
