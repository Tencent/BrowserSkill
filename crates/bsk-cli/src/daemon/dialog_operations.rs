//! Keep an already-dispatched tool alive when a sequential agent must answer a modal.
//! Only dialog-suspended results are retained. Await never replays a browser action.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bsk_protocol::{ErrorCode, Method, ResponseBody, RpcError};
use serde_json::{Value, json};
use tokio::sync::watch;

const MAX_OPERATIONS: usize = 64;
const RESULT_TTL: Duration = Duration::from_secs(300);
const MAX_RESULT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone)]
enum Progress {
    Running,
    Dialog(Value),
    Complete(ResponseBody, Instant),
}

#[derive(Debug)]
pub struct DialogOperation {
    pub id: String,
    pub session_id: String,
    pub cli_rpc_id: String,
    method: Method,
    retained: AtomicBool,
    progress: watch::Sender<Progress>,
}

impl DialogOperation {
    pub fn finish(&self, body: ResponseBody) {
        let body = if self.retained.load(Ordering::Acquire) {
            bound_result(body)
        } else {
            body
        };
        self.progress
            .send_replace(Progress::Complete(body, Instant::now()));
    }

    fn pending(&self, dialog: Value) -> ResponseBody {
        ResponseBody::Err(RpcError {
            code: ErrorCode::DialogPending,
            message: "Original operation is suspended for a dialog decision; do not repeat it"
                .into(),
            data: Some(json!({
                "reason": "dialog_pending", "state": "waiting_for_dialog",
                "dispatched": true,
                "session_id": self.session_id, "operation_id": self.id,
                "method": self.method, "dialog": dialog,
            })),
        })
    }

    pub async fn initial_response(&self) -> (ResponseBody, bool) {
        let mut progress = self.progress.subscribe();
        loop {
            let current = progress.borrow_and_update().clone();
            match current {
                Progress::Dialog(dialog) => {
                    self.retained.store(true, Ordering::Release);
                    self.progress.send_if_modified(|progress| {
                        if let Progress::Complete(body, _) = progress {
                            *body = bound_result(body.clone());
                            return true;
                        }
                        false
                    });
                    return (self.pending(dialog), true);
                }
                Progress::Complete(body, _) => return (body, false),
                Progress::Running => {}
            }
            if progress.changed().await.is_err() {
                return (
                    error(ErrorCode::ProtocolError, "operation observer closed"),
                    false,
                );
            }
        }
    }

    pub async fn await_result(&self, wait_ms: u32) -> ResponseBody {
        let mut progress = self.progress.subscribe();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(wait_ms.into());
        loop {
            let current = progress.borrow_and_update().clone();
            match current {
                Progress::Dialog(dialog) => return self.pending(dialog),
                Progress::Complete(body, _) => {
                    if serde_json::to_vec(&bsk_protocol::ResponseFrame {
                        id: self.id.clone(),
                        body: body.clone(),
                    })
                    .map_or(true, |bytes| bytes.len() > MAX_RESULT_BYTES)
                    {
                        return error(
                            ErrorCode::ProtocolError,
                            "retained operation result exceeds 4 MiB; action was already dispatched and must not be replayed",
                        );
                    }
                    return ResponseBody::Ok(match body {
                        ResponseBody::Ok(result) => {
                            json!({"operation_id":self.id, "method":self.method, "state":"completed", "result":result})
                        }
                        ResponseBody::Err(error) => {
                            json!({"operation_id":self.id, "method":self.method, "state":"failed", "error":error})
                        }
                    });
                }
                Progress::Running => {}
            }
            if tokio::time::timeout_at(deadline, progress.changed())
                .await
                .is_err()
            {
                return ResponseBody::Ok(
                    json!({"operation_id":self.id, "method":self.method, "state":"running"}),
                );
            }
        }
    }
}

#[derive(Debug, Default)]
pub struct DialogOperations(Mutex<HashMap<String, Arc<DialogOperation>>>);

impl DialogOperations {
    pub fn register(
        &self,
        session_id: &str,
        cli_rpc_id: &str,
        method: Method,
    ) -> Result<Arc<DialogOperation>, RpcError> {
        let mut entries = self.0.lock().expect("dialog operation registry poisoned");
        entries.retain(|_, entry| !matches!(*entry.progress.borrow(), Progress::Complete(_, at) if at.elapsed() >= RESULT_TTL));
        if entries.len() >= MAX_OPERATIONS {
            let oldest = entries
                .iter()
                .filter_map(|(id, entry)| match *entry.progress.borrow() {
                    Progress::Complete(_, at) => Some((id.clone(), at)),
                    _ => None,
                })
                .min_by_key(|(_, at)| *at)
                .map(|(id, _)| id);
            if let Some(id) = oldest {
                entries.remove(&id);
            }
        }
        if entries.len() >= MAX_OPERATIONS {
            return Err(RpcError {
                code: ErrorCode::ProtocolError,
                message: "dialog operation capacity reached; action was not dispatched".into(),
                data: Some(json!({"dispatched":false})),
            });
        }
        let (progress, _) = watch::channel(Progress::Running);
        let entry = Arc::new(DialogOperation {
            id: format!("op-{}", uuid::Uuid::new_v4()),
            session_id: session_id.into(),
            cli_rpc_id: cli_rpc_id.into(),
            method,
            retained: AtomicBool::new(false),
            progress,
        });
        entries.insert(entry.id.clone(), Arc::clone(&entry));
        Ok(entry)
    }

    pub fn get(&self, session_id: &str, id: &str) -> Option<Arc<DialogOperation>> {
        self.0.lock().expect("dialog operation registry poisoned").get(id)
            .filter(|entry| entry.session_id == session_id && !matches!(*entry.progress.borrow(), Progress::Complete(_, at) if at.elapsed() >= RESULT_TTL))
            .cloned()
    }

    pub fn remove(&self, id: &str) {
        self.0
            .lock()
            .expect("dialog operation registry poisoned")
            .remove(id);
    }

    pub fn remove_session(&self, session_id: &str) {
        self.0
            .lock()
            .expect("dialog operation registry poisoned")
            .retain(|_, entry| entry.session_id != session_id);
    }

    /// WS caller verifies that this browser still owns the payload's session.
    pub fn dialog_changed(&self, payload: &Value) {
        let (Some(session), Some(id)) = (
            payload["session_id"].as_str(),
            payload["operation_id"].as_str(),
        ) else {
            return;
        };
        let Some(entry) = self.get(session, id) else {
            return;
        };
        entry.progress.send_if_modified(|progress| {
            if matches!(progress, Progress::Complete(..)) {
                return false;
            }
            *progress = if payload["dialog"].is_object() {
                Progress::Dialog(payload["dialog"].clone())
            } else {
                Progress::Running
            };
            true
        });
    }
}

fn error(code: ErrorCode, message: &str) -> ResponseBody {
    ResponseBody::Err(RpcError {
        code,
        message: message.into(),
        data: None,
    })
}

fn bound_result(body: ResponseBody) -> ResponseBody {
    if serde_json::to_vec(&bsk_protocol::ResponseFrame {
        id: String::new(),
        body: body.clone(),
    })
    .map_or(true, |bytes| bytes.len() > MAX_RESULT_BYTES)
    {
        error(
            ErrorCode::ProtocolError,
            "retained operation result exceeded 4 MiB; the action was dispatched and must not be replayed",
        )
    } else {
        body
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_sequential_caller_receives_pending_then_the_exact_original_result() {
        let registry = DialogOperations::default();
        let op = registry
            .register("session", "cli-1", Method::ToolEvaluate)
            .unwrap();
        registry.dialog_changed(&json!({"session_id":"session", "operation_id":op.id, "dialog":{"id":"first", "type":"confirm"}}));
        let (body, suspended) = op.initial_response().await;
        assert!(suspended);
        let ResponseBody::Err(pending) = body else {
            panic!("expected pending");
        };
        assert_eq!(pending.code, ErrorCode::DialogPending);
        assert_eq!(pending.data.unwrap()["operation_id"], op.id);
        registry
            .dialog_changed(&json!({"session_id":"session", "operation_id":op.id, "dialog":null}));
        op.finish(ResponseBody::Ok(json!({"ok":true,"value":false})));
        for _ in 0..2 {
            let ResponseBody::Ok(result) = op.await_result(0).await else {
                panic!("missing retained result");
            };
            assert_eq!(result["state"], "completed");
            assert_eq!(result["result"]["value"], false);
        }
    }

    #[tokio::test]
    async fn dialog_events_cannot_cross_sessions_or_overwrite_a_terminal_result() {
        let registry = DialogOperations::default();
        let op = registry
            .register("owner", "cli-2", Method::ToolClick)
            .unwrap();
        registry.dialog_changed(
            &json!({"session_id":"other", "operation_id":op.id, "dialog":{"id":"wrong"}}),
        );
        assert!(matches!(*op.progress.borrow(), Progress::Running));
        assert!(registry.get("other", &op.id).is_none());
        op.finish(ResponseBody::Ok(json!("original")));
        registry.dialog_changed(
            &json!({"session_id":"owner", "operation_id":op.id, "dialog":{"id":"late"}}),
        );
        let ResponseBody::Ok(result) = op.await_result(0).await else {
            panic!("missing result");
        };
        assert_eq!(result["result"], "original");
    }

    #[tokio::test]
    async fn a_second_dialog_keeps_the_operation_identity_and_failure_is_retrievable() {
        let registry = DialogOperations::default();
        let op = registry
            .register("owner", "cli-3", Method::ToolEvaluate)
            .unwrap();
        for id in ["first", "second"] {
            registry.dialog_changed(
                &json!({"session_id":"owner", "operation_id":op.id, "dialog":{"id":id}}),
            );
            let ResponseBody::Err(pending) = op.await_result(0).await else {
                panic!("expected pending");
            };
            let data = pending.data.unwrap();
            assert_eq!(data["operation_id"], op.id);
            assert_eq!(data["dialog"]["id"], id);
        }
        op.finish(error(ErrorCode::Cancelled, "cancelled after dispatch"));
        let ResponseBody::Ok(result) = op.await_result(0).await else {
            panic!("missing failure");
        };
        assert_eq!(result["state"], "failed");
        assert_eq!(result["error"]["code"], "cancelled");
    }

    #[test]
    fn operation_capacity_is_bounded() {
        let registry = DialogOperations::default();
        for i in 0..MAX_OPERATIONS {
            registry
                .register("owner", &i.to_string(), Method::ToolEvaluate)
                .unwrap();
        }
        assert!(
            registry
                .register("owner", "overflow", Method::ToolEvaluate)
                .is_err()
        );
    }

    #[test]
    fn completed_receipts_do_not_prevent_new_actions_when_capacity_is_full() {
        let registry = DialogOperations::default();
        let oldest = registry
            .register("owner", "oldest", Method::ToolEvaluate)
            .unwrap();
        oldest.finish(ResponseBody::Ok(json!(false)));
        for i in 1..MAX_OPERATIONS {
            registry
                .register("owner", &i.to_string(), Method::ToolEvaluate)
                .unwrap();
        }
        assert!(
            registry
                .register("owner", "next", Method::ToolEvaluate)
                .is_ok()
        );
        assert!(registry.get("owner", &oldest.id).is_none());
    }

    #[tokio::test]
    async fn oversized_retained_results_fail_without_replaying_the_action() {
        let registry = DialogOperations::default();
        let op = registry
            .register("owner", "large", Method::ToolEvaluate)
            .unwrap();
        registry.dialog_changed(
            &json!({"session_id":"owner", "operation_id":op.id, "dialog":{"id":"first"}}),
        );
        op.initial_response().await;
        op.finish(ResponseBody::Ok(json!("x".repeat(MAX_RESULT_BYTES + 1))));
        let ResponseBody::Ok(result) = op.await_result(0).await else {
            panic!("missing retained failure");
        };
        assert_eq!(result["state"], "failed");
        assert_eq!(result["error"]["code"], "protocol_error");
        assert!(
            result["error"]["message"]
                .as_str()
                .unwrap()
                .contains("must not be replayed")
        );
    }
}
