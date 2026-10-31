import { describe, expect, it } from "vitest";
import { type ActionExpectation, validateExpectations } from "../src/tool-params";

describe("expect condition limits", () => {
  it.each([
    "a",
    "中",
    "😀",
  ])("counts %s as one character at target and attribute boundaries", (char) => {
    const condition: ActionExpectation = {
      target: `#${char.repeat(1023)}`,
      field: "attribute",
      attribute: `data-${char.repeat(251)}`,
      equals: null,
    };
    expect(() => validateExpectations([condition])).not.toThrow();
    expect(() => validateExpectations([{ ...condition, target: condition.target + char }])).toThrow(
      "at most 1024 characters",
    );
    expect(() =>
      validateExpectations([{ ...condition, attribute: condition.attribute + char }]),
    ).toThrow("at most 256 characters");
  });

  it("keeps expected text and whitespace literal", () => {
    const condition: ActionExpectation = {
      target: "#price",
      field: "text",
      equals: "\n  $12 USD\n",
    };
    const original = structuredClone(condition);
    validateExpectations([condition]);
    expect(condition).toEqual(original);
  });
});
