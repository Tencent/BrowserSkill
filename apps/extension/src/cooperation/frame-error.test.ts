import { describe, expect, it } from "vitest";
import { FrameCollectionError } from "./frame-error";

describe("FrameCollectionError recovery guidance", () => {
  it("recommends navigation instead of reload for an unobservable about:blank tab", () => {
    const error = new FrameCollectionError("frame_unobservable", [{ frame_id: 0, url: "about:" }]);

    expect(error.toRpcError().data?.recovery).toContain("bsk navigate <url> --session <id>");
    expect(error.toRpcError().data?.recovery).not.toContain("Reload the tab once");
  });

  it("keeps the reload recovery guidance for other unobservable pages", () => {
    const error = new FrameCollectionError("frame_unobservable", [
      { frame_id: 0, url: "https://example.com" },
    ]);

    expect(error.toRpcError().data?.recovery).toContain("Reload the tab once");
  });

  it("does not replace the recovery guidance when an action result is uncertain", () => {
    const error = new FrameCollectionError("frame_unobservable", [{ frame_id: 0, url: "about:" }]);

    expect(error.toRpcError("unknown").data?.recovery).toContain(
      "Never replay an uncertain submission.",
    );
  });
});
