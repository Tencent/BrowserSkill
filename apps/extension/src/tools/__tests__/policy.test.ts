import { describe, expect, it } from "vitest";
import { debugActions, eventNames, methods } from "@/transport/generated/methods";
import { decodeToolRequest } from "@/transport/protocol";
import { isPassiveDebugAction, TOOL_POLICIES, toolPolicy } from "../policy";

describe("protocol-backed extension policies", () => {
  it("covers every extension-owned protocol method without stale entries", () => {
    const expected = methods
      .filter((entry) => entry.owner === "extension")
      .map((entry) => entry.method)
      .sort();
    const actual = Object.keys(TOOL_POLICIES).sort();
    expect(actual).toEqual(expected);
    for (const method of expected) {
      expect(toolPolicy(method)).toBeDefined();
    }
  });

  it("derives passive vs cooperation-guarded debug actions from generated catalog metadata", () => {
    const guarded = debugActions
      .filter((entry) => entry.owner === "extension" && entry.cooperation_guarded)
      .map((entry) => entry.action)
      .sort();
    expect(guarded).toEqual(["replay", "rule_add", "rule_disable", "rule_enable", "rule_remove"]);
    for (const entry of debugActions.filter((item) => item.owner === "extension")) {
      expect(isPassiveDebugAction(entry.action)).toBe(!entry.cooperation_guarded);
    }
  });

  it("exports unique protocol event names including dialog.changed and session.ended", () => {
    expect(new Set(eventNames).size).toBe(eventNames.length);
    expect(eventNames).toContain("dialog.changed");
    expect(eventNames).toContain("session.ended");
  });

  it("strips daemon envelope metadata before validating strict-schema tool requests", () => {
    const decoded = decodeToolRequest({
      id: "read-1",
      method: "tool.read",
      params: {
        session_id: "aa11",
        selector: "#price",
        context_id: null,
        _audit_id: "audit-123",
        _operation_id: "op-456",
      },
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.request).toEqual({
      id: "read-1",
      method: "tool.read",
      params: {
        session_id: "aa11",
        selector: "#price",
      },
    });
  });
});
