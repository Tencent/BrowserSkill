//! End-to-end round trip through `info::write` / `info::read` honoring
//! the `BSK_HOME` env var.

use std::sync::Mutex;

use bsk::daemon::info::{self, DaemonInfo};
use bsk::daemon::paths::{self, BSK_HOME_ENV};
use tempfile::TempDir;

fn env_guard() -> &'static Mutex<()> {
    static GUARD: Mutex<()> = Mutex::new(());
    &GUARD
}

fn with_temp_home<F: FnOnce()>(f: F) {
    let _lock = env_guard().lock().unwrap_or_else(|e| e.into_inner());
    let tmp = TempDir::new().unwrap();
    unsafe {
        std::env::set_var(BSK_HOME_ENV, tmp.path().join("bsk"));
    }
    f();
    unsafe {
        std::env::remove_var(BSK_HOME_ENV);
    }
    drop(tmp);
}

#[test]
fn read_returns_none_before_any_write() {
    with_temp_home(|| {
        let _home = paths::ensure_bsk_home().unwrap();
        assert!(info::read().unwrap().is_none());
    });
}

#[test]
fn write_then_read_round_trip() {
    with_temp_home(|| {
        let home = paths::ensure_bsk_home().unwrap();
        let info = DaemonInfo::now(
            std::process::id(),
            home.join("run").join("daemon.sock"),
            52810,
            env!("CARGO_PKG_VERSION"),
        );
        info::write(&info).unwrap();
        let parsed = info::read().unwrap().expect("info should exist");
        assert_eq!(parsed, info);
    });
}

#[test]
fn read_valid_filters_stale_pids() {
    with_temp_home(|| {
        let home = paths::ensure_bsk_home().unwrap();
        let stale = DaemonInfo::now(
            0x7fff_fffe,
            home.join("run").join("daemon.sock"),
            52810,
            "stale",
        );
        info::write(&stale).unwrap();
        assert!(
            info::read_valid().unwrap().is_none(),
            "read_valid must filter out a stale pid"
        );
    });
}

#[test]
fn remove_is_idempotent() {
    with_temp_home(|| {
        let _home = paths::ensure_bsk_home().unwrap();
        info::remove().unwrap();
        let info = DaemonInfo::now(std::process::id(), "/tmp/x".into(), 52810, "x");
        info::write(&info).unwrap();
        info::remove().unwrap();
        info::remove().unwrap();
        assert!(info::read().unwrap().is_none());
    });
}
