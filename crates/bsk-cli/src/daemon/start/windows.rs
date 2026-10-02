//! Windows daemon startup: isolate handles and verify Job breakaway before
//! allowing the child to acquire the daemon lock or publish discovery metadata.

use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::Path;

use anyhow::{Context, Result};
use windows_sys::Win32::System::Threading::{
    CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED, DETACHED_PROCESS,
};

use super::{DAEMON_REPLACEMENT_WAIT_ENV, DAEMONIZED_ENV, StartArgs, apply_start_args};
use crate::daemon::start_error::DaemonStartFailure;
use crate::windows_process::{self, Process};

pub(super) fn spawn(exe: &Path, args: &StartArgs, predecessor_pid: Option<u32>) -> Result<Process> {
    let mut command = std::process::Command::new(exe);
    apply_start_args(&mut command, args);
    let command_line = command_line(std::iter::once(exe.as_os_str()).chain(command.get_args()));
    let mut env: Vec<_> = std::env::vars_os()
        .filter(|(key, _)| {
            let key = key.to_string_lossy();
            !key.eq_ignore_ascii_case(DAEMONIZED_ENV)
                && !key.eq_ignore_ascii_case(DAEMON_REPLACEMENT_WAIT_ENV)
        })
        .collect();
    env.push((DAEMONIZED_ENV.into(), "1".into()));
    if let Some(pid) = predecessor_pid {
        env.push((DAEMON_REPLACEMENT_WAIT_ENV.into(), pid.to_string().into()));
    }
    let input = File::open("NUL").context("open daemon stdin")?;
    let output = File::options()
        .write(true)
        .open("NUL")
        .context("open daemon output")?;
    let mut child = windows_process::spawn(
        exe.as_os_str(),
        &command_line,
        &env,
        [&input, &output, &output],
        DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB | CREATE_SUSPENDED,
    )
    .context(DaemonStartFailure::IndependentStartFailed)?;
    if let Err(err) = child.resume_outside_job() {
        // A suspended child must never be left behind if validation/resume fails.
        let _ = child.kill();
        let _ = child.wait();
        return Err(err).context(DaemonStartFailure::IndependentStartFailed);
    }
    Ok(child)
}

/// Whether [`spawn`] can start a daemon outside this process's Jobs. Creates
/// `exe` suspended with the same flags, checks it left every Job, and
/// terminates it without ever letting it run.
pub(super) fn check_breakaway(exe: &Path) -> Result<()> {
    let command_line = command_line([exe.as_os_str(), OsStr::new("--version")].into_iter());
    let env: Vec<_> = std::env::vars_os().collect();
    let input = File::open("NUL").context("open probe stdin")?;
    let output = File::options()
        .write(true)
        .open("NUL")
        .context("open probe output")?;
    let mut probe = windows_process::spawn(
        exe.as_os_str(),
        &command_line,
        &env,
        [&input, &output, &output],
        DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB | CREATE_SUSPENDED,
    )
    .context(DaemonStartFailure::IndependentStartFailed)?;
    let outside = probe.outside_job();
    let _ = probe.kill();
    let _ = probe.wait();
    if !outside.context("check the probe's Job membership")? {
        return Err(anyhow::anyhow!(
            "breakaway from an outer Job is not allowed"
        ))
        .context(DaemonStartFailure::IndependentStartFailed);
    }
    Ok(())
}

/// Quote argv directly for the Windows CRT, without invoking a shell. Preserve
/// UTF-16 paths, embedded quotes and backslashes before a closing quote.
pub(super) fn command_line<'a>(args: impl Iterator<Item = &'a OsStr>) -> OsString {
    let mut result = Vec::new();
    for arg in args {
        if !result.is_empty() {
            result.push(b' ' as u16);
        }
        result.push(b'"' as u16);
        let mut slashes = 0;
        for ch in arg.encode_wide() {
            if ch == b'\\' as u16 {
                slashes += 1;
                continue;
            }
            let count = if ch == b'"' as u16 {
                slashes * 2 + 1
            } else {
                slashes
            };
            result.extend(std::iter::repeat_n(b'\\' as u16, count));
            result.push(ch);
            slashes = 0;
        }
        result.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
        result.push(b'"' as u16);
    }
    OsString::from_wide(&result)
}
