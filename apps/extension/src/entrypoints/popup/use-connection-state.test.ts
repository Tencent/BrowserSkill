import { describe, expect, it } from "vitest";
import { resolvePopupDisplayState, resolvePopupStatusState } from "./use-connection-state";

describe("resolvePopupDisplayState", () => {
  it("returns wire state when not connecting", () => {
    expect(resolvePopupDisplayState("connected", "disconnected")).toBe("connected");
    expect(resolvePopupDisplayState("disconnected", "connected")).toBe("disconnected");
    expect(resolvePopupDisplayState("version_skew", "connected")).toBe("version_skew");
  });

  it("holds last stable state while connecting", () => {
    expect(resolvePopupDisplayState("connecting", "connected")).toBe("connected");
    expect(resolvePopupDisplayState("connecting", "disconnected")).toBe("disconnected");
    expect(resolvePopupDisplayState("connecting", "version_skew")).toBe("version_skew");
  });

  it("falls back to disconnected when no stable state yet", () => {
    expect(resolvePopupDisplayState("connecting", "connecting")).toBe("disconnected");
  });
});

describe("resolvePopupStatusState", () => {
  it("returns disabled when connection is turned off", () => {
    expect(
      resolvePopupStatusState({ connectionEnabled: false, state: "connected" }, "connected"),
    ).toBe("disabled");
  });

  it("returns version_skew when enabled and wire state is version_skew", () => {
    expect(
      resolvePopupStatusState({ connectionEnabled: true, state: "version_skew" }, "connected"),
    ).toBe("version_skew");
  });

  it("returns display state when enabled and not version_skew", () => {
    expect(
      resolvePopupStatusState({ connectionEnabled: true, state: "connected" }, "connected"),
    ).toBe("connected");
  });
});
