//! Bounded per-peer accounting with shared overflow and total-work budgets.
use std::collections::HashMap;
use std::net::IpAddr;
use std::time::{Duration, Instant};

const WINDOW: Duration = Duration::from_secs(60);
const MAX_PEERS: usize = 1024;

struct Bucket {
    start: Instant,
    used: u32,
}

impl Bucket {
    fn new(now: Instant) -> Self {
        Self {
            start: now,
            used: 0,
        }
    }

    fn take(&mut self, now: Instant, limit: u32) -> bool {
        if now.duration_since(self.start) >= WINDOW {
            *self = Self::new(now);
        }
        if self.used >= limit {
            return false;
        }
        self.used += 1;
        true
    }
}

pub(super) struct AuthorizationRateLimit {
    per_peer: u32,
    peers: HashMap<IpAddr, Bucket>,
    overflow: Bucket,
    total: Bucket,
}

impl AuthorizationRateLimit {
    pub fn new(per_peer: u32) -> Self {
        let now = Instant::now();
        Self {
            per_peer,
            peers: HashMap::new(),
            overflow: Bucket::new(now),
            total: Bucket::new(now),
        }
    }

    pub fn allow(&mut self, peer: IpAddr, now: Instant) -> bool {
        self.peers
            .retain(|_, bucket| now.duration_since(bucket.start) < WINDOW);
        let allowed = if self.peers.len() < MAX_PEERS || self.peers.contains_key(&peer) {
            self.peers
                .entry(peer)
                .or_insert_with(|| Bucket::new(now))
                .take(now, self.per_peer)
        } else {
            // New peers still have a bounded opportunity to pair. Do not evict
            // existing counters: that would reset their abuse budgets.
            self.overflow.take(now, self.per_peer)
        };
        // A peer already over its own limit must not exhaust everyone else's
        // budget by repeating rejected requests. Rotating addresses is bounded too.
        allowed && self.total.take(now, self.per_peer.saturating_mul(16))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(id: u32) -> IpAddr {
        std::net::Ipv4Addr::from(id).into()
    }

    #[test]
    fn full_table_uses_overflow_without_resetting_existing_peers() {
        let mut limit = AuthorizationRateLimit::new(100);
        let now = Instant::now();
        for id in 0..MAX_PEERS as u32 {
            assert!(limit.allow(peer(id), now));
        }
        for _ in 1..100 {
            assert!(limit.allow(peer(0), now));
        }
        assert!(!limit.allow(peer(0), now));
        for id in 2000..2100 {
            assert!(limit.allow(peer(id), now));
        }
        assert!(!limit.allow(peer(2100), now));
        assert!(!limit.allow(peer(0), now));
        assert_eq!(limit.peers.len(), MAX_PEERS);
        assert!(limit.allow(peer(2100), now + WINDOW));
        assert_eq!(limit.peers.len(), 1);
    }

    #[test]
    fn rotating_addresses_cannot_exceed_the_total_budget() {
        let mut limit = AuthorizationRateLimit::new(2);
        let now = Instant::now();
        for id in 0..32 {
            assert!(limit.allow(peer(id), now));
        }
        assert!(!limit.allow(peer(33), now));
        assert!(limit.allow(peer(33), now + WINDOW));
    }

    #[test]
    fn proxy_clients_share_the_configured_peer_budget() {
        let mut limit = AuthorizationRateLimit::new(2);
        let now = Instant::now();
        assert!(limit.allow(peer(1), now));
        assert!(limit.allow(peer(1), now));
        assert!(!limit.allow(peer(1), now));
        assert!(limit.allow(peer(2), now));
        assert!(limit.allow(peer(1), now + WINDOW));
    }

    #[test]
    fn rejected_peer_requests_do_not_exhaust_the_shared_budget() {
        let mut limit = AuthorizationRateLimit::new(2);
        let now = Instant::now();
        assert!(limit.allow(peer(1), now));
        assert!(limit.allow(peer(1), now));
        for _ in 0..1000 {
            assert!(!limit.allow(peer(1), now));
        }
        assert!(limit.allow(peer(2), now));
    }
}
