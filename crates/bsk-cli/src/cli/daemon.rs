//! `bsk daemon …` subcommand surface.

use std::time::Duration;

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
    /// Start the daemon (auto-detaches unless `--foreground`).
    Start(StartArgs),

    /// Stop a running daemon by reading `~/.bsk/daemon.json`.
    Stop,

    /// Stop then start the daemon.
    Restart(StartArgs),
}

#[derive(Debug, Clone, Default, clap::Args)]
pub struct StartArgs {
    /// Override the WebSocket port (default 52800).
    #[arg(long, value_name = "PORT")]
    pub port: Option<u16>,

    /// Run in the foreground (do not double-fork). Useful for development.
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
    let dur = match unit_part {
        "" | "s" => Duration::from_secs(num),
        "ms" => Duration::from_millis(num),
        "m" => Duration::from_secs(num * 60),
        "h" => Duration::from_secs(num * 60 * 60),
        other => return Err(format!("unknown duration unit `{other}`")),
    };
    Ok(dur)
}

pub fn dispatch(cmd: DaemonCmd) -> anyhow::Result<()> {
    match cmd {
        DaemonCmd::Start(args) => daemon::start::run_start(args),
        DaemonCmd::Stop => daemon::start::run_stop(),
        DaemonCmd::Restart(args) => {
            daemon::start::run_stop().map_err(|e| e.context("restart failed during stop phase"))?;
            daemon::start::run_start(args)
        }
    }
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
    fn parse_duration_rejects_bad_unit() {
        assert!(parse_duration("10x").is_err());
        assert!(parse_duration("").is_err());
    }
}
