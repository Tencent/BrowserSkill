import { afterEach, describe, expect, it, vi } from "vitest";
import { controllerColor, isControllerInfo } from "../controller-info";
import { createRandomUuid } from "../random-uuid";
import { compareProtocol, parseProtocolMajor } from "../semver";

describe("createRandomUuid", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to getRandomValues and sets UUID v4 bits", () => {
    const bytes = new Uint8Array(16).fill(0xff);
    const getRandomValues = vi.fn((target: Uint8Array) => {
      target.set(bytes);
      return target;
    });
    vi.stubGlobal("crypto", { getRandomValues });

    const uuid = createRandomUuid();

    expect(uuid).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(getRandomValues).toHaveBeenCalledOnce();
  });
});

describe("compareProtocol", () => {
  it("orders minor versions", () => {
    expect(compareProtocol("1.1", "1.0")).toBeGreaterThan(0);
    expect(compareProtocol("1.0", "1.1")).toBeLessThan(0);
  });

  it("treats major-only as zero minor", () => {
    expect(compareProtocol("1", "1.0")).toBe(0);
  });

  it("returns null for unparseable input", () => {
    expect(compareProtocol("oops", "1.0")).toBeNull();
    expect(compareProtocol("1.0", "1.x")).toBeNull();
  });
});

describe("parseProtocolMajor (review round 3 I2: match Rust parse_major)", () => {
  it("rejects trailing non-digit characters (e.g. '1x')", () => {
    expect(parseProtocolMajor("1x")).toBeNull();
  });

  it("rejects scientific notation (e.g. '1e3')", () => {
    expect(parseProtocolMajor("1e3")).toBeNull();
  });

  it("rejects empty strings", () => {
    expect(parseProtocolMajor("")).toBeNull();
  });

  it("rejects non-numeric leading field (e.g. 'x.0')", () => {
    expect(parseProtocolMajor("x.0")).toBeNull();
  });

  it("rejects negative numbers (e.g. '-1.0')", () => {
    expect(parseProtocolMajor("-1.0")).toBeNull();
  });

  it("rejects leading whitespace (e.g. ' 1.0')", () => {
    expect(parseProtocolMajor(" 1.0")).toBeNull();
  });

  it("rejects an explicit + sign (e.g. '+1.0')", () => {
    expect(parseProtocolMajor("+1.0")).toBeNull();
  });

  it("rejects values past Number.MAX_SAFE_INTEGER conservatively", () => {
    const tooBig = "99999999999999999999";
    expect(parseProtocolMajor(tooBig)).toBeNull();
    expect(parseProtocolMajor(`${tooBig}.0`)).toBeNull();
  });

  it("rejects MAX_SAFE_INTEGER + 1 ('9007199254740992')", () => {
    expect(parseProtocolMajor("9007199254740992")).toBeNull();
  });

  it("rejects u64::MAX ('18446744073709551615')", () => {
    expect(parseProtocolMajor("18446744073709551615")).toBeNull();
  });

  it("accepts leading zeros (e.g. '01.0' -> 1)", () => {
    expect(parseProtocolMajor("01.0")).toBe(1);
  });

  it("ignores everything past the first dot ('1.x' -> 1)", () => {
    expect(parseProtocolMajor("1.x")).toBe(1);
  });

  it("returns the parsed major for the canonical wire format ('1.0.0' -> 1)", () => {
    expect(parseProtocolMajor("1.0.0")).toBe(1);
  });

  it("returns the parsed major for a single-segment input ('123' -> 123)", () => {
    expect(parseProtocolMajor("123")).toBe(123);
  });

  it("accepts exactly Number.MAX_SAFE_INTEGER as the upper bound", () => {
    expect(parseProtocolMajor(`${Number.MAX_SAFE_INTEGER}`)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

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
