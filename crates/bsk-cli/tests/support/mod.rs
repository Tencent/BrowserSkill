//! Shared synchronization helpers for IPC integration tests.
//!
//! Prefer condition-based waits over fixed `sleep` so tests proceed as soon
//! as the daemon / fake extension reaches the expected state.

#![allow(dead_code)]

use std::sync::Arc;
use std::time::{Duration, Instant};

use bsk::daemon::queue::ToolQueueRegistry;
use bsk::daemon::sessions::SessionId;
use bsk::daemon::state::DaemonState;
use bsk_protocol::RpcId;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(2);

/// Poll `condition` until it returns `true` or `timeout` elapses.
pub async fn wait_until<F>(label: &str, timeout: Duration, mut condition: F)
where
    F: FnMut() -> bool,
{
    let deadline = Instant::now() + timeout;
    loop {
        if condition() {
            return;
        }
        if Instant::now() >= deadline {
            panic!("timed out waiting for {label}");
        }
        tokio::task::yield_now().await;
    }
}

pub async fn wait_for_browser_count(state: &Arc<DaemonState>, expected: usize) {
    wait_until(
        &format!("browser count == {expected}"),
        DEFAULT_TIMEOUT,
        || state.browsers.len() == expected,
    )
    .await;
}

pub async fn wait_for_no_sessions(state: &Arc<DaemonState>) {
    wait_until("no sessions", DEFAULT_TIMEOUT, || state.sessions.is_empty()).await;
}

pub async fn wait_for_session_count(state: &Arc<DaemonState>, expected: usize) {
    wait_until(
        &format!("session count == {expected}"),
        DEFAULT_TIMEOUT,
        || state.sessions.len() == expected,
    )
    .await;
}

pub async fn wait_for_inflight_registered(state: &Arc<DaemonState>, rpc_id: &RpcId) {
    let id = rpc_id.clone();
    wait_until(
        &format!("inflight registered for {id}"),
        DEFAULT_TIMEOUT,
        || state.tool_inflight.get(&id).is_some(),
    )
    .await;
}

pub async fn wait_for_inflight_forwarded(state: &Arc<DaemonState>, rpc_id: &RpcId) {
    let id = rpc_id.clone();
    wait_until(
        &format!("inflight forwarded for {id}"),
        DEFAULT_TIMEOUT,
        || {
            state
                .tool_inflight
                .get(&id)
                .is_some_and(|entry| entry.snapshot().ws_rpc_id.is_some())
        },
    )
    .await;
}

pub async fn wait_for_abort_registered(state: &Arc<DaemonState>, rpc_id: &RpcId) {
    let id = rpc_id.clone();
    wait_until(&format!("abort token for {id}"), DEFAULT_TIMEOUT, || {
        state.abort_registry.contains(&id)
    })
    .await;
}

pub async fn wait_for_session_interrupt_pending(state: &Arc<DaemonState>, session_id: &str) {
    let sid = SessionId(session_id.to_string());
    wait_until(
        &format!("session interrupt pending for {session_id}"),
        DEFAULT_TIMEOUT,
        || state.session_interrupts.is_pending(&sid),
    )
    .await;
}

pub async fn wait_for_session_not_accepting(queues: &Arc<ToolQueueRegistry>, sid: &SessionId) {
    let sid = sid.clone();
    wait_until(
        &format!("session {} queue closed to new tools", sid.0),
        DEFAULT_TIMEOUT,
        || !queues.is_accepting(&sid),
    )
    .await;
}
