//! Registration, revocation and replacement share the same device gates.
use crate::daemon::{browsers::BrowserClient, state::DaemonState};
use anyhow::{Result, ensure};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::watch;

#[derive(Debug)]
pub struct Lifecycle {
    connections: Mutex<HashMap<String, Connection>>,
    changed: watch::Sender<()>,
    pub(crate) registry_gate: Arc<tokio::sync::Mutex<()>>,
}
#[derive(Debug)]
struct Connection {
    browser: Weak<BrowserClient>,
    active: Arc<AtomicBool>,
    closed: watch::Receiver<bool>,
}
pub(crate) struct Lease {
    active: Arc<AtomicBool>,
    closed: watch::Sender<bool>,
}
impl Default for Lifecycle {
    fn default() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            changed: watch::channel(()).0,
            registry_gate: Arc::new(tokio::sync::Mutex::new(())),
        }
    }
}
impl Default for Lease {
    fn default() -> Self {
        Self {
            active: Arc::new(AtomicBool::new(true)),
            closed: watch::channel(false).0,
        }
    }
}
impl Lease {
    pub fn active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }
}
impl Lifecycle {
    pub(crate) fn changes(&self) -> watch::Receiver<()> {
        self.changed.subscribe()
    }
    pub(crate) fn notify(&self) {
        self.changed.send_replace(());
    }
    pub(crate) fn register(&self, id: &str, lease: &Lease, browser: &Arc<BrowserClient>) {
        let previous = self.connections.lock().unwrap().insert(
            id.into(),
            Connection {
                browser: Arc::downgrade(browser),
                active: lease.active.clone(),
                closed: lease.closed.subscribe(),
            },
        );
        if let Some(previous) = previous {
            previous.active.store(false, Ordering::Release);
        }
        self.notify();
    }
    pub(crate) fn closed(&self, id: &str, lease: &Lease) {
        let mut connections = self.connections.lock().unwrap();
        if connections
            .get(id)
            .is_some_and(|entry| Arc::ptr_eq(&entry.active, &lease.active))
        {
            connections.remove(id);
        }
        lease.closed.send_replace(true);
    }
}

/// Called with the relevant device gates held, after the durable revocation.
pub(crate) async fn disconnect(state: &Arc<DaemonState>, ids: &[String]) -> Result<()> {
    let mut closing = Vec::new();
    {
        let mut connections = state.local_auth.lifecycle.connections.lock().unwrap();
        for id in ids {
            if let Some(connection) = connections.remove(id) {
                connection.active.store(false, Ordering::Release);
                if let Some(browser) = connection.browser.upgrade() {
                    remove_browser(state, &browser);
                }
                closing.push(connection.closed);
            }
        }
    }
    state.local_auth.lifecycle.notify();
    for mut closed in closing {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !*closed.borrow_and_update() {
                if closed.changed().await.is_err() {
                    break;
                }
            }
        })
        .await
        .map_err(|_| anyhow::anyhow!("authorization revoked; connection shutdown timed out"))?;
    }
    Ok(())
}
pub(crate) fn remove_browser(state: &DaemonState, client: &BrowserClient) {
    client.pending.lock().unwrap().close();
    if state
        .browsers
        .remove_if_generation_matches(&client.id, client.generation)
        .is_some()
    {
        for session in state.sessions.purge_browser(&client.id) {
            state.tool_queues.remove(&session.id);
            state.session_interrupts.drop_session(&session.id);
            state.transfers.release_session(&session.id.0);
        }
    }
}
pub async fn revoke(state: Arc<DaemonState>, id: Option<String>) -> Result<()> {
    let mut ids = if let Some(id) = &id {
        vec![state.local_auth.store.resolve(id)?]
    } else {
        state
            .local_auth
            .store
            .devices()
            .into_iter()
            .map(|d| d.device_id)
            .collect()
    };
    ids.sort();
    let mut guards = Vec::new();
    for id in &ids {
        guards.push(state.local_auth.device_gate(id).lock_owned().await);
    }
    // Also covers a newly issued record that appeared after the --all snapshot:
    // no final check/insert may cross the durable revocation of all records.
    let registry = state
        .local_auth
        .lifecycle
        .registry_gate
        .clone()
        .lock_owned()
        .await;
    let local = state.local_auth.clone();
    let revoked = tokio::task::spawn_blocking(move || local.store.revoke(id.as_deref())).await??;
    disconnect(&state, &revoked).await?;
    drop(registry);
    drop(guards);
    Ok(())
}

pub(crate) async fn revoke_command(
    state: Arc<DaemonState>,
    value: serde_json::Value,
) -> Result<serde_json::Value> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Params {
        device_id: Option<String>,
        #[serde(default)]
        all: bool,
    }
    let params: Params = serde_json::from_value(value)
        .map_err(|_| anyhow::anyhow!("invalid revocation parameters"))?;
    ensure!(
        params.all != params.device_id.is_some(),
        "specify a device or --all"
    );
    let home = crate::daemon::paths::ensure_bsk_home()?;
    let remote = crate::daemon::remote::authorization::AuthorizationStore::at_home(&home);
    if params.all {
        revoke(state, None).await?;
        tokio::task::spawn_blocking(move || remote.revoke_all()).await??;
    } else {
        let id = params.device_id.unwrap();
        if state.local_auth.store.resolve(&id).is_ok() {
            revoke(state, Some(id)).await?;
        } else {
            ensure!(
                tokio::task::spawn_blocking(move || remote.revoke(&id)).await??,
                "device grant not found"
            );
        }
    }
    Ok(serde_json::json!({"revoked":true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::{
        DaemonConfig,
        browsers::{BrowserId, BrowserSink, Liveness, Pending, next_browser_generation},
        local_auth::{LocalAuth, LocalAuthMode, store},
        peer_authorization::{LocalPeer, PeerAuthorization},
    };

    fn activate(local: &LocalAuth) -> String {
        local.store.pair(52800, None).unwrap();
        let id = local.store.devices()[0].device_id.clone();
        let txn = store::random();
        local
            .store
            .stage_rotation(
                &id,
                0,
                None,
                store::Pending {
                    txn,
                    r#gen: 1,
                    key: store::random(),
                    created_at: store::now(),
                },
                "a1b2c3d4",
            )
            .unwrap();
        local.store.commit(&id, txn, "a1b2c3d4").unwrap();
        id
    }

    #[tokio::test]
    async fn l10_revocation_waits_for_a_paused_final_registration() {
        let state = Arc::new(DaemonState::new(
            DaemonConfig::new(0).with_local_auth(LocalAuthMode::Required),
        ));
        let id = activate(&state.local_auth);
        let peer = PeerAuthorization::Local(LocalPeer {
            device_id: id.clone(),
            browser_id: "a1b2c3d4".into(),
            local: state.local_auth.clone(),
            lease: Lease::default(),
        });
        let guard = peer.registration_guard().await;
        assert!(peer.authorized().await);
        // Deliberately pause after the final authorization check and before insert.
        let revoker = tokio::spawn(revoke(state.clone(), Some(id)));
        tokio::task::yield_now().await;
        assert!(!revoker.is_finished());
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let client = Arc::new(BrowserClient {
            id: BrowserId("a1b2c3d4".into()),
            browser_name: "Chrome".into(),
            browser_version: "130".into(),
            extension_version: "0.4.0".into(),
            extension_protocol_version: "1.3".into(),
            label: String::new(),
            sink: BrowserSink { tx },
            pending: Mutex::new(Pending::default()),
            generation: next_browser_generation(),
            connected_at_ms: 0,
            version_skew: false,
            liveness: Liveness::default(),
        });
        state.browsers.insert(client.clone());
        peer.register(&client);
        drop(guard);
        let socket_state = state.clone();
        let socket = tokio::spawn(async move {
            peer.revoked().await;
            remove_browser(&socket_state, &client);
            drop(peer);
        });
        revoker.await.unwrap().unwrap();
        assert!(state.browsers.is_empty());
        socket.await.unwrap();
    }

    #[tokio::test]
    async fn persisted_revocation_is_observed_by_old_and_reloaded_state() {
        let home = tempfile::tempdir().unwrap();
        let local = Arc::new(LocalAuth::open(home.path()).unwrap());
        let id = activate(&local);
        let peer = PeerAuthorization::Local(LocalPeer {
            device_id: id.clone(),
            browser_id: "a1b2c3d4".into(),
            local: local.clone(),
            lease: Lease::default(),
        });
        assert!(peer.active());
        // Represents a durable maintenance write during lifecycle handover.
        store::PairingStore::open(home.path())
            .unwrap()
            .revoke(Some(&id))
            .unwrap();
        tokio::time::timeout(Duration::from_millis(1500), peer.revoked())
            .await
            .unwrap();
        let reloaded = LocalAuth::open(home.path()).unwrap();
        assert!(!reloaded.store.persisted_active(&id));
        assert_eq!(
            reloaded.store.device(&id).unwrap().status,
            store::DeviceStatus::Revoked
        );
    }
}
