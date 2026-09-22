//! The update helper inherits only its dedicated stdio handles. Keep its
//! existing Job policy: daemon startup separately requires verified breakaway.

use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::path::Path;

use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW};

use crate::windows_process;
pub(super) use crate::windows_process::Process as Helper;

pub(super) fn spawn(
    script: &Path,
    source: &Path,
    target: &Path,
    ready: &Path,
    log_path: &Path,
) -> io::Result<Helper> {
    let root = std::env::var_os("SystemRoot")
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "SystemRoot is not set"))?;
    let application = Path::new(&root).join("System32/cmd.exe");
    // /S /C strips one outer pair of quotes. Environment expansion keeps paths
    // Unicode and avoids CRT escaping, batch-file encoding, and CALL expansion.
    let command = OsStr::new("cmd.exe /D /V:OFF /S /C \"\"%BSK_UPDATE_SCRIPT%\"\"");
    let overrides = [
        ("BSK_UPDATE_SCRIPT", script.as_os_str()),
        ("BSK_UPDATE_SOURCE", source.as_os_str()),
        ("BSK_UPDATE_TARGET", target.as_os_str()),
        ("BSK_UPDATE_READY", ready.as_os_str()),
        ("BSK_UPDATE_LOG", log_path.as_os_str()),
    ];
    let mut env: Vec<_> = std::env::vars_os()
        .filter(|(key, _)| {
            let key = key.to_string_lossy();
            !overrides
                .iter()
                .any(|(name, _)| key.eq_ignore_ascii_case(name))
                && !key.eq_ignore_ascii_case(crate::daemon::start::DAEMONIZED_ENV)
                && !key.eq_ignore_ascii_case(crate::daemon::start::DAEMON_REPLACEMENT_WAIT_ENV)
        })
        .collect();
    env.extend(
        overrides
            .into_iter()
            .map(|(key, value)| (key.into(), value.to_owned())),
    );
    let input = File::open("NUL")?;
    let log = File::create(log_path)?;
    windows_process::spawn(
        application.as_os_str(),
        command,
        &env,
        [&input, &log, &log],
        CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP,
    )
}
