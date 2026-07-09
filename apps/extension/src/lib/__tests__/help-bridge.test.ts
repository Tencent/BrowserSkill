import { describe, expect, it } from "vitest";
import {
  HELP_CANCEL,
  HELP_REQUEST,
  HELP_RESPONSE,
  isHelpCancelMessage,
  isHelpRequestMessage,
} from "../help-bridge";

describe("help-bridge", () => {
  it("exposes stable message type constants", () => {
    expect(HELP_REQUEST).toBe("bsk-help-request");
    expect(HELP_RESPONSE).toBe("bsk-help-response");
    expect(HELP_CANCEL).toBe("bsk-help-cancel");
  });

  it("type-guards a help-request message", () => {
    expect(
      isHelpRequestMessage({
        type: HELP_REQUEST,
        requestId: "r1",
        prompt: "log in",
        selectors: ["#login"],
        timeoutMs: 1000,
      }),
    ).toBe(true);
    expect(isHelpRequestMessage({ type: "borrow-request" })).toBe(false);
    expect(isHelpRequestMessage(null)).toBe(false);
  });

  it("rejects a help-request message with missing/wrong fields", () => {
    expect(isHelpRequestMessage({ type: HELP_REQUEST })).toBe(false);
    expect(
      isHelpRequestMessage({
        type: HELP_REQUEST,
        requestId: "r1",
        prompt: "p",
        selectors: "nope",
        timeoutMs: 1,
      }),
    ).toBe(false);
    expect(
      isHelpRequestMessage({
        type: HELP_REQUEST,
        requestId: "r1",
        prompt: "p",
        selectors: [123],
        timeoutMs: 1,
      }),
    ).toBe(false);
  });

  it("type-guards a help-cancel message", () => {
    expect(isHelpCancelMessage({ type: HELP_CANCEL, requestId: "r1" })).toBe(true);
    expect(isHelpCancelMessage({ type: HELP_REQUEST, requestId: "r1" })).toBe(false);
    expect(isHelpCancelMessage(null)).toBe(false);
  });
});
