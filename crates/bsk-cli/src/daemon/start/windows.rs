//! Windows daemon startup: isolate handles and verify Job breakaway before
//! allowing the child to acquire the daemon lock or publish discovery metadata.

use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::Path;

use anyhow::{Context, Result};
use windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED;
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
    .map_err(|err| spawn_failure(err, exe))?;
    // A nested Job may allow only partial breakaway, so a successful
    // CreateProcessW is not sufficient.
    let failure = match child.outside_job() {
        Ok(true) => match child.resume() {
            Ok(()) => return Ok(child),
            Err(err) => anyhow::Error::new(err).context(DaemonStartFailure::ResumeFailed),
        },
        Ok(false) => {
            anyhow::anyhow!("daemon is still associated with a host Job Object after breakaway")
                .context(DaemonStartFailure::PartialBreakaway)
        }
        Err(err) => anyhow::Error::new(err).context("check the daemon's Job membership"),
    };
    // A suspended child must never be left behind if validation/resume fails.
    let _ = child.kill();
    let _ = child.wait();
    Err(failure)
}

fn spawn_failure(err: io::Error, exe: &Path) -> anyhow::Error {
    let in_job = windows_process::current_process_in_job().unwrap_or(false);
    classify_spawn_failure(err, in_job, exe)
}

/// With CREATE_BREAKAWAY_FROM_JOB, CreateProcessW fails with access denied
/// when the immediate Job forbids breakaway. Any other error, or one raised
/// outside every Job, has a different cause.
fn classify_spawn_failure(err: io::Error, in_job: bool, exe: &Path) -> anyhow::Error {
    let refused = in_job && err.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32);
    let err = anyhow::Error::new(err);
    if refused {
        err.context(DaemonStartFailure::IndependentStartFailed)
    } else {
        err.context(format!("create daemon process {}", exe.display()))
    }
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
    .map_err(|err| spawn_failure(err, exe))?;
    let outside = probe.outside_job();
    let _ = probe.kill();
    let _ = probe.wait();
    if !outside.context("check the probe's Job membership")? {
        return Err(anyhow::anyhow!(
            "daemon probe is still associated with a host Job Object after breakaway"
        ))
        .context(DaemonStartFailure::PartialBreakaway);
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

#[cfg(test)]
mod tests {
    use windows_sys::Win32::Foundation::ERROR_FILE_NOT_FOUND;

    use super::*;

    fn classified(code: u32, in_job: bool) -> anyhow::Error {
        classify_spawn_failure(
            io::Error::from_raw_os_error(code as i32),
            in_job,
            Path::new(r"C:\bsk\bsk.exe"),
        )
    }

    #[test]
    fn only_access_denied_inside_a_job_is_a_breakaway_refusal() {
        assert!(matches!(
            classified(ERROR_ACCESS_DENIED, true).downcast_ref::<DaemonStartFailure>(),
            Some(DaemonStartFailure::IndependentStartFailed)
        ));
        for error in [
            classified(ERROR_ACCESS_DENIED, false),
            classified(ERROR_FILE_NOT_FOUND, true),
        ] {
            assert!(error.downcast_ref::<DaemonStartFailure>().is_none());
            let message = format!("{error:#}");
            assert!(
                message.contains(r"create daemon process C:\bsk\bsk.exe"),
                "{message}"
            );
            assert!(!message.contains("Job Object"), "{message}");
        }
    }
}
