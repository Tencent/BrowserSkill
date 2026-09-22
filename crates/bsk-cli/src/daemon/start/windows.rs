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
use crate::windows_process::{self, Process};

const DETACH_HINT: &str = "cannot start an independent Windows daemon; the host may prohibit Job Object breakaway. \
    Run `bsk daemon start --foreground` in a persistent host task outside the per-command Job, \
    or start the daemon from an independent terminal, using the same BSK_HOME and OS user. \
    Then use BSK_AUTO_START=0 in the agent";

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
    .context(DETACH_HINT)?;
    if let Err(err) = child.resume_outside_job() {
        // A suspended child must never be left behind if validation/resume fails.
        let _ = child.kill();
        let _ = child.wait();
        return Err(err).context(DETACH_HINT);
    }
    Ok(child)
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
