//! Non-tool protocol payloads (`system.handshake`, `system.ping`, `system.status`).

use std::cmp::Ordering;

use schemars::JsonSchema;
use semver::Version;
use serde::{Deserialize, Serialize};

/// Outcome of comparing peer + local **protocol** versions during the
/// `system.handshake` exchange (design §10, M10.4).
///
/// ```text
///  protocol unparseable or major differs              → Reject
///  peer_protocol < our_min_compatible_protocol         → Reject
///  our_protocol  < peer_min_compatible_protocol      → Reject (skipped when peer omits floor)
///  peer_protocol != our_protocol (same major)        → Skew  (warn but allow)
///  otherwise                                         → Ok
/// ```
///
/// Application semvers (`HandshakeParams::version`, etc.) are **not**
/// part of this decision — CLI and extension ship on independent
/// version lines. Legacy `min_compatible_peer` is optional and ignored
/// here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandshakeCompat {
    /// Protocol strings match exactly; no UX surface needs to flag skew.
    Ok,
    /// Same protocol major and both protocol floors satisfied, but the
    /// full `protocol_version` strings differ (minor drift). Connection
    /// is accepted; surfaces render "warn but allow".
    Skew,
    /// Connection must be refused. `reason` is a short
    /// human-readable explanation suitable for the WS error frame.
    Reject { reason: String },
}

/// Evaluate handshake compatibility using **protocol_version** only.
///
/// `peer_min_compatible_protocol = None` when the peer is a legacy build
/// that predates the field — the "local below peer protocol floor" branch
/// is skipped in that case.
pub fn evaluate_handshake_compat(
    peer_protocol_version: &str,
    peer_min_compatible_protocol: Option<&str>,
    our_protocol_version: &str,
    our_min_compatible_protocol: &str,
) -> HandshakeCompat {
    let peer_major = parse_major(peer_protocol_version);
    let our_major = parse_major(our_protocol_version);
    if peer_major.is_none() || our_major.is_none() || peer_major != our_major {
        return HandshakeCompat::Reject {
            reason: format!(
                "protocol major mismatch (peer={peer_protocol_version}, local={our_protocol_version})"
            ),
        };
    }
    match compare_protocol(peer_protocol_version, our_min_compatible_protocol) {
        Some(Ordering::Less) => {
            return HandshakeCompat::Reject {
                reason: format!(
                    "peer protocol {peer_protocol_version} is below local min_compatible_protocol {our_min_compatible_protocol}"
                ),
            };
        }
        None => {
            return HandshakeCompat::Reject {
                reason: format!("peer protocol version unparseable: {peer_protocol_version}"),
            };
        }
        _ => {}
    }
    if let Some(peer_floor) = peer_min_compatible_protocol {
        match compare_protocol(our_protocol_version, peer_floor) {
            Some(Ordering::Less) => {
                return HandshakeCompat::Reject {
                    reason: format!(
                        "local protocol {our_protocol_version} is below peer min_compatible_protocol {peer_floor}"
                    ),
                };
            }
            None => {
                if parse_protocol_parts(our_protocol_version).is_none() {
                    return HandshakeCompat::Reject {
                        reason: format!(
                            "local protocol version unparseable: {our_protocol_version}"
                        ),
                    };
                }
                return HandshakeCompat::Reject {
                    reason: format!("peer min_compatible_protocol unparseable: {peer_floor}"),
                };
            }
            _ => {}
        }
    }
    if peer_protocol_version != our_protocol_version {
        return HandshakeCompat::Skew;
    }
    HandshakeCompat::Ok
}

/// Parsed `(major, minor)` pair for a wire `protocol_version` string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ProtocolParts {
    major: u64,
    minor: u64,
}

/// Compare two protocol-version strings lexicographically on
/// `(major, minor)`. Returns `None` when either side is unparseable.
pub fn compare_protocol(a: &str, b: &str) -> Option<Ordering> {
    let pa = parse_protocol_parts(a)?;
    let pb = parse_protocol_parts(b)?;
    Some(pa.major.cmp(&pb.major).then(pa.minor.cmp(&pb.minor)))
}

fn parse_protocol_parts(value: &str) -> Option<ProtocolParts> {
    let major = parse_major(value)?;
    let rest = value.split('.').nth(1);
    let minor = match rest {
        None | Some("") => 0,
        Some(seg) => {
            if seg.is_empty() || !seg.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let n: u64 = seg.parse().ok()?;
            if n > MAX_PROTOCOL_MAJOR {
                return None;
            }
            n
        }
    };
    Some(ProtocolParts { major, minor })
}

/// Upper bound the daemon will accept for the protocol-major field.
///
/// Matches JavaScript's `Number.MAX_SAFE_INTEGER` (`2^53 - 1 =
/// 9_007_199_254_740_991`) so the daemon ↔ extension parsers reject
/// the *same* set of inputs (review round 5 I1). Without this cap a
/// peer advertising e.g. `"18446744073709551615"` (u64::MAX) is
/// accepted here as `Some(u64::MAX)` but rejected by the TS side's
/// `!Number.isSafeInteger(...)` guard, violating "daemon accepts ⇒
/// extension accepts". The TS side intentionally caps at MAX_SAFE_INTEGER
/// to avoid silently rounding through `Number()`; pushing the daemon
/// down to that same ceiling is far cheaper than teaching the extension
/// to compare arbitrary-precision integers (which would force a
/// rewrite of `compareSemver` and friends). In practice
/// `protocol_version` only ever carries small values like `0` / `1`
/// / `2`, so a cap at `2^53 - 1` has zero impact on real traffic.
const MAX_PROTOCOL_MAJOR: u64 = (1u64 << 53) - 1;

/// Extract the leading numeric major component from a protocol-version
/// string such as `"1.0"` or `"1.0.0"`.
///
/// We deliberately do NOT use the bare `u64::from_str` accept set here:
/// `u64::from_str("+1")` returns `Ok(1)` because the std-lib parser is
/// happy to peel off a leading `+`. For a *wire* field that's the wrong
/// trade-off — the TypeScript extension's `parseProtocolMajor`
/// (`apps/extension/src/lib/semver.ts`) is built around `/^\d+$/` and
/// rejects any non-digit prefix. To keep "both peers reach the same
/// verdict" as a hard contract (review round 4 I1), the Rust side has
/// to be equally strict: take the segment before the first `.`, then
/// require it to be a non-empty run of ASCII digits before delegating
/// the actual parse. Without this guard a peer advertising `"+1.0"`
/// would be accepted by the daemon and rejected by the extension —
/// the same asymmetry round 3 fought on the app-version axis.
///
/// Round 5 I1 closes the last remaining accept-set gap on the upper
/// bound: after the digit guard passes and `head.parse::<u64>()`
/// succeeds, we also refuse values strictly above
/// [`MAX_PROTOCOL_MAJOR`] (= `Number.MAX_SAFE_INTEGER`). This
/// matches the TS side's `!Number.isSafeInteger(n)` reject so the
/// `MAX_SAFE_INTEGER < n <= u64::MAX` band (which `u64::from_str`
/// would otherwise happily accept) is rejected on both peers.
fn parse_major(value: &str) -> Option<u64> {
    let head = value.split('.').next()?;
    if head.is_empty() || !head.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u64 = head.parse().ok()?;
    if n > MAX_PROTOCOL_MAJOR {
        return None;
    }
    Some(n)
}

#[cfg(test)]
mod parse_major_tests {
    //! Round 4 I1: lock the *exact* accept set of `parse_major` so the
    //! daemon's verdict on the protocol-major field is bit-for-bit
    //! identical to the extension's `parseProtocolMajor` (see
    //! `apps/extension/src/lib/__tests__/semver.test.ts`). Any input
    //! the daemon accepts here must be accepted by the extension; any
    //! input the daemon rejects must round-trip to `null` over there.
    //! These cases mirror the extension test names so a future
    //! contributor who edits one side will see the matching coverage
    //! on the other.
    use super::parse_major;

    #[test]
    fn rejects_explicit_plus_sign() {
        // `u64::from_str("+1") = Ok(1)` in std; we MUST refuse so the
        // daemon's verdict matches the extension's `/^\d+$/` reject.
        assert_eq!(parse_major("+1"), None);
        assert_eq!(parse_major("+1.0"), None);
    }

    #[test]
    fn rejects_explicit_minus_sign() {
        // `u64::from_str("-1")` already fails in std (u64 is unsigned),
        // but we still pin the behaviour through the new strict path
        // so it can't accidentally drift if the function is refactored.
        assert_eq!(parse_major("-1"), None);
        assert_eq!(parse_major("-1.0"), None);
    }

    #[test]
    fn rejects_leading_whitespace() {
        assert_eq!(parse_major(" 1"), None);
        assert_eq!(parse_major(" 1.0"), None);
        assert_eq!(parse_major("\t1.0"), None);
    }

    #[test]
    fn rejects_empty_input() {
        assert_eq!(parse_major(""), None);
    }

    #[test]
    fn rejects_empty_leading_segment() {
        // `split('.').next()` returns `Some("")` for `".1"`, which our
        // emptiness guard must catch.
        assert_eq!(parse_major(".1"), None);
    }

    #[test]
    fn rejects_trailing_non_digit_characters() {
        // Pre-fix `u64::from_str("1x")` already fails, but pin both
        // shapes so the strict guard is locked.
        assert_eq!(parse_major("1x"), None);
    }

    #[test]
    fn rejects_scientific_notation() {
        assert_eq!(parse_major("1e3"), None);
    }

    #[test]
    fn rejects_non_numeric_leading_segment() {
        assert_eq!(parse_major("x.0"), None);
    }

    #[test]
    fn accepts_leading_zeros() {
        // `u64::from_str("01")` already accepts leading zeros; the TS
        // side does the same (`/^\d+$/.test("01")` && `Number("01") =
        // 1`). Lock the behaviour so a future tightening doesn't
        // diverge silently.
        assert_eq!(parse_major("01"), Some(1));
        assert_eq!(parse_major("01.0"), Some(1));
    }

    #[test]
    fn accepts_single_segment() {
        assert_eq!(parse_major("1"), Some(1));
        assert_eq!(parse_major("123"), Some(123));
    }

    #[test]
    fn accepts_canonical_two_segment() {
        assert_eq!(parse_major("1.0"), Some(1));
    }

    #[test]
    fn accepts_canonical_three_segment() {
        assert_eq!(parse_major("1.0.0"), Some(1));
    }

    #[test]
    fn ignores_trailing_segments() {
        // Confirms the `split('.').next()` semantics: anything past
        // the first `.` is irrelevant, including shapes the minor
        // segment alone could not parse.
        assert_eq!(parse_major("1."), Some(1));
        assert_eq!(parse_major("1.x"), Some(1));
    }

    #[test]
    fn accepts_value_at_max_safe_integer() {
        // 2^53 - 1 = 9_007_199_254_740_991 is the upper bound both
        // peers agree on (review round 5 I1). It round-trips through
        // `Number()` losslessly on the TS side, so the daemon must
        // accept it here too.
        assert_eq!(parse_major("9007199254740991"), Some(9_007_199_254_740_991));
    }

    #[test]
    fn rejects_value_above_max_safe_integer() {
        // Round 5 I1: previously the daemon accepted any `u64::from_str`
        // value all the way up to `u64::MAX`, which the TS side's
        // `!Number.isSafeInteger` guard would reject. Cap at
        // `Number.MAX_SAFE_INTEGER` to keep parser verdicts symmetric.
        // - MAX_SAFE_INTEGER + 1 (2^53 = 9_007_199_254_740_992):
        assert_eq!(parse_major("9007199254740992"), None);
        // - u64::MAX itself (a valid u64 but well above the cap):
        assert_eq!(parse_major("18446744073709551615"), None);
    }

    #[test]
    fn rejects_value_above_u64_max() {
        // u64::MAX + 1 (21 digits). The strict ASCII-digit guard
        // lets it through to `head.parse()` which errors with overflow —
        // we get `None`, never a wraparound.
        assert_eq!(parse_major("18446744073709551616"), None);
        // And a much larger value (23 digits) still fails cleanly.
        assert_eq!(parse_major("99999999999999999999999"), None);
    }
}

#[cfg(test)]
mod compare_protocol_tests {
    use super::*;

    #[test]
    fn equal_protocols() {
        assert_eq!(compare_protocol("1.0", "1.0"), Some(Ordering::Equal));
    }

    #[test]
    fn minor_ordering() {
        assert_eq!(compare_protocol("1.1", "1.0"), Some(Ordering::Greater));
        assert_eq!(compare_protocol("1.0", "1.1"), Some(Ordering::Less));
    }

    #[test]
    fn major_only_treated_as_zero_minor() {
        assert_eq!(compare_protocol("1", "1.0"), Some(Ordering::Equal));
    }

    #[test]
    fn unparseable_returns_none() {
        assert_eq!(compare_protocol("oops", "1.0"), None);
        assert_eq!(compare_protocol("1.0", "1.x"), None);
    }
}

#[cfg(test)]
mod compat_tests {
    use super::*;

    #[test]
    fn ok_when_protocol_strings_match() {
        let outcome = evaluate_handshake_compat("1.0", Some("1.0"), "1.0", "1.0");
        assert_eq!(outcome, HandshakeCompat::Ok);
    }

    #[test]
    fn skew_when_same_major_different_minor() {
        let outcome = evaluate_handshake_compat("1.1", Some("1.0"), "1.0", "1.0");
        assert_eq!(outcome, HandshakeCompat::Skew);
    }

    #[test]
    fn skew_when_peer_minor_newer() {
        let outcome = evaluate_handshake_compat("1.0", Some("1.0"), "1.1", "1.0");
        assert_eq!(outcome, HandshakeCompat::Skew);
    }

    #[test]
    fn reject_when_peer_below_protocol_floor() {
        let outcome = evaluate_handshake_compat("0.9", Some("0.5"), "1.0", "1.0");
        assert!(matches!(outcome, HandshakeCompat::Reject { .. }));
    }

    #[test]
    fn reject_when_self_below_peer_protocol_floor() {
        let outcome = evaluate_handshake_compat("1.0", Some("1.5"), "1.0", "1.0");
        match outcome {
            HandshakeCompat::Reject { reason } => assert!(
                reason.contains("local protocol") && reason.contains("min_compatible_protocol"),
                "reason: {reason}"
            ),
            other => panic!("expected reject, got {other:?}"),
        }
    }

    #[test]
    fn reject_when_peer_protocol_floor_unparseable_reports_peer_floor() {
        let outcome = evaluate_handshake_compat("1.0", Some("not-a-protocol"), "1.0", "1.0");
        match outcome {
            HandshakeCompat::Reject { reason } => assert!(
                reason.contains("peer min_compatible_protocol")
                    && reason.contains("not-a-protocol"),
                "reason: {reason}"
            ),
            other => panic!("expected reject, got {other:?}"),
        }
    }

    #[test]
    fn ok_when_peer_protocol_floor_absent() {
        let outcome = evaluate_handshake_compat("1.0", None, "1.0", "1.0");
        assert_eq!(outcome, HandshakeCompat::Ok);
    }

    #[test]
    fn reject_when_protocol_major_differs() {
        let outcome = evaluate_handshake_compat("2.0", Some("1.0"), "1.0", "1.0");
        assert!(matches!(outcome, HandshakeCompat::Reject { .. }));
    }

    #[test]
    fn reject_when_protocol_string_unparseable() {
        let outcome = evaluate_handshake_compat("oops", Some("1.0"), "1.0", "1.0");
        assert!(matches!(outcome, HandshakeCompat::Reject { .. }));
    }

    #[test]
    fn app_version_drift_does_not_affect_verdict() {
        // CLI 0.1.0 ↔ extension 9.9.9 with matching protocol → Ok
        let outcome = evaluate_handshake_compat("1.0", Some("1.0"), "1.0", "1.0");
        assert_eq!(outcome, HandshakeCompat::Ok);
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BrowserPeerInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HandshakeParams {
    pub client: String,
    #[schemars(with = "String")]
    pub version: Version,
    /// Logical protocol revision (for example `"1.0"`), independent of SemVer app releases.
    pub protocol_version: String,
    pub instance_id: String,
    pub browser: BrowserPeerInfo,
    pub label: String,
    /// **Deprecated** — legacy app-semver floor kept for wire compat with
    /// pre-protocol peers. New code sends `"0.0.0"` and ignores on read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Option<String>")]
    pub min_compatible_peer: Option<Version>,
    /// Lowest peer **protocol** version this side accepts (e.g. `"1.0"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_compatible_protocol: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HandshakeResult {
    pub server: String,
    #[schemars(with = "String")]
    pub version: Version,
    pub protocol_version: String,
    /// **Deprecated** — legacy app-semver floor. New peers should use
    /// `min_compatible_protocol`; this field is optional and ignored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Option<String>")]
    pub min_compatible_peer: Option<Version>,
    /// Lowest peer protocol version this daemon accepts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_compatible_protocol: Option<String>,
}

#[cfg(test)]
mod handshake_payload_tests {
    use super::*;

    #[test]
    fn handshake_result_deserializes_without_legacy_min_compatible_peer() {
        let result: HandshakeResult = serde_json::from_value(serde_json::json!({
            "server": "browser-skill-daemon",
            "version": "0.1.0",
            "protocol_version": "1.0",
            "min_compatible_protocol": "1.0"
        }))
        .expect("legacy app-semver floor is optional in new handshake results");

        assert_eq!(result.min_compatible_peer, None);
        assert_eq!(result.min_compatible_protocol.as_deref(), Some("1.0"));
    }
}

/// `system.ping` request payload. Empty (the response carries `pong`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PingParams {}

/// `system.ping` response payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct PingResult {
    pub pong: bool,
}

/// Snapshot of a single connected extension (extension client view).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct BrowserStatusEntry {
    /// Stable id assigned by the extension; matches `HandshakeParams::instance_id`.
    pub instance_id: String,
    pub browser_name: String,
    pub browser_version: String,
    pub extension_version: String,
    pub label: String,
    pub session_count: u32,
    /// Unix epoch milliseconds at which the extension completed the
    /// daemon handshake. Stable across reconnects only via the
    /// best-effort registry generation; clients should treat this as a
    /// rough "online since" hint, not a strong identity.
    #[serde(default)]
    pub connected_at_ms: i64,
    /// `true` when the browser's `protocol_version` differs from the
    /// daemon's (same major, minor drift). Connection is still allowed.
    #[serde(default)]
    pub version_skew: bool,
    /// Protocol version the extension advertised at handshake.
    #[serde(default)]
    pub extension_protocol_version: String,
}

/// Snapshot of a single live session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SessionStatusEntry {
    pub session_id: String,
    pub browser_instance_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_window_id: Option<i64>,
    /// Unix epoch milliseconds.
    pub created_at_ms: i64,
}

/// `system.status` request payload. Empty.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct StatusParams {}

/// One entry per connected browser whose protocol version drifts from
/// the daemon's (same major). Surfaced in `system.status` for
/// `bsk status` / `bsk doctor` / popup "warn but allow" UX.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct VersionSkewEntry {
    pub instance_id: String,
    pub browser_name: String,
    pub label: String,
    /// Daemon app semver at snapshot time (informational).
    pub server_version: String,
    /// Extension app semver at snapshot time (informational).
    pub client_version: String,
    /// Daemon `protocol_version` at snapshot time.
    #[serde(default)]
    pub server_protocol_version: String,
    /// Extension `protocol_version` from handshake.
    #[serde(default)]
    pub client_protocol_version: String,
}

/// `system.status` reply: daemon meta + connected browsers + live sessions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct StatusResult {
    /// Semver of the daemon binary (`env!("CARGO_PKG_VERSION")`).
    pub daemon_version: String,
    /// Logical protocol revision (e.g. `"1.0"`).
    pub protocol_version: String,
    /// Daemon process id.
    pub pid: u32,
    /// Daemon uptime in whole seconds.
    pub uptime_secs: u64,
    /// WS port the daemon listens on for extension clients.
    pub ws_port: u16,
    /// Absolute path of the IPC socket / named pipe handle.
    pub sock_path: String,
    /// Snapshot of connected extension clients.
    pub browsers: Vec<BrowserStatusEntry>,
    /// Snapshot of live sessions.
    pub sessions: Vec<SessionStatusEntry>,
    /// Subset of `browsers` whose `protocol_version` differs from the
    /// daemon's (minor drift, same major). Entries mirror
    /// `BrowserStatusEntry.version_skew`.
    #[serde(default)]
    pub version_skew_browsers: Vec<VersionSkewEntry>,
}

#[cfg(test)]
mod status_compat_tests {
    use super::*;

    #[test]
    fn status_result_deserializes_legacy_version_skew_entries_without_protocol_fields() {
        let status: StatusResult = serde_json::from_value(serde_json::json!({
            "daemon_version": "0.1.0",
            "protocol_version": "1.0",
            "pid": 42,
            "uptime_secs": 7,
            "ws_port": 52700,
            "sock_path": "/tmp/bsk.sock",
            "browsers": [],
            "sessions": [],
            "version_skew_browsers": [{
                "instance_id": "legacy-browser",
                "browser_name": "chrome",
                "label": "Legacy",
                "server_version": "0.1.0",
                "client_version": "0.0.9"
            }]
        }))
        .expect("new CLI must tolerate old daemon skew payloads");

        let skew = status
            .version_skew_browsers
            .first()
            .expect("legacy skew entry should deserialize");
        assert_eq!(skew.server_protocol_version, "");
        assert_eq!(skew.client_protocol_version, "");
    }
}
