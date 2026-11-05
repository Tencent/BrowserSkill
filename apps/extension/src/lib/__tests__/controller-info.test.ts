import { describe, expect, it } from "vitest";
import { controllerColor, isControllerInfo } from "../controller-info";

describe("controller display metadata", () => {
  it.each([
    null,
    [],
    {},
    { name: "" },
    { name: "  " },
    { name: "\ufeff" },
    { name: "a".repeat(81) },
    { name: "Agent\nOther" },
    { name: "Agent", project: "x".repeat(121) },
    { name: "Agent", project: "\u0085" },
    { name: "Agent", color: "red" },
    { name: "Agent", color: "#fff" },
    { name: "Agent", color: "#12345g" },
  ])("rejects invalid metadata: %j", (info) => {
    expect(isControllerInfo(info)).toBe(false);
  });

  it("counts Unicode code points consistently with the daemon", () => {
    expect(isControllerInfo({ name: "🦀".repeat(80), project: "项目".repeat(60) })).toBe(true);
    expect(isControllerInfo({ name: "🦀".repeat(81) })).toBe(false);
    expect(isControllerInfo({ name: "Codex", color: "#aBcD09" })).toBe(true);
    expect(isControllerInfo({ name: "Codex", project: null, color: null })).toBe(true);
  });

  it("keeps fallback colors stable across rendering and honors valid hex overrides", () => {
    expect(controllerColor("aaaa")).toBe(controllerColor("aaaa", { name: "Codex" }));
    expect(controllerColor("aaaa")).not.toBe(controllerColor("aaab"));
    expect(controllerColor("aaaa", { name: "Codex", color: "#123456" })).toBe("#123456");
    expect(controllerColor("aaaa", { name: "Codex", color: "url(x)" })).toBe(
      controllerColor("aaaa"),
    );
  });
});
