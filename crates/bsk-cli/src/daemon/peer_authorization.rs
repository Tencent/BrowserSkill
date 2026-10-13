//! Local HMAC and remote TLS/Bearer authorization share the business driver.
use super::local_auth::{LocalAuth, store::DeviceStatus};
use std::sync::Arc;

pub(crate) struct LocalPeer {
    pub device_id: String,
    pub browser_id: String,
    pub local: Arc<LocalAuth>,
}
pub(crate) enum PeerAuthorization {
    Legacy,
    Local(LocalPeer),
    Remote(super::remote::ConnectionAuthorization),
}
impl PeerAuthorization {
    pub fn browser_id<'a>(&'a self, claimed: &'a str) -> &'a str {
        match self {
            Self::Legacy => claimed,
            Self::Local(peer) => &peer.browser_id,
            Self::Remote(peer) => &peer.device.browser_id,
        }
    }
    pub fn active(&self) -> bool {
        match self {
            Self::Legacy => true,
            Self::Local(peer) => peer.local.store.device(&peer.device_id).is_some_and(|d| {
                d.status == DeviceStatus::Active
                    && d.browser_id.as_deref() == Some(&peer.browser_id)
            }),
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
            Self::Legacy => std::future::pending::<()>().await,
            Self::Remote(peer) => peer.revoked().await,
            Self::Local(peer) => {
                let mut changed = peer.local.store.changes();
                let mut timer = tokio::time::interval(std::time::Duration::from_secs(1));
                loop {
                    if !self.active() {
                        return;
                    }
                    tokio::select! { _ = changed.changed() => {}, _ = timer.tick() => {} }
                }
            }
        }
    }
    pub fn matches_instance(&self, instance: &str) -> bool {
        !matches!(self, Self::Local(peer) if peer.browser_id != instance)
    }
}
