//! Shared client orchestration kernel across CLI (`lifecycle`, `step`, `plan`,
//! `interaction`, `business_rpc`) and MCP (`mcp/tools`).
//!
//! Centralises invariants that previously drifted across parallel client
//! orchestrators:
//! - Canvas screenshot point-click vs DOM target validation (`validate_click_params`)
//! - Action, `open`, and `sync` timeout bounds
//! - Explicit `--session` + `--browser` conflict checks (`ScopeBrowserConflict`)
//! - Cached VOM observation hydration from `ScopeResultMeta`
//! - Graceful 2-second cancellation settlement (`CANCEL_RESPONSE_GRACE`)

use std::future::Future;
use std::time::Duration;

use bsk_protocol::system::{BrowserStatusEntry, SessionStatusEntry};
use bsk_protocol::tools::ClickParams;
use bsk_protocol::{ErrorCode, RpcError, RpcErrorReason};
use serde_json::{Value, json};
use tokio::time::{Instant, timeout, timeout_at};

use crate::ipc_client::ScopeResultMeta;

/// Total budget after cancellation is observed: connecting, sending `cancel`,
/// retrying before registration, and waiting for the original RPC to settle
/// with an authoritative `effect_state` or `cancelled_before_dispatch` reason.
pub const CANCEL_RESPONSE_GRACE: Duration = Duration::from_secs(2);

/// Maximum `timeout_ms` accepted for bounded DOM action steps (`1..=30_000`).
pub const MAX_ACTION_TIMEOUT_MS: u64 = 30_000;

/// Maximum `timeout_ms` accepted for `open` and wait-conditioned `sync` (`1..=120_000`).
pub const MAX_OPEN_OR_WAIT_SYNC_TIMEOUT_MS: u64 = 120_000;

/// Maximum `timeout_ms` accepted for `sync` / `cooperate wait` without VOM wait conditions.
pub const MAX_PLAIN_SYNC_TIMEOUT_MS: u64 = 25_000;

/// Await an in-flight RPC operation for up to `grace` after cancellation has
/// been triggered so the caller recovers the daemon's real `Ok` receipt,
/// `cancelled_before_dispatch`, or `effect_state` instead of dropping at 0ms.
pub async fn await_cancelled_operation<T, F>(operation: F, grace: Duration) -> Option<T>
where
    F: Future<Output = T>,
{
    timeout(grace, operation).await.ok()
}

/// Same as [`await_cancelled_operation`] against a shared [`Instant`] deadline.
pub async fn await_cancelled_operation_until<T, F>(deadline: Instant, operation: F) -> Option<T>
where
    F: Future<Output = T>,
{
    timeout_at(deadline, operation).await.ok()
}

/// Validate [`ClickParams`] consistently across `bsk click`, `bsk step click`,
/// `bsk plan`, and MCP `bsk_interact(click)`.
///
/// Mirrors the extension's `visual-capture.ts` contract so invalid Canvas point
/// click combinations or missing/conflicting DOM targets fail closed locally
/// before spawning or contacting the daemon.
pub fn validate_click_params(params: &ClickParams) -> Result<(), String> {
    let has_visual_field =
        params.capture_id.is_some() || params.image_x.is_some() || params.image_y.is_some();

    if has_visual_field {
        if params.selector.is_some() {
            return Err("visual point click requires ref, not selector".into());
        }
        match params.ref_.as_deref() {
            None => return Err("visual point click requires a non-empty ref".into()),
            Some(r) if r.trim().is_empty() => return Err("empty ref".into()),
            Some(_) => {}
        }
        let Some(capture_id) = params.capture_id.as_deref() else {
            return Err("visual point click requires capture_id, image_x, and image_y".into());
        };
        if capture_id.trim().is_empty() {
            return Err("visual point click requires a non-empty capture_id".into());
        }
        let (Some(x), Some(y)) = (params.image_x, params.image_y) else {
            return Err("visual point click requires capture_id, image_x, and image_y".into());
        };
        if !x.is_finite() || x < 0.0 || !y.is_finite() || y < 0.0 {
            return Err(
                "visual point click image_x and image_y must be non-negative finite numbers".into(),
            );
        }
        let count = params.click_count.unwrap_or(1);
        if !(1..=2).contains(&count) {
            return Err("visual point click click_count must be 1 or 2".into());
        }
        return Ok(());
    }

    if let Some(r) = params.ref_.as_deref()
        && r.trim().is_empty()
    {
        return Err("empty ref".into());
    }
    if let Some(s) = params.selector.as_deref()
        && s.trim().is_empty()
    {
        return Err("empty selector".into());
    }
    if params.ref_.is_some() == params.selector.is_some() {
        return Err("pass exactly one ref or selector for each required target".into());
    }
    if let Some(count) = params.click_count
        && count == 0
    {
        return Err("click_count must be at least 1".into());
    }
    Ok(())
}

/// Validate a bounded DOM action `timeout_ms` (`1..=30_000`).
pub fn validate_action_timeout_ms(timeout_ms: u64) -> Result<u32, String> {
    if !(1..=MAX_ACTION_TIMEOUT_MS).contains(&timeout_ms) {
        return Err("action timeout_ms must be 1..=30000".into());
    }
    Ok(timeout_ms as u32)
}

/// Validate a positive `u32` `timeout_ms` (`1..=u32::MAX`) for unbounded-duration
/// single tools (`evaluate`, `upload`, `download`).
pub fn validate_positive_timeout_ms(timeout_ms: u64) -> Result<u32, String> {
    if timeout_ms == 0 {
        return Err("timeout_ms must be greater than zero".into());
    }
    u32::try_from(timeout_ms).map_err(|_| "timeout_ms too large for u32 milliseconds".into())
}

/// Validate `open` readiness / navigation `timeout_ms` (`1..=120_000`).
pub fn validate_open_timeout_ms(timeout_ms: u64) -> Result<u32, String> {
    if !(1..=MAX_OPEN_OR_WAIT_SYNC_TIMEOUT_MS).contains(&timeout_ms) {
        return Err("timeout_ms must be 1..=120000".into());
    }
    Ok(timeout_ms as u32)
}

/// Validate `sync` `timeout_ms`:
/// - With `wait_for` or `wait_not`: `1..=120_000`
/// - Without wait conditions: `0..=25_000` when `allow_zero_without_wait` is true
///   (MCP `cooperate`), or `1..=25_000` on CLI `bsk sync`.
pub fn validate_sync_timeout_ms(
    timeout_ms: u64,
    has_wait_conditions: bool,
    allow_zero_without_wait: bool,
) -> Result<u32, String> {
    if has_wait_conditions {
        if !(1..=MAX_OPEN_OR_WAIT_SYNC_TIMEOUT_MS).contains(&timeout_ms) {
            return Err("timeout_ms must be 1..=120000 with wait_for/wait_not".into());
        }
    } else if allow_zero_without_wait {
        if timeout_ms > MAX_PLAIN_SYNC_TIMEOUT_MS {
            return Err("timeout_ms must be 0..=25000".into());
        }
    } else if !(1..=MAX_PLAIN_SYNC_TIMEOUT_MS).contains(&timeout_ms) {
        return Err("timeout_ms must be 1..=25000 without --wait-for/--wait-not".into());
    }
    Ok(timeout_ms as u32)
}

/// Resolve the `browser_instance_id` owning `session_id` from `session.list`.
pub fn find_session_bound_browser<'a>(
    sessions: &'a [SessionStatusEntry],
    session_id: &str,
) -> Result<&'a str, RpcError> {
    sessions
        .iter()
        .find(|s| s.session_id == session_id)
        .map(|s| s.browser_instance_id.as_str())
        .ok_or_else(|| RpcError {
            code: ErrorCode::NotFound,
            message: format!("session '{session_id}' does not exist"),
            data: None,
        })
}

/// Verify an explicit session's `bound_browser` matches `requested_browser`
/// (either by exact `instance_id` or by browser `label`), returning a
/// structured `ScopeBrowserConflict` [`RpcError`] on mismatch.
pub fn check_explicit_session_browser_conflict(
    session_id: &str,
    bound_browser: &str,
    requested_browser: &str,
    browsers: &[BrowserStatusEntry],
) -> Result<(), RpcError> {
    if bound_browser == requested_browser {
        return Ok(());
    }
    let matches_label = browsers
        .iter()
        .any(|b| b.instance_id == bound_browser && b.label == requested_browser);
    if !matches_label {
        return Err(RpcError {
            code: ErrorCode::InvalidParams,
            message: format!(
                "session '{session_id}' belongs to browser '{bound_browser}', which conflicts with --browser '{requested_browser}'"
            ),
            data: Some(json!({
                "reason": RpcErrorReason::ScopeBrowserConflict.as_str(),
                "session_id": session_id,
                "bound_browser": bound_browser,
                "requested_browser": requested_browser,
            })),
        });
    }
    Ok(())
}

/// Hydrate `/observation/*` fields from [`ScopeResultMeta`] when `cache_reusable`
/// confirms an exact `unchanged` or text-delta-patched predecessor.
pub fn hydrate_cached_observation(reply: &mut Value, scope_meta: Option<&ScopeResultMeta>) -> bool {
    let Some(meta) = scope_meta else {
        return false;
    };
    if reply.pointer("/observation/text").is_some() || !meta.cache_reusable {
        return false;
    }
    let Some(cached_vom) = meta.cached_vom.as_deref() else {
        return false;
    };

    if !reply.get("observation").is_some_and(Value::is_object) {
        reply["observation"] = json!({});
    }
    reply["observation"]["text"] = Value::String(cached_vom.to_string());
    reply["observation"]["truncated"] = Value::Bool(meta.cached_vom_truncated);
    if let Some(cursor) = meta.cached_vom_next_cursor.as_deref() {
        reply["observation"]["next_cursor"] = Value::String(cursor.to_string());
    }
    if reply.pointer("/observation/observation_id").is_none()
        && let Some(obs_id) = reply.get("observation_id").and_then(Value::as_str)
    {
        reply["observation"]["observation_id"] = Value::String(obs_id.to_string());
    }
    if reply.pointer("/observation/tab_id").is_none()
        && let Some(tid) = reply.get("tab_id").and_then(Value::as_i64).or(meta.tab_id)
    {
        reply["observation"]["tab_id"] = Value::from(tid);
    }
    if reply.pointer("/observation/url").is_none()
        && let Some(url) = reply
            .pointer("/state/url")
            .and_then(Value::as_str)
            .or(meta.cached_url.as_deref())
            .filter(|s| !s.is_empty())
    {
        reply["observation"]["url"] = Value::String(url.to_string());
    }
    if reply.pointer("/observation/title").is_none()
        && let Some(title) = reply
            .pointer("/state/title")
            .and_then(Value::as_str)
            .or(meta.cached_title.as_deref())
            .filter(|s| !s.is_empty())
    {
        reply["observation"]["title"] = Value::String(title.to_string());
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_click() -> ClickParams {
        ClickParams {
            capture_id: None,
            image_x: None,
            image_y: None,
            session_id: "s1".into(),
            ref_: Some("@e1".into()),
            selector: None,
            tab_id: None,
            button: None,
            click_count: None,
            modifiers: None,
            timeout_ms: None,
            context_id: None,
            observation_id: None,
            depends_on: None,
            expect: None,
        }
    }

    #[test]
    fn validate_click_params_enforces_visual_point_and_dom_target_invariants() {
        // Valid DOM clicks
        assert!(validate_click_params(&base_click()).is_ok());
        let mut dom_selector = base_click();
        dom_selector.ref_ = None;
        dom_selector.selector = Some("#submit".into());
        assert!(validate_click_params(&dom_selector).is_ok());

        // Valid visual point click (single and double click)
        let mut visual = base_click();
        visual.capture_id = Some("cap-123".into());
        visual.image_x = Some(0.0);
        visual.image_y = Some(142.5);
        assert!(validate_click_params(&visual).is_ok());
        visual.click_count = Some(2);
        assert!(validate_click_params(&visual).is_ok());

        // Invalid visual point click combinations
        let mut with_selector = visual.clone();
        with_selector.selector = Some("#canvas".into());
        assert!(validate_click_params(&with_selector).is_err());

        let mut selector_only = visual.clone();
        selector_only.ref_ = None;
        selector_only.selector = Some("#canvas".into());
        assert!(validate_click_params(&selector_only).is_err());

        let mut missing_ref = visual.clone();
        missing_ref.ref_ = None;
        assert!(validate_click_params(&missing_ref).is_err());

        let mut missing_y = visual.clone();
        missing_y.image_y = None;
        assert!(validate_click_params(&missing_y).is_err());

        let mut negative_x = visual.clone();
        negative_x.image_x = Some(-1.0);
        assert!(validate_click_params(&negative_x).is_err());

        let mut triple_click = visual.clone();
        triple_click.click_count = Some(3);
        assert!(validate_click_params(&triple_click).is_err());

        let mut empty_capture = visual;
        empty_capture.capture_id = Some("   ".into());
        assert!(validate_click_params(&empty_capture).is_err());
    }

    #[test]
    fn timeout_validators_enforce_shared_bounds() {
        assert_eq!(validate_action_timeout_ms(1).unwrap(), 1);
        assert_eq!(validate_action_timeout_ms(30_000).unwrap(), 30_000);
        assert!(validate_action_timeout_ms(0).is_err());
        assert!(validate_action_timeout_ms(30_001).is_err());

        assert_eq!(validate_open_timeout_ms(120_000).unwrap(), 120_000);
        assert!(validate_open_timeout_ms(0).is_err());
        assert!(validate_open_timeout_ms(120_001).is_err());

        assert_eq!(
            validate_sync_timeout_ms(60_000, true, false).unwrap(),
            60_000
        );
        assert!(validate_sync_timeout_ms(60_000, false, false).is_err());
        assert!(validate_sync_timeout_ms(60_000, false, true).is_err());
        assert_eq!(validate_sync_timeout_ms(0, false, true).unwrap(), 0);
        assert!(validate_sync_timeout_ms(0, false, false).is_err());
    }

    #[test]
    fn check_explicit_session_browser_conflict_emits_structured_reason() {
        let browsers = vec![BrowserStatusEntry {
            instance_id: "b-chrome".into(),
            browser_name: "Chrome".into(),
            browser_version: "136.0".into(),
            extension_version: "0.2.0".into(),
            label: "work-chrome".into(),
            session_count: 1,
            connected_at_ms: 1_700_000_000_000,
            version_skew: false,
            extension_protocol_version: "2.0".into(),
            unresponsive: false,
        }];
        assert!(
            check_explicit_session_browser_conflict("s1", "b-chrome", "b-chrome", &browsers)
                .is_ok()
        );
        assert!(
            check_explicit_session_browser_conflict("s1", "b-chrome", "work-chrome", &browsers)
                .is_ok()
        );
        let err =
            check_explicit_session_browser_conflict("s1", "b-chrome", "other-edge", &browsers)
                .unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidParams);
        let data = err.data.expect("structured conflict data");
        assert_eq!(
            data["reason"],
            RpcErrorReason::ScopeBrowserConflict.as_str()
        );
        assert_eq!(data["session_id"], "s1");
        assert_eq!(data["bound_browser"], "b-chrome");
        assert_eq!(data["requested_browser"], "other-edge");
    }

    #[test]
    fn hydrate_cached_observation_populates_vom_and_metadata() {
        let mut reply = json!({
            "kind": "unchanged",
            "observation_id": "obs-9",
            "tab_id": 7,
        });
        let meta = ScopeResultMeta {
            session_id: "s1".into(),
            tab_id: Some(7),
            short_ctx: Some("c1".into()),
            short_obs: Some("o1".into()),
            cached_vom: Some("@vom 1\nbutton Save [ref=@e1]".into()),
            cached_vom_truncated: true,
            cached_vom_next_cursor: Some("cur-2".into()),
            cached_url: Some("https://example.test/app".into()),
            cached_title: Some("App".into()),
            cache_reusable: true,
        };
        assert!(hydrate_cached_observation(&mut reply, Some(&meta)));
        assert_eq!(
            reply["observation"]["text"],
            "@vom 1\nbutton Save [ref=@e1]"
        );
        assert_eq!(reply["observation"]["truncated"], true);
        assert_eq!(reply["observation"]["next_cursor"], "cur-2");
        assert_eq!(reply["observation"]["observation_id"], "obs-9");
        assert_eq!(reply["observation"]["tab_id"], 7);
        assert_eq!(reply["observation"]["url"], "https://example.test/app");
        assert_eq!(reply["observation"]["title"], "App");
    }

    #[tokio::test]
    async fn await_cancelled_operation_recovers_fast_reply_and_bounds_wedged_future() {
        let fast = await_cancelled_operation(async { 42usize }, Duration::from_millis(200)).await;
        assert_eq!(fast, Some(42));

        let wedged =
            await_cancelled_operation(std::future::pending::<usize>(), Duration::from_millis(25))
                .await;
        assert_eq!(wedged, None);
    }
}
