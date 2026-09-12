//! Verify the daemon lock is exclusive: a second acquire in the same
//! process must fail while the first is held, and pid-alive helpers work.

use std::sync::Mutex;

use bsk::daemon::lockfile::{acquire, pid_alive};
use bsk::daemon::paths::BSK_HOME_ENV;
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
fn second_acquire_in_same_process_fails() {
    with_temp_home(|| {
        let _first = acquire().expect("first acquire");
        let second = acquire();
        assert!(
            second.is_err(),
            "second acquire should fail while first is held"
        );
        drop(_first);
        let third = acquire().expect("third acquire after release");
        drop(third);
    });
}

#[test]
fn pid_alive_for_current_process() {
    let me = std::process::id();
    assert!(pid_alive(me));
}

#[test]
fn pid_alive_for_nonexistent_pid() {
    // A pid that's almost certainly not in use (max u32 is way beyond
    // typical kernel pid limits, but we pick a high-ish value to be
    // conservative). On Unix kill(0) returns ESRCH for unknown pids.
    let highly_improbable: u32 = 0x7fff_fffe;
    assert!(!pid_alive(highly_improbable));
}
