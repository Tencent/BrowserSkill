//! Local HMAC and remote TLS/Bearer authorization share the business driver.
use super::local_auth::{LocalAuth, store::DeviceStatus};
use std::sync::Arc;

pub(crate) struct LocalPeer {
    pub device_id: String,
    pub browser_id: String,
    pub local: Arc<LocalAuth>,
    pub lease: super::local_auth::lifecycle::Lease,
}
pub(crate) enum PeerAuthorization {
    Legacy(Arc<LocalAuth>),
    Local(LocalPeer),
    Remote(super::remote::ConnectionAuthorization),
}
impl PeerAuthorization {
    pub fn browser_id<'a>(&'a self, claimed: &'a str) -> &'a str {
        match self {
            Self::Legacy(_) => claimed,
            Self::Local(peer) => &peer.browser_id,
            Self::Remote(peer) => &peer.device.browser_id,
        }
    }
    pub fn active(&self) -> bool {
        match self {
            Self::Legacy(local) => local.mode().accepts_legacy(),
            Self::Local(peer) => {
                peer.lease.active()
                    && peer.local.store.device(&peer.device_id).is_some_and(|d| {
                        d.status == DeviceStatus::Active
                            && d.browser_id.as_deref() == Some(&peer.browser_id)
                    })
            }
            Self::Remote(peer) => peer.active(),
        }
    }
    pub async fn authorized(&self) -> bool {
        match self {
            Self::Remote(peer) => peer.authorized().await,
            _ => self.active(),
        }
    }
    pub async fn revoked(&self) {
        match self {
            Self::Legacy(local) => {
                let mut changed = local.lifecycle.changes();
                while self.active() {
                    if changed.changed().await.is_err() {
                        return;
                    }
                }
            }
            Self::Remote(peer) => peer.revoked().await,
            Self::Local(peer) => {
                let mut changed = peer.local.store.changes();
                let mut lifecycle = peer.local.lifecycle.changes();
                let mut timer = tokio::time::interval(std::time::Duration::from_secs(1));
                loop {
                    if !self.active() {
                        return;
                    }
                    tokio::select! {
                        _ = changed.changed() => {}, _ = lifecycle.changed()=>{},
                        _ = timer.tick() => {
                            let local=peer.local.clone();let id=peer.device_id.clone();
                            if !tokio::task::spawn_blocking(move ||local.store.persisted_active(&id)).await.unwrap_or(false) {return;}
                        }
                    }
                }
            }
        }
    }
    pub async fn registration_guard(
        &self,
    ) -> Option<(
        tokio::sync::OwnedMutexGuard<()>,
        tokio::sync::OwnedMutexGuard<()>,
    )> {
        if let Self::Local(peer) = self {
            let device = peer.local.device_gate(&peer.device_id).lock_owned().await;
            let registry = peer
                .local
                .lifecycle
                .registry_gate
                .clone()
                .lock_owned()
                .await;
            Some((device, registry))
        } else {
            None
        }
    }
    pub fn register(&self, client: &Arc<super::browsers::BrowserClient>) {
        if let Self::Local(peer) = self {
            peer.local
                .lifecycle
                .register(&peer.device_id, &peer.lease, client);
        }
    }
    pub fn matches_instance(&self, instance: &str) -> bool {
        !matches!(self, Self::Local(peer) if peer.browser_id != instance)
    }
}

impl Drop for LocalPeer {
    fn drop(&mut self) {
        self.local.lifecycle.closed(&self.device_id, &self.lease);
    }
}
