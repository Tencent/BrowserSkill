//! `bsk daemon …` subcommand surface.

use std::{net::IpAddr, path::PathBuf, time::Duration};

use clap::Subcommand;

use crate::daemon;

/// Default WebSocket port the daemon listens on.
pub const DEFAULT_WS_PORT: u16 = 52800;
/// Default daemon idle timeout (10 minutes per design §3.2).
pub const DEFAULT_DAEMON_IDLE: Duration = Duration::from_secs(10 * 60);
/// Default session idle timeout (5 minutes per design §5).
pub const DEFAULT_SESSION_IDLE: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Subcommand)]
pub enum DaemonCmd {
    /// Start the daemon (server mode stays in the foreground).
    Start(StartArgs),

    /// Stop a running daemon by reading `~/.bsk/daemon.json`.
    Stop,

    /// Stop then start the daemon.
    Restart(StartArgs),

    /// Generate a one-use remote browser pairing link.
    Pair,

    /// List paired remote browsers (no credentials are displayed).
    Devices,

    /// Revoke a device grant, or all grants and outstanding pairing links.
    Revoke {
        #[arg(required_unless_present = "all", conflicts_with = "all")]
        device_id: Option<String>,
        #[arg(long)]
        all: bool,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, clap::ValueEnum)]
pub enum DaemonMode {
    #[default]
    Local,
    Server,
}

#[derive(Debug, Clone, Default, clap::Args)]
pub struct StartArgs {
    /// Server mode exposes an authenticated extension endpoint and stays in the foreground.
    #[arg(long, value_enum, default_value_t)]
    pub mode: DaemonMode,

    /// Server listener IP. Defaults to loopback; non-loopback requires TLS.
    #[arg(long)]
    pub listen: Option<IpAddr>,
    /// Public WebSocket URL, including its path, used in pairing links.
    #[arg(long)]
    pub public_url: Option<String>,
    #[arg(long, requires = "tls_key")]
    pub tls_cert: Option<PathBuf>,
    #[arg(long, requires = "tls_cert")]
    pub tls_key: Option<PathBuf>,
    /// One-use pairing lifetime, default 5m (maximum 1h).
    #[arg(long, value_parser = parse_duration)]
    pub pairing_ttl: Option<Duration>,
    /// Renewable device grant lifetime, default 90d.
    #[arg(long, value_parser = parse_duration)]
    pub device_ttl: Option<Duration>,
    /// Renew device grants after this interval, default 30d.
    #[arg(long, value_parser = parse_duration)]
    pub renew_after: Option<Duration>,
    /// Maximum online remote browsers, default 64. Pairing and renewal use separate capacity.
    #[arg(long)]
    pub max_connections: Option<usize>,
    /// Authorization requests per minute per peer IP, default 60 (shared behind a proxy).
    #[arg(long)]
    pub authorize_rate_limit: Option<u32>,
    /// Override the WebSocket port (default 52800).
    #[arg(long, value_name = "PORT")]
    pub port: Option<u16>,

    /// Run in the foreground, owned by the current terminal or supervisor.
    #[arg(long)]
    pub foreground: bool,

    /// Session idle timeout, e.g. `5m`, `30s`. Default 5 minutes.
    #[arg(long, value_name = "DURATION", value_parser = parse_duration)]
    pub session_idle: Option<Duration>,

    /// Daemon idle timeout, e.g. `10m`, `2s`. Default 10 minutes.
    #[arg(long, value_name = "DURATION", value_parser = parse_duration)]
    pub daemon_idle: Option<Duration>,
}

impl StartArgs {
    pub fn server_config(&self) -> anyhow::Result<Option<daemon::remote::ServerConfig>> {
        if self.mode == DaemonMode::Local {
            anyhow::ensure!(
                self.listen.is_none()
                    && self.public_url.is_none()
                    && self.tls_cert.is_none()
                    && self.tls_key.is_none()
                    && self.pairing_ttl.is_none()
                    && self.device_ttl.is_none()
                    && self.renew_after.is_none()
                    && self.max_connections.is_none()
                    && self.authorize_rate_limit.is_none(),
                "remote endpoint flags require --mode server"
            );
            return Ok(None);
        }
        anyhow::ensure!(
            self.daemon_idle.is_none(),
            "server mode stays running; omit --daemon-idle"
        );
        let url = self
            .public_url
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("server mode requires --public-url"))?;
        let config = daemon::remote::ServerConfig {
            listen: self.listen.unwrap_or_else(|| "127.0.0.1".parse().unwrap()),
            public_url: daemon::remote::validate_endpoint(url)?.to_string(),
            tls_cert: self.tls_cert.clone(),
            tls_key: self.tls_key.clone(),
            pairing_ttl: self.pairing_ttl.unwrap_or(Duration::from_secs(300)),
            device_ttl: self.device_ttl.unwrap_or(Duration::from_secs(90 * 86400)),
            renew_after: self.renew_after.unwrap_or(Duration::from_secs(30 * 86400)),
            max_connections: self.max_connections.unwrap_or(64),
            authorize_rate_limit: self.authorize_rate_limit.unwrap_or(60),
        };
        config.validate()?;
        Ok(Some(config))
    }
    pub fn resolved_port(&self) -> u16 {
        self.port.unwrap_or(DEFAULT_WS_PORT)
    }

    pub fn resolved_session_idle(&self) -> Duration {
        self.session_idle.unwrap_or(DEFAULT_SESSION_IDLE)
    }

    pub fn resolved_daemon_idle(&self) -> Duration {
        self.daemon_idle.unwrap_or(DEFAULT_DAEMON_IDLE)
    }
}

/// Parse short human durations (`5s`, `30m`, `2h`, `750ms`).
pub fn parse_duration(s: &str) -> Result<Duration, String> {
    let s = s.trim();
    if s.is_empty() {
        return Err("empty duration".to_string());
    }

    let split = s.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(s.len());
    let (num_part, unit_part) = s.split_at(split);
    let num: u64 = num_part
        .parse()
        .map_err(|e| format!("invalid number `{num_part}`: {e}"))?;
    if unit_part == "ms" {
        return Ok(Duration::from_millis(num));
    }
    let multiplier = match unit_part {
        "" | "s" => 1,
        "m" => 60,
        "h" => 3600,
        "d" => 86400,
        other => return Err(format!("unknown duration unit `{other}`")),
    };
    num.checked_mul(multiplier)
        .map(Duration::from_secs)
        .ok_or_else(|| "duration is too large".into())
}

pub fn dispatch(cmd: DaemonCmd) -> anyhow::Result<()> {
    match cmd {
        DaemonCmd::Start(args) => daemon::start::run_start(args),
        DaemonCmd::Stop => daemon::start::run_stop(),
        DaemonCmd::Restart(args) => {
            args.server_config()?;
            daemon::start::run_stop().map_err(|e| e.context("restart failed during stop phase"))?;
            daemon::start::run_start(args)
        }
        DaemonCmd::Pair => {
            println!("{}", authorization_store()?.pair()?);
            Ok(())
        }
        DaemonCmd::Devices => {
            println!(
                "{}",
                serde_json::to_string_pretty(&authorization_store()?.devices()?)?
            );
            Ok(())
        }
        DaemonCmd::Revoke { device_id, all } => {
            let store = authorization_store()?;
            if all {
                store.revoke_all()?;
            } else {
                anyhow::ensure!(
                    store.revoke(device_id.as_deref().unwrap_or_default())?,
                    "device grant not found"
                );
            }
            println!("Authorization revoked");
            Ok(())
        }
    }
}

fn authorization_store() -> anyhow::Result<daemon::remote::authorization::AuthorizationStore> {
    Ok(daemon::remote::authorization::AuthorizationStore::at_home(
        &daemon::paths::ensure_bsk_home()?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_duration_seconds_default() {
        assert_eq!(parse_duration("5").unwrap(), Duration::from_secs(5));
        assert_eq!(parse_duration("30s").unwrap(), Duration::from_secs(30));
    }

    #[test]
    fn parse_duration_units() {
        assert_eq!(parse_duration("750ms").unwrap(), Duration::from_millis(750));
        assert_eq!(parse_duration("2m").unwrap(), Duration::from_secs(120));
        assert_eq!(parse_duration("1h").unwrap(), Duration::from_secs(3600));
    }

    #[test]
    fn server_configuration_has_safe_defaults_and_rejects_unsafe_flags() {
        assert!(StartArgs::default().server_config().unwrap().is_none());
        let mut args = StartArgs {
            mode: DaemonMode::Server,
            public_url: Some("wss://browser.example/extension".into()),
            ..Default::default()
        };
        let config = args.server_config().unwrap().unwrap();
        assert!(config.listen.is_loopback());
        assert_eq!(config.pairing_ttl, Duration::from_secs(300));
        assert_eq!(config.device_ttl, Duration::from_secs(90 * 86400));
        assert_eq!(config.max_connections, 64);
        assert_eq!(config.authorize_rate_limit, 60);
        args.listen = Some("0.0.0.0".parse().unwrap());
        assert!(args.server_config().is_err());
        args.tls_cert = Some("cert.pem".into());
        args.tls_key = Some("key.pem".into());
        assert!(args.server_config().is_ok());
        args.mode = DaemonMode::Local;
        assert!(args.server_config().is_err());
        for url in [
            "ws://browser.example/extension",
            "wss://user:password@browser.example/extension",
            "wss://browser.example/extension?token=abc",
            "wss://browser.example/extension#abc",
        ] {
            assert!(daemon::remote::validate_endpoint(url).is_err());
        }
        args = StartArgs {
            mode: DaemonMode::Server,
            public_url: Some("ws://127.0.0.1:52800/extension".into()),
            ..Default::default()
        };
        args.renew_after = Some(Duration::from_secs(90 * 86400));
        assert!(args.server_config().is_err());
        args.renew_after = None;
        args.pairing_ttl = Some(Duration::from_millis(1500));
        assert!(args.server_config().is_err());
        assert!(parse_duration("18446744073709551615d").is_err());
    }

    #[test]
    fn server_resource_limits_are_bounded_and_server_only() {
        let mut args = StartArgs {
            mode: DaemonMode::Server,
            public_url: Some("wss://browser.example/extension".into()),
            ..Default::default()
        };
        for limit in [0, 1001] {
            args.max_connections = Some(limit);
            assert!(args.server_config().is_err());
        }
        args.max_connections = Some(128);
        for limit in [0, 60_001] {
            args.authorize_rate_limit = Some(limit);
            assert!(args.server_config().is_err());
        }
        args.authorize_rate_limit = Some(600);
        let config = args.server_config().unwrap().unwrap();
        assert_eq!(config.max_connections, 128);
        assert_eq!(config.authorize_rate_limit, 600);
        args.mode = DaemonMode::Local;
        assert!(args.server_config().is_err());
    }

    #[test]
    fn parse_duration_rejects_bad_unit() {
        assert!(parse_duration("10x").is_err());
        assert!(parse_duration("").is_err());
    }
}
