//! Optional authenticated extension endpoint. Automation still uses local IPC.

pub mod authorization;
mod rate_limit;
mod server;

use std::net::IpAddr;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Result, ensure};
use reqwest::Url;

pub(crate) use server::ConnectionAuthorization;
pub use server::bind;

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub listen: IpAddr,
    pub public_url: String,
    pub tls_cert: Option<PathBuf>,
    pub tls_key: Option<PathBuf>,
    pub pairing_ttl: Duration,
    pub device_ttl: Duration,
    pub renew_after: Duration,
    pub max_connections: usize,
    pub authorize_rate_limit: u32,
}

impl ServerConfig {
    pub fn validate(&self) -> Result<()> {
        validate_endpoint(&self.public_url)?;
        ensure!(
            (1..=1000).contains(&self.max_connections),
            "--max-connections must be between 1 and 1000"
        );
        ensure!(
            (1..=60_000).contains(&self.authorize_rate_limit),
            "--authorize-rate-limit must be between 1 and 60000"
        );
        ensure!(
            [self.pairing_ttl, self.device_ttl, self.renew_after]
                .iter()
                .all(|duration| duration.subsec_nanos() == 0),
            "authorization lifetimes must use whole seconds"
        );
        ensure!(
            self.tls_cert.is_some() == self.tls_key.is_some(),
            "provide both --tls-cert and --tls-key"
        );
        ensure!(
            self.listen.is_loopback() || self.tls_cert.is_some(),
            "a non-loopback listener requires TLS; bind to loopback behind a TLS reverse proxy"
        );
        ensure!(
            self.tls_cert.is_none() || self.public_url.starts_with("wss:"),
            "TLS requires a wss:// public URL"
        );
        ensure!(
            self.pairing_ttl.as_secs() > 0 && self.pairing_ttl.as_secs() <= 3600,
            "pairing lifetime must be between 1 second and 1 hour"
        );
        ensure!(
            self.renew_after.as_secs() > 0 && self.renew_after < self.device_ttl,
            "renewal must occur before device expiry"
        );
        ensure!(
            self.device_ttl.as_secs() <= 366 * 86400,
            "device lifetime must not exceed 366 days"
        );
        Ok(())
    }
}

pub fn validate_endpoint(input: &str) -> Result<Url> {
    let url = Url::parse(input)?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    ensure!(
        url.scheme() == "wss" || (url.scheme() == "ws" && loopback),
        "public URL requires WSS (WS is allowed only on loopback)"
    );
    ensure!(
        url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "public URL must not contain credentials, query parameters or fragments"
    );
    Ok(url)
}
