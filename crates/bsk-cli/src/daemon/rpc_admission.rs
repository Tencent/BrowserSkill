//! One-use, daemon-issued admission tickets for cancellable local RPCs.
//!
//! An unknown ticket never becomes an ordinary RPC. Therefore expired entries
//! can be removed without allowing delayed requests to execute, even after a
//! daemon restart. Deadlines use the daemon's monotonic clock, not client time.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bsk_protocol::{ErrorCode, Method, RpcError};
use serde_json::json;

pub const PREFIX: &str = "bsk-rpc/";
pub const ADMISSION_WINDOW: Duration = Duration::from_secs(30);
const MAX_TICKETS: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Prepared,
    Active,
}

#[derive(Debug)]
struct Ticket {
    method: Method,
    deadline: Instant,
    phase: Phase,
    cancelled: bool,
}

#[derive(Debug, Default)]
pub struct RpcAdmissions(Mutex<HashMap<String, Ticket>>);

fn rejected(code: ErrorCode, reason: &str, message: &str) -> RpcError {
    RpcError {
        code,
        message: message.into(),
        data: Some(json!({"reason":reason,"effect_state":"none"})),
    }
}

fn uncertain(reason: &str, message: &str) -> RpcError {
    RpcError {
        code: ErrorCode::InvalidParams,
        message: message.into(),
        data: Some(json!({"reason":reason,"effect_state":"unknown"})),
    }
}

impl RpcAdmissions {
    pub fn prepare(&self, method: Method) -> Result<String, RpcError> {
        self.prepare_at(method, Instant::now())
    }

    fn prepare_at(&self, method: Method, now: Instant) -> Result<String, RpcError> {
        let mut tickets = self.0.lock().unwrap();
        tickets.retain(|_, ticket| ticket.phase == Phase::Active || ticket.deadline > now);
        if tickets.len() >= MAX_TICKETS {
            return Err(rejected(
                ErrorCode::Timeout,
                "rpc_admission_full",
                "RPC admission capacity reached; retry later",
            ));
        }
        let id = format!("{PREFIX}{}", uuid::Uuid::new_v4());
        tickets.insert(
            id.clone(),
            Ticket {
                method,
                deadline: now + ADMISSION_WINDOW,
                phase: Phase::Prepared,
                cancelled: false,
            },
        );
        Ok(id)
    }

    /// Legacy IDs retain legacy cancellation. Reserved IDs must be prepared,
    /// unexpired, uncancelled, bound to this method, and never previously used.
    pub fn admit(
        self: &Arc<Self>,
        id: &str,
        method: &Method,
    ) -> Result<Option<AdmissionGuard>, RpcError> {
        self.admit_at(id, method, Instant::now())
    }

    fn admit_at(
        self: &Arc<Self>,
        id: &str,
        method: &Method,
        now: Instant,
    ) -> Result<Option<AdmissionGuard>, RpcError> {
        if !id.starts_with(PREFIX) {
            return Ok(None);
        }
        let mut tickets = self.0.lock().unwrap();
        let missing = || {
            uncertain(
                "rpc_admission_missing",
                "RPC ticket is unknown, expired, already completed or belongs to a previous daemon; check the original outcome before starting another operation",
            )
        };
        let ticket = tickets.get_mut(id).ok_or_else(missing)?;
        if ticket.phase != Phase::Prepared {
            return Err(uncertain(
                "rpc_admission_used",
                "RPC ticket has already been used; do not replay an operation with uncertain effects",
            ));
        }
        if ticket.deadline <= now {
            tickets.remove(id);
            return Err(rejected(
                ErrorCode::InvalidParams,
                "rpc_admission_expired",
                "RPC ticket expired before admission; no operation was dispatched",
            ));
        }
        if &ticket.method != method {
            return Err(rejected(
                ErrorCode::InvalidParams,
                "rpc_admission_method",
                "RPC ticket was prepared for a different method",
            ));
        }
        if ticket.cancelled {
            return Err(rejected(
                ErrorCode::Cancelled,
                "cancelled_before_dispatch",
                "RPC was cancelled before admission",
            ));
        }
        ticket.phase = Phase::Active;
        Ok(Some(AdmissionGuard {
            admissions: self.clone(),
            id: id.into(),
        }))
    }

    /// Remember cancellation before consulting the actual execution registries.
    /// Their post-registration check bridges cancellation during admission.
    pub fn cancel(&self, id: &str) -> bool {
        self.cancel_at(id, Instant::now())
    }

    fn cancel_at(&self, id: &str, now: Instant) -> bool {
        let mut tickets = self.0.lock().unwrap();
        let Some(ticket) = tickets.get_mut(id) else {
            return false;
        };
        if ticket.phase == Phase::Prepared && ticket.deadline <= now {
            return false;
        }
        ticket.cancelled = true;
        true
    }

    pub fn is_cancelled(&self, id: &str) -> bool {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|ticket| ticket.cancelled)
    }
}

pub struct AdmissionGuard {
    admissions: Arc<RpcAdmissions>,
    id: String,
}

impl Drop for AdmissionGuard {
    fn drop(&mut self) {
        // Missing tickets are rejected, so completed requests need no tombstone.
        // Free their capacity immediately without permitting replay.
        self.admissions.0.lock().unwrap().remove(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelled_ticket_never_admits_even_after_collection() {
        let admissions = Arc::new(RpcAdmissions::default());
        let now = Instant::now();
        let id = admissions.prepare_at(Method::ToolClick, now).unwrap();
        assert!(admissions.cancel_at(&id, now));
        assert!(matches!(
            admissions.admit_at(&id, &Method::ToolClick, now),
            Err(RpcError {
                code: ErrorCode::Cancelled,
                ..
            })
        ));
        admissions
            .prepare_at(Method::ToolClick, now + ADMISSION_WINDOW)
            .unwrap();
        assert!(!admissions.0.lock().unwrap().contains_key(&id));
        assert!(
            admissions
                .admit_at(&id, &Method::ToolClick, now + ADMISSION_WINDOW)
                .is_err()
        );
        // Rewinding wall time cannot resurrect a ticket which has been collected.
        assert!(admissions.admit_at(&id, &Method::ToolClick, now).is_err());
    }

    #[test]
    fn tickets_are_one_use_method_bound_and_daemon_scoped() {
        let admissions = Arc::new(RpcAdmissions::default());
        let id = admissions.prepare(Method::ToolClick).unwrap();
        assert!(admissions.admit(&id, &Method::SessionStart).is_err());
        assert!(
            Arc::new(RpcAdmissions::default())
                .admit(&id, &Method::ToolClick)
                .is_err()
        );
        let guard = admissions.admit(&id, &Method::ToolClick).unwrap();
        assert!(admissions.admit(&id, &Method::ToolClick).is_err());
        drop(guard);
        assert!(!admissions.cancel(&id));
        assert!(admissions.admit(&id, &Method::ToolClick).is_err());
        assert!(
            admissions
                .admit("legacy", &Method::ToolClick)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn duplicate_or_missing_tickets_do_not_claim_the_original_had_no_effect() {
        let admissions = Arc::new(RpcAdmissions::default());
        let id = admissions.prepare(Method::ToolClick).unwrap();
        let guard = admissions.admit(&id, &Method::ToolClick).unwrap();
        let error = match admissions.admit(&id, &Method::ToolClick) {
            Err(e) => e,
            Ok(_) => panic!("replayed active ticket"),
        };
        assert_eq!(error.data.unwrap()["effect_state"], "unknown");
        drop(guard);
        let error = match admissions.admit(&id, &Method::ToolClick) {
            Err(e) => e,
            Ok(_) => panic!("replayed finished ticket"),
        };
        assert_eq!(error.data.unwrap()["effect_state"], "unknown");
    }

    #[test]
    fn active_ticket_survives_expiry_until_registration_and_completion() {
        let admissions = Arc::new(RpcAdmissions::default());
        let now = Instant::now();
        let id = admissions.prepare_at(Method::ToolClick, now).unwrap();
        let guard = admissions.admit_at(&id, &Method::ToolClick, now).unwrap();
        admissions
            .prepare_at(Method::ToolClick, now + ADMISSION_WINDOW)
            .unwrap();
        assert!(admissions.cancel_at(&id, now + ADMISSION_WINDOW));
        assert!(admissions.is_cancelled(&id));
        drop(guard);
    }

    #[test]
    fn capacity_does_not_evict_live_cancellations() {
        let admissions = Arc::new(RpcAdmissions::default());
        let now = Instant::now();
        let id = admissions.prepare_at(Method::ToolClick, now).unwrap();
        admissions.cancel_at(&id, now);
        for _ in 1..MAX_TICKETS {
            admissions.prepare_at(Method::ToolClick, now).unwrap();
        }
        assert!(admissions.prepare_at(Method::ToolClick, now).is_err());
        assert!(admissions.is_cancelled(&id));
        assert!(
            admissions
                .prepare_at(Method::ToolClick, now + ADMISSION_WINDOW)
                .is_ok()
        );
        assert_eq!(admissions.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn cancellation_between_admission_and_registration_reaches_both_registries() {
        use super::super::{
            abort::AbortRegistry,
            browsers::BrowserId,
            inflight::{PromoteOutcome, ToolInflightRegistry},
            sessions::SessionId,
        };
        let admissions = Arc::new(RpcAdmissions::default());
        let local = Arc::new(AbortRegistry::with_admissions(admissions.clone()));
        let tools = Arc::new(ToolInflightRegistry::with_admissions(admissions.clone()));
        let id = admissions.prepare(Method::ToolClick).unwrap();
        let _guard = admissions.admit(&id, &Method::ToolClick).unwrap();
        assert!(admissions.cancel(&id));
        assert!(!local.cancel(&id));
        assert!(tools.cancel(&id).is_none());
        let local_guard = local.register(id.clone()).unwrap();
        assert!(local_guard.token().is_cancelled());
        let tool_guard = tools.register(id, SessionId("fixture".into())).unwrap();
        assert_eq!(
            tool_guard.entry().promote_to_forwarded_with(
                BrowserId("browser".into()),
                "ws-id".into(),
                || panic!("cancelled request reached the browser")
            ),
            PromoteOutcome::Cancelled
        );
    }
}
