import { describe, expect, it } from "vitest";
import { compareProtocol, parseProtocolMajor } from "../semver";

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
  // The daemon uses `value.split('.').next().and_then(|x|
  // x.parse::<u64>().ok())` (see `bsk-protocol::system::parse_major`).
  // The extension's parser MUST behave identically — any input the
  // daemon accepts has to round-trip to the same major here, and any
  // input the daemon rejects must return `null`. Pre-fix the regex
  // `/^(\d+)/` happily peeled off `1` from "1x" / "1e3" / " 1.0",
  // which would let `computeConnectedState` pass the protocol-major
  // gate on inputs that `evaluate_handshake_compat` would reject —
  // the same asymmetry round 3 I1 fought on the app-version axis.

  it("rejects trailing non-digit characters (e.g. '1x')", () => {
    // Rust: 'split(.) -> "1x"' -> u64::parse fails -> None
    expect(parseProtocolMajor("1x")).toBeNull();
  });

  it("rejects scientific notation (e.g. '1e3')", () => {
    // Rust u64 has no concept of "1e3"; ours must not silently
    // accept it either.
    expect(parseProtocolMajor("1e3")).toBeNull();
  });

  it("rejects empty strings", () => {
    expect(parseProtocolMajor("")).toBeNull();
  });

  it("rejects non-numeric leading field (e.g. 'x.0')", () => {
    expect(parseProtocolMajor("x.0")).toBeNull();
  });

  it("rejects negative numbers (e.g. '-1.0')", () => {
    // The daemon's strict digit parser rejects '-1' (the sign is not
    // an ASCII digit) before delegating to `u64::from_str`; /^\d+$/
    // rejects it here too.
    expect(parseProtocolMajor("-1.0")).toBeNull();
  });

  it("rejects leading whitespace (e.g. ' 1.0')", () => {
    // The daemon's strict digit parser rejects leading whitespace
    // (space is not an ASCII digit); we must too.
    expect(parseProtocolMajor(" 1.0")).toBeNull();
  });

  it("rejects an explicit + sign (e.g. '+1.0')", () => {
    // `u64::from_str("+1")` actually returns `Ok(1)` — the std-lib
    // parser peels off a leading `+`. The daemon's strict digit
    // parser (see `parse_major` in `crates/bsk-protocol/src/system.rs`)
    // is what rejects this input, by requiring `/^\d+$/` on the head
    // segment before delegating to `u64::from_str`. We mirror that
    // reject here so the two parsers reach the same verdict.
    expect(parseProtocolMajor("+1.0")).toBeNull();
  });

  it("rejects values past Number.MAX_SAFE_INTEGER conservatively", () => {
    // Round 5 I1: the daemon now caps `parse_major` at
    // `Number.MAX_SAFE_INTEGER` for parser symmetry, so both peers
    // reject the entire `MAX_SAFE_INTEGER < n <= u64::MAX` band
    // (previously the daemon accepted those values while the TS
    // side's `!Number.isSafeInteger` guard rejected them).
    const tooBig = "99999999999999999999"; // 20 digits, > 2^64 too
    expect(parseProtocolMajor(tooBig)).toBeNull();
    expect(parseProtocolMajor(`${tooBig}.0`)).toBeNull();
  });

  it("rejects MAX_SAFE_INTEGER + 1 ('9007199254740992')", () => {
    // First value above the cap. Matches the daemon's
    // `rejects_value_above_max_safe_integer` test on the Rust side.
    expect(parseProtocolMajor("9007199254740992")).toBeNull();
  });

  it("rejects u64::MAX ('18446744073709551615')", () => {
    // A valid u64 literal but well above `Number.MAX_SAFE_INTEGER`.
    // Pre round 5 the daemon accepted this as `Some(u64::MAX)` while
    // the TS side rejected it via `!Number.isSafeInteger` — exactly
    // the asymmetry round 5 I1 closes.
    expect(parseProtocolMajor("18446744073709551615")).toBeNull();
  });

  it("accepts leading zeros (e.g. '01.0' -> 1)", () => {
    // The daemon's `u64::from_str` accepts leading zeros after the
    // digit guard passes, so we must too.
    expect(parseProtocolMajor("01.0")).toBe(1);
  });

  it("ignores everything past the first dot ('1.x' -> 1)", () => {
    // The daemon takes only `split('.').next()`, so the minor
    // segment's shape never affects the major.
    expect(parseProtocolMajor("1.x")).toBe(1);
  });

  it("returns the parsed major for the canonical wire format ('1.0.0' -> 1)", () => {
    expect(parseProtocolMajor("1.0.0")).toBe(1);
  });

  it("returns the parsed major for a single-segment input ('123' -> 123)", () => {
    expect(parseProtocolMajor("123")).toBe(123);
  });

  it("accepts exactly Number.MAX_SAFE_INTEGER as the upper bound", () => {
    // Boundary case: at MAX_SAFE_INTEGER the value still round-trips
    // through `Number()` without precision loss, so we accept it.
    // The daemon's matching test is `accepts_value_at_max_safe_integer`.
    expect(parseProtocolMajor(`${Number.MAX_SAFE_INTEGER}`)).toBe(Number.MAX_SAFE_INTEGER);
  });
});
