import { describe, expect, it } from "vitest";
import type { RpcError } from "@/transport/types";
import { cdpError, classifyCdpError } from "../errors";

const denied = "Cannot access a chrome-extension:// URL of different extension";

describe("CDP extension access errors", () => {
  it("classifies both Chrome Error instances and string failures", () => {
    for (const error of [new Error(denied), denied]) {
      expect(cdpError(error)).toEqual({
        code: "cdp_failed",
        message: denied,
        data: { reason: "cdp_extension_access_denied" },
      });
    }
  });

  it("preserves transfer outcome and cleanup instructions when CDP was denied", () => {
    const error: RpcError = {
      code: "cdp_failed",
      message: denied,
      data: {
        reason: "transfer_outcome_unknown",
        effect_state: "unknown",
        cleanup_state: "failed",
      },
    };
    expect(classifyCdpError(error)).toBe(error);
  });

  it("leaves other error codes and unrelated debugger failures unchanged", () => {
    for (const error of [
      { code: "permission_denied", message: denied },
      { code: "cdp_failed", message: "Another debugger is already attached" },
    ] satisfies RpcError[]) {
      expect(classifyCdpError(error)).toBe(error);
    }
  });
});
