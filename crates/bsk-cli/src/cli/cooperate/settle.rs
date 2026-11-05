//! Retry only read-only synchronization, never the action that preceded it.
use crate::cli::error::CliError;
use bsk_protocol::{ErrorCode, tools::CooperateAction};
use serde_json::{Value, json};

fn recoverable(error: &CliError) -> bool {
    error.code() == Some(ErrorCode::PermissionDenied)
        && error.data().is_some_and(|d| {
            d["reason"] == "cooperation_sync_required" && d["effect_state"] == "none"
        })
}
pub(crate) fn run(
    mut call: impl FnMut(CooperateAction) -> Result<Value, CliError>,
) -> Result<Value, CliError> {
    for attempt in 1..=3 {
        match call(CooperateAction::Sync) {
            Ok(mut reply) => {
                reply["settle"] = json!({"sync_attempts":attempt,"outcome":"synchronized"});
                return Ok(reply);
            }
            Err(error) if attempt < 3 && recoverable(&error) => {
                let mut wait = call(CooperateAction::Wait)?;
                if wait["state"]["mode"] == "unavailable" && wait["stopped"] != true {
                    // Loading and slow frames can outlast this bounded wait.
                    // Let the next sync recover or return the actual failure.
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
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!()
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
}
