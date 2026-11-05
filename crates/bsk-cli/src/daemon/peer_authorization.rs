//! Local HMAC and remote TLS/Bearer authorization share the business driver.
use super::local_auth::{LocalAuth, LocalAuthMode, store::DeviceStatus};
use std::sync::Arc;

pub(crate) struct LocalPeer {
    pub device_id: String,
    pub browser_id: String,
    pub local: Arc<LocalAuth>,
    pub lease: super::local_auth::lifecycle::Lease,
}
pub(crate) enum PeerAuthorization {
    Legacy {
        local: Arc<LocalAuth>,
        instance: Option<String>,
    },
    Local(LocalPeer),
    Remote(super::remote::ConnectionAuthorization),
}
impl PeerAuthorization {
    pub fn browser_id<'a>(&'a self, claimed: &'a str) -> &'a str {
        match self {
            Self::Legacy { .. } => claimed,
            Self::Local(peer) => &peer.browser_id,
            Self::Remote(peer) => &peer.device.browser_id,
        }
    }
    pub fn active(&self) -> bool {
        match self {
            Self::Legacy { local, instance } => {
                let mode = local.mode();
                mode.accepts_legacy()
                    && (mode == LocalAuthMode::TrustLocal
                        || instance
                            .as_deref()
                            .is_none_or(|id| !local.store.has_paired_browser(id)))
            }
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
        let local = match self {
            Self::Legacy { local, .. } | Self::Local(LocalPeer { local, .. }) => local,
            Self::Remote(peer) => return peer.revoked().await,
        };
        let mut changed = local.store.changes();
        let mut lifecycle = local.lifecycle.changes();
        while self.active() {
            tokio::select! {
                _ = changed.changed() => {},
                _ = lifecycle.changed() => {},
            }
        }
    }
    pub async fn registration_guard(
        &self,
    ) -> Option<(
        Option<tokio::sync::OwnedMutexGuard<()>>,
        tokio::sync::OwnedMutexGuard<()>,
    )> {
        let (device, local) = match self {
            Self::Local(peer) => (
                Some(peer.local.device_gate(&peer.device_id).lock_owned().await),
                &peer.local,
            ),
            Self::Legacy { local, .. } => (None, local),
            Self::Remote(_) => return None,
        };
        let registry = local.lifecycle.registry_gate.clone().lock_owned().await;
        Some((device, registry))
    }
    pub fn register(&self, client: &Arc<super::browsers::BrowserClient>) {
        if let Self::Local(peer) = self {
            peer.local
                .lifecycle
                .register(&peer.device_id, &peer.lease, client);
        }
    }
    pub fn bind_instance(&mut self, claimed: &str) -> bool {
        match self {
            Self::Local(peer) => peer.browser_id == claimed,
            Self::Legacy { instance, .. } => {
                *instance = Some(claimed.to_owned());
                self.active()
            }
            Self::Remote(_) => true,
        }
    }
}

impl Drop for LocalPeer {
    fn drop(&mut self) {
        self.local.lifecycle.closed(&self.device_id, &self.lease);
    }
}
