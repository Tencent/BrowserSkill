import { afterEach, expect, it, vi } from "vitest";
import { attachVideoBridge } from "./bridge";
import type { VideoHost } from "./host-protocol";
import type { VideoManager } from "./manager";
import { VIDEO_OVERLAY } from "./overlay";

vi.mock("./downloads", () => ({
  VideoDownloads: class {
    attach() {}
  },
}));
afterEach(() => vi.unstubAllGlobals());

function fixture(frame: object) {
  const addListener = vi.fn();
  const getFrame = vi.fn(async () => frame);
  vi.stubGlobal("chrome", {
    runtime: { id: "extension", onMessage: { addListener } },
    webNavigation: { getFrame },
  });
  const queryOverlay = vi.fn(async () => null);
  const suspend = vi.fn(async () => "video");
  attachVideoBridge({ queryOverlay, suspend } as unknown as VideoManager, {} as VideoHost, vi.fn());
  const receive = addListener.mock.calls[0][0];
  const request = (action = "query", sender = {}) =>
    new Promise((resolve) => {
      receive(
        { type: VIDEO_OVERLAY, action },
        {
          id: "extension",
          tab: { id: 7 },
          frameId: 8,
          documentId: "document",
          ...sender,
        },
        resolve,
      );
    });
  return { request, queryOverlay, suspend, getFrame };
}

it("resolves an activated outermost document by documentId, even with a nonzero sender frameId", async () => {
  const f = fixture({
    frameType: "outermost_frame",
    documentLifecycle: "active",
    documentId: "document",
  });
  await expect(f.request()).resolves.toEqual({ recording_id: null });
  expect(f.getFrame).toHaveBeenCalledWith({ tabId: 7, documentId: "document" });
  expect(f.queryOverlay).toHaveBeenCalledWith(7, "document");
  await expect(f.request("clean")).resolves.toEqual({ recording_id: "video" });
  expect(f.suspend).toHaveBeenCalledWith(7, "clean", "document");
});

it.each([
  { frameType: "outermost_frame", documentLifecycle: "prerender", documentId: "document" },
  { frameType: "outermost_frame", documentLifecycle: "cached", documentId: "document" },
  { frameType: "sub_frame", documentLifecycle: "active", documentId: "document" },
  { frameType: "outermost_frame", documentLifecycle: "active", documentId: "replaced" },
])("does not let an inactive, nested or replaced document affect capture: %j", async (frame) => {
  const f = fixture(frame);
  for (const action of ["query", "clean", "interactive"])
    await expect(f.request(action)).resolves.toEqual({ error: "Video overlay handshake failed" });
  expect(f.queryOverlay).not.toHaveBeenCalled();
  expect(f.suspend).not.toHaveBeenCalled();
});
