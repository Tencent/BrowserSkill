// Protocol-version parsing and comparison used by M10.4 version-skew detection.
//
// Wire format is `MAJOR.MINOR` (see `bsk-protocol::system` in Rust), not full
// app semver — we deliberately avoid a third-party semver package.

/**
 * Compare two protocol-version strings on `(major, minor)`. Returns
 * `null` when either side is unparseable — mirrors
 * `bsk_protocol::system::compare_protocol`.
 */
export function compareProtocol(a: string, b: string): number | null {
  const pa = parseProtocolParts(a);
  const pb = parseProtocolParts(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major - pb.major;
  return pa.minor - pb.minor;
}

function parseProtocolParts(value: string): { major: number; minor: number } | null {
  const major = parseProtocolMajor(value);
  if (major === null) return null;
  const rest = value.split(".")[1];
  if (rest === undefined || rest === "") {
    return { major, minor: 0 };
  }
  if (!/^\d+$/.test(rest)) return null;
  const minor = Number(rest);
  if (!Number.isSafeInteger(minor) || minor < 0) return null;
  return { major, minor };
}

/**
 * Extract the leading numeric major component from a protocol-version
 * string. The wire format is `MAJOR.MINOR` rather than full semver
 * (see `bsk-protocol::system::parse_major` in
 * `crates/bsk-protocol/src/system.rs`). Returns `null` when the leading
 * field is missing or non-numeric — callers treat that as a hard
 * reject, mirroring the daemon's `evaluate_handshake_compat`.
 *
 * Behaviour matches the daemon's `parse_major` exactly (review round 3
 * I2, tightened in round 4 I1, capped at `MAX_SAFE_INTEGER` on the
 * daemon side in round 5 I1):
 *
 *   * Take the substring before the first '.'.
 *   * The substring must be a non-empty run of ASCII digits (`/^\d+$/`).
 *     Anything else — signs, whitespace, scientific notation, decimal
 *     points, suffixes such as `1x` / `1e3` — fails. Note that
 *     `u64::from_str("+1")` would otherwise return `Ok(1)` (the
 *     std-lib parser peels off a leading `+`); the daemon's
 *     `parse_major` enforces the same ASCII-digit guard *before*
 *     delegating to `u64::from_str` so an input like `"+1.0"` is
 *     rejected by both sides.
 *   * Convert via `Number`. Reject values outside the JS safe-integer
 *     range conservatively — parsing a u64 that big and then comparing
 *     equality of "major-only" protocols here would lose precision.
 *     The daemon caps its own `parse_major` at the same value
 *     (`MAX_PROTOCOL_MAJOR = 2^53 - 1`) so the entire
 *     `MAX_SAFE_INTEGER < n <= u64::MAX` band is rejected on both
 *     peers — i.e. "daemon accepts ⇒ extension accepts" and
 *     "daemon rejects ⇒ extension rejects" both hold byte-for-byte.
 */
export function parseProtocolMajor(value: string): number | null {
  const head = value.split(".")[0];
  if (!/^\d+$/.test(head)) return null;
  const n = Number(head);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}
