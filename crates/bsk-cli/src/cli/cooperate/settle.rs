//! Retry only read-only synchronization, never the action that preceded it.
use crate::cli::error::CliError;
use bsk_protocol::{ErrorCode, RpcErrorReason, tools::CooperateAction};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

/// Pauses before syncing again while an earlier command still owns the
/// browser call, such as a cancelled observation screenshot (#527). Viewport
/// captures are bounded at about 10.5 s; most settle within a second.
const SETTLING_PAUSES: [Duration; 3] = [
    Duration::from_millis(500),
    Duration::from_millis(1500),
    Duration::from_millis(3000),
];
/// How extensions without `operation_settling` report the same refusal.
const LEGACY_SETTLING: &str = "Previous operation is still settling";

fn recoverable(error: &CliError) -> bool {
    (error.code() == Some(ErrorCode::PermissionDenied)
        && error.data().is_some_and(|d| {
            d["reason"] == "cooperation_sync_required" && d["effect_state"] == "none"
        }))
        || (error.code() == Some(ErrorCode::NotFound)
            && error
                .data()
                .is_some_and(|d| d["reason"] == "ref_not_found" && d["effect_state"] != "unknown")
            && error
                .to_string()
                .contains("Document changed during observation"))
}

/// The sync was refused before dispatch because an earlier command on the
/// session has not settled. Syncing again after a pause is safe.
fn settling(error: &CliError) -> bool {
    let CliError::Rpc {
        code: ErrorCode::CdpFailed,
        message,
        data: Some(data),
        ..
    } = error
    else {
        return false;
    };
    data["dispatched"] == false
        && (data["reason"] == RpcErrorReason::OperationSettling.as_str()
            || message.starts_with(LEGACY_SETTLING))
}

pub(crate) fn run(
    call: impl FnMut(CooperateAction) -> Result<Value, CliError>,
) -> Result<Value, CliError> {
    run_with_pause(call, std::thread::sleep)
}

pub(crate) fn run_bounded(
    budget: Option<Duration>,
    call: impl FnMut(CooperateAction, Option<Duration>) -> Result<Value, CliError>,
) -> Result<Value, CliError> {
    let start = Instant::now();
    run_with_clock(budget, || start.elapsed(), std::thread::sleep, call)
}

fn run_with_pause(
    mut call: impl FnMut(CooperateAction) -> Result<Value, CliError>,
    pause: impl FnMut(Duration),
) -> Result<Value, CliError> {
    run_with_clock(None, || Duration::ZERO, pause, |action, _| call(action))
}

fn remaining_budget(budget: Option<Duration>, elapsed: Duration) -> Option<Duration> {
    budget.map(|limit| limit.saturating_sub(elapsed))
}

fn run_with_clock(
    budget: Option<Duration>,
    mut elapsed: impl FnMut() -> Duration,
    mut pause: impl FnMut(Duration),
    mut call: impl FnMut(CooperateAction, Option<Duration>) -> Result<Value, CliError>,
) -> Result<Value, CliError> {
    let mut attempt = 0;
    let mut waits = 0;
    let mut pauses = 0;
    loop {
        attempt += 1;
        let sync_rem = remaining_budget(budget, elapsed());
        match call(CooperateAction::Sync, sync_rem) {
            Ok(mut reply) => {
                reply["settle"] = json!({"sync_attempts":attempt,"outcome":"synchronized"});
                return Ok(reply);
            }
            Err(error) => {
                let rem = remaining_budget(budget, elapsed());
                if rem.is_some_and(|r| r.is_zero()) {
                    return Err(error);
                }
                // `cooperate wait` would be refused the same way; only time helps.
                if pauses < SETTLING_PAUSES.len() && settling(&error) {
                    let delay =
                        rem.map_or(SETTLING_PAUSES[pauses], |r| SETTLING_PAUSES[pauses].min(r));
                    pause(delay);
                    pauses += 1;
                    if remaining_budget(budget, elapsed()).is_some_and(|r| r.is_zero()) {
                        return Err(error);
                    }
                    continue;
                }
                if waits < 2 && recoverable(&error) {
                    waits += 1;
                    let mut wait = call(CooperateAction::Wait, rem)?;
                    if wait["state"]["mode"] == "unavailable" && wait["stopped"] != true {
                        // Loading and slow frames can outlast this bounded wait.
                        // Let the next sync recover or return the actual failure.
                        if remaining_budget(budget, elapsed()).is_some_and(|r| r.is_zero()) {
                            return Err(error);
                        }
                        continue;
                    }
                    if wait["ready"] != true || wait["stopped"] == true {
                        // No action context is issued while ownership is unavailable.
                        if let Some(map) = wait.as_object_mut() {
                            map.remove("context_id");
                        }
                        wait["settle"] = json!({"sync_attempts":attempt,"outcome":"not_ready"});
                        return Ok(wait);
                    }
                    if remaining_budget(budget, elapsed()).is_some_and(|r| r.is_zero()) {
                        return Err(error);
                    }
                    continue;
                }
                return Err(error);
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use bsk_protocol::RpcError;
    fn error(code: ErrorCode, effect: &str) -> CliError {
        CliError::from_rpc(RpcError {
            code,
            message: "sync changed".into(),
            data: Some(json!({"reason":"cooperation_sync_required","effect_state":effect})),
        })
    }
    #[test]
    fn transient_sync_recovers_with_wait_without_replaying_actions() {
        let mut calls = Vec::new();
        let reply = run(|action| {
            calls.push(format!("{action:?}"));
            match calls.len() {
                1 => Err(error(ErrorCode::PermissionDenied, "none")),
                2 => Ok(json!({"ready":true,"stopped":false})),
                _ => Ok(json!({"context_id":"fresh","activity":["human edit"]})),
            }
        })
        .unwrap();
        assert_eq!(calls, ["Sync", "Wait", "Sync"]);
        assert_eq!(reply["context_id"], "fresh");
        assert_eq!(reply["activity"], json!(["human edit"]));
    }
    #[test]
    fn retries_are_bounded() {
        let mut syncs = 0;
        let mut waits = 0;
        assert!(
            run(|action| match action {
                CooperateAction::Sync => {
                    syncs += 1;
                    Err(error(ErrorCode::PermissionDenied, "none"))
                }
                CooperateAction::Wait => {
                    waits += 1;
                    Ok(json!({"ready":true}))
                }
                _ => panic!(),
            })
            .is_err()
        );
        assert_eq!((syncs, waits), (3, 2));
    }
    #[test]
    fn cancelled_unknown_and_other_errors_are_never_retried() {
        for (code, effect) in [
            (ErrorCode::Cancelled, "none"),
            (ErrorCode::UserAborted, "none"),
            (ErrorCode::PermissionDenied, "unknown"),
            (ErrorCode::NotFound, "none"),
        ] {
            let mut calls = 0;
            assert!(
                run(|_| {
                    calls += 1;
                    Err(error(code, effect))
                })
                .is_err()
            );
            assert_eq!(calls, 1);
        }
    }
    #[test]
    fn human_hold_and_stopped_wait_return_without_an_action_context() {
        for wait in [
            json!({"ready":false,"state":{"mode":"human"},"activity":["typing"]}),
            json!({"ready":false,"state":{"mode":"held"}}),
            json!({"ready":true,"stopped":true}),
            json!({"ready":false,"stopped":true,"state":{"mode":"unavailable"}}),
        ] {
            let mut calls = 0;
            let result = run(|_| {
                calls += 1;
                if calls == 1 {
                    Err(error(ErrorCode::PermissionDenied, "none"))
                } else {
                    Ok(wait.clone())
                }
            })
            .unwrap();
            assert_eq!(calls, 2);
            assert!(result.get("context_id").is_none());
            assert_eq!(result["settle"]["outcome"], "not_ready");
        }
    }

    #[test]
    fn unobservable_frames_and_failed_pages_are_not_retried() {
        for reason in ["frame_unobservable", "page_load_failed"] {
            let mut calls = Vec::new();
            let result = run(|action| {
                calls.push(format!("{action:?}"));
                Err(CliError::from_rpc(RpcError {
                    code: ErrorCode::PermissionDenied,
                    message: "page unavailable".into(),
                    data: Some(json!({"reason": reason, "effect_state": "none"})),
                }))
            });
            assert_eq!(calls, ["Sync"]);
            assert_eq!(result.unwrap_err().data().unwrap()["reason"], reason);
        }
    }

    #[test]
    fn unavailable_wait_can_recover_on_the_next_sync() {
        let mut calls = Vec::new();
        let result = run(|action| {
            calls.push(format!("{action:?}"));
            match calls.len() {
                1 => Err(error(ErrorCode::PermissionDenied, "none")),
                2 => Ok(json!({"ready":false,"state":{"mode":"unavailable"}})),
                _ => Ok(json!({"context_id":"loaded"})),
            }
        })
        .unwrap();
        assert_eq!(calls, ["Sync", "Wait", "Sync"]);
        assert_eq!(result["context_id"], "loaded");
        assert_eq!(result["settle"]["sync_attempts"], 2);
        assert_eq!(result["settle"]["outcome"], "synchronized");
    }

    #[test]
    fn unavailable_wait_exhausts_the_budget_and_preserves_the_last_sync_error() {
        let mut calls = Vec::new();
        let result = run(|action| {
            calls.push(format!("{action:?}"));
            match action {
                CooperateAction::Sync if calls.len() == 5 => Err(CliError::from_rpc(RpcError {
                    code: ErrorCode::PermissionDenied,
                    message: "frame is still loading".into(),
                    data: Some(
                        json!({"reason":"cooperation_sync_required","effect_state":"none","detail":"last attempt"}),
                    ),
                })),
                CooperateAction::Sync => Err(error(ErrorCode::PermissionDenied, "none")),
                CooperateAction::Wait => Ok(json!({"ready":false,"state":{"mode":"unavailable"}})),
                _ => panic!(),
            }
        });
        assert_eq!(calls, ["Sync", "Wait", "Sync", "Wait", "Sync"]);
        let error = result.unwrap_err();
        assert_eq!(error.code(), Some(ErrorCode::PermissionDenied));
        assert_eq!(error.data().unwrap()["reason"], "cooperation_sync_required");
        assert_eq!(error.data().unwrap()["detail"], "last attempt");
        assert!(error.to_string().contains("frame is still loading"));
    }

    fn settling_error(reason: Option<&str>, message: &str) -> CliError {
        let mut data = json!({"dispatched": false});
        if let Some(reason) = reason {
            data["reason"] = json!(reason);
        }
        CliError::from_rpc(RpcError {
            code: ErrorCode::CdpFailed,
            message: message.into(),
            data: Some(data),
        })
    }

    #[test]
    fn settling_refusals_pause_and_sync_again_without_waiting_for_control() {
        for error in [
            || {
                settling_error(
                    Some(bsk_protocol::RpcErrorReason::OperationSettling.as_str()),
                    "busy",
                )
            },
            || {
                settling_error(
                    None,
                    "Previous operation is still settling; this action was not dispatched",
                )
            },
        ] {
            let mut calls = Vec::new();
            let mut pauses = Vec::new();
            let reply = run_with_pause(
                |action| {
                    calls.push(format!("{action:?}"));
                    if calls.len() < 3 {
                        Err(error())
                    } else {
                        Ok(json!({"context_id":"fresh"}))
                    }
                },
                |pause| pauses.push(pause),
            )
            .unwrap();
            assert_eq!(calls, ["Sync", "Sync", "Sync"]);
            assert_eq!(pauses, SETTLING_PAUSES[..2]);
            assert_eq!(reply["context_id"], "fresh");
            assert_eq!(reply["settle"]["sync_attempts"], 3);
        }
    }

    #[test]
    fn settling_pauses_are_bounded_and_return_the_last_refusal() {
        let mut syncs = 0;
        let mut paused = Duration::ZERO;
        let error = run_with_pause(
            |action| {
                assert!(matches!(action, CooperateAction::Sync));
                syncs += 1;
                Err(settling_error(
                    Some(bsk_protocol::RpcErrorReason::OperationSettling.as_str()),
                    "busy",
                ))
            },
            |pause| paused += pause,
        )
        .unwrap_err();
        assert_eq!(syncs, 4);
        assert_eq!(paused, Duration::from_millis(5000));
        assert_eq!(
            error.data().unwrap()["reason"],
            bsk_protocol::RpcErrorReason::OperationSettling.as_str()
        );
    }

    #[test]
    fn mid_sync_document_change_retries_while_other_not_found_errors_fail_immediately() {
        let mut calls = Vec::new();
        let result = run(|action| {
            calls.push(format!("{action:?}"));
            match calls.len() {
                1 => Err(CliError::from_rpc(RpcError {
                    code: ErrorCode::NotFound,
                    message: "Document changed during observation; synchronize again".into(),
                    data: Some(json!({"reason": "ref_not_found", "effect_state": "none"})),
                })),
                2 => Ok(json!({"ready": true, "state": {"mode": "syncing"}})),
                _ => Ok(json!({"context_id": "recovered"})),
            }
        })
        .unwrap();
        assert_eq!(calls, ["Sync", "Wait", "Sync"]);
        assert_eq!(result["context_id"], "recovered");
        assert_eq!(result["settle"]["sync_attempts"], 2);

        let mut policy_calls = Vec::new();
        let policy_err = run(|action| {
            policy_calls.push(format!("{action:?}"));
            Err(CliError::from_rpc(RpcError {
                code: ErrorCode::NotFound,
                message: "Control policy changed during observation; observe again".into(),
                data: Some(json!({"reason": "ref_not_found", "effect_state": "none"})),
            }))
        })
        .unwrap_err();
        assert_eq!(policy_calls, ["Sync"]);
        assert!(policy_err.to_string().contains("Control policy changed"));
    }

    #[test]
    fn bounded_settle_stops_retries_once_wall_clock_budget_elapses() {
        let clock = std::cell::Cell::new(Duration::ZERO);
        let mut calls = Vec::new();
        let err = run_with_clock(
            Some(Duration::from_millis(15_000)),
            || clock.get(),
            |d| clock.set(clock.get() + d),
            |action, rem| {
                calls.push((format!("{action:?}"), rem));
                clock.set(clock.get() + Duration::from_millis(15_005));
                Err(error(ErrorCode::PermissionDenied, "none"))
            },
        )
        .unwrap_err();
        assert_eq!(
            calls,
            vec![("Sync".to_string(), Some(Duration::from_millis(15_000)))]
        );
        assert_eq!(err.code(), Some(ErrorCode::PermissionDenied));

        // Fast initial failure retries within remaining budget; unavailable wait exhausting
        // the budget preserves the last Sync error rather than misreporting not_ready.
        clock.set(Duration::ZERO);
        let mut retry_calls = Vec::new();
        let err = run_with_clock(
            Some(Duration::from_millis(5_000)),
            || clock.get(),
            |d| clock.set(clock.get() + d),
            |action, rem| {
                retry_calls.push((format!("{action:?}"), rem));
                match action {
                    CooperateAction::Sync => {
                        clock.set(clock.get() + Duration::from_millis(200));
                        Err(error(ErrorCode::PermissionDenied, "none"))
                    }
                    CooperateAction::Wait => {
                        clock.set(clock.get() + Duration::from_millis(4_800));
                        Ok(json!({"ready": false, "state": {"mode": "unavailable"}}))
                    }
                    _ => panic!(),
                }
            },
        )
        .unwrap_err();
        assert_eq!(
            retry_calls,
            vec![
                ("Sync".to_string(), Some(Duration::from_millis(5_000))),
                ("Wait".to_string(), Some(Duration::from_millis(4_800))),
            ]
        );
        assert_eq!(err.data().unwrap()["reason"], "cooperation_sync_required");
    }

    #[test]
    fn dispatched_or_other_browser_failures_are_not_treated_as_settling() {
        for error in [
            CliError::from_rpc(RpcError {
                code: ErrorCode::CdpFailed,
                message: "Previous operation is still settling".into(),
                data: Some(json!({"dispatched": true})),
            }),
            CliError::from_rpc(RpcError {
                code: ErrorCode::CdpFailed,
                message: "Target closed".into(),
                data: Some(json!({"dispatched": false})),
            }),
            CliError::from_rpc(RpcError {
                code: ErrorCode::Timeout,
                message: "busy".into(),
                data: Some(json!({
                    "reason": bsk_protocol::RpcErrorReason::OperationSettling.as_str(),
                    "dispatched": false
                })),
            }),
        ] {
            assert!(!settling(&error));
        }
    }
}
