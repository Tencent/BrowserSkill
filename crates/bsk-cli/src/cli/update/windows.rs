//! Launch the update helper with only its stdio handles inherited.
//!
//! std::process::Command on Windows also inherits other inheritable handles.
//! A daemon's listening socket must not survive in the helper: it would keep
//! the port occupied after the daemon exits and prevent its replacement starting.

use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::ExitStatusExt;
use std::path::Path;
use std::process::ExitStatus;

use windows_sys::Win32::Foundation::{
    HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess,
    InitializeProcThreadAttributeList, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject,
};

pub(super) struct Helper(OwnedHandle);

impl Helper {
    pub(super) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        // SAFETY: the owned process handle remains valid for both calls.
        match unsafe { WaitForSingleObject(self.0.as_raw_handle(), 0) } {
            WAIT_OBJECT_0 => {
                let mut code = 0;
                if unsafe { GetExitCodeProcess(self.0.as_raw_handle(), &mut code) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(Some(ExitStatus::from_raw(code)))
            }
            WAIT_TIMEOUT => Ok(None),
            _ => Err(io::Error::last_os_error()),
        }
    }

    pub(super) fn kill(&mut self) -> io::Result<()> {
        // SAFETY: this handle belongs to the helper we created.
        if unsafe { TerminateProcess(self.0.as_raw_handle(), 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(super) fn wait(&mut self) -> io::Result<()> {
        // Only used after kill(); do not leave a live helper on startup failure.
        if unsafe { WaitForSingleObject(self.0.as_raw_handle(), 5000) } != WAIT_OBJECT_0 {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "update helper did not exit",
            ));
        }
        Ok(())
    }
}

// The opaque attribute list needs pointer-aligned storage and explicit teardown.
struct AttributeList(Vec<usize>);

impl Drop for AttributeList {
    fn drop(&mut self) {
        // SAFETY: this wrapper is constructed only after successful initialization.
        unsafe { DeleteProcThreadAttributeList(self.0.as_mut_ptr().cast()) };
    }
}

pub(super) fn spawn(
    script: &Path,
    source: &Path,
    target: &Path,
    ready: &Path,
    log_path: &Path,
) -> io::Result<Helper> {
    let root = std::env::var_os("SystemRoot")
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "SystemRoot is not set"))?;
    let application = wide(Path::new(&root).join("System32/cmd.exe").as_os_str());
    // /S /C strips one outer pair of quotes. Environment expansion keeps paths
    // Unicode and avoids CRT escaping, batch-file encoding, and CALL expansion.
    let mut command = wide(OsStr::new(
        "cmd.exe /D /V:OFF /S /C \"\"%BSK_UPDATE_SCRIPT%\"\"",
    ));
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
    env.sort_by_key(|(key, _)| key.to_string_lossy().to_uppercase());
    let mut environment = Vec::new();
    for (key, value) in env {
        environment.extend(key.encode_wide());
        environment.push(b'=' as u16);
        environment.extend(value.encode_wide());
        environment.push(0);
    }
    environment.push(0);

    let input = File::open("NUL")?;
    let log = File::create(log_path)?;
    let handles: [HANDLE; 2] = [input.as_raw_handle(), log.as_raw_handle()];
    for &handle in &handles {
        // SAFETY: these are dedicated helper stdio handles, held until spawn
        // finishes. The explicit handle list excludes every other parent handle.
        if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0 {
            return Err(io::Error::last_os_error());
        }
    }

    let mut size = 0;
    // SAFETY: the first call queries the allocation size, as required by Win32.
    unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
    if size == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut storage = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
    // SAFETY: storage has the requested size and pointer alignment.
    if unsafe { InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), 1, 0, &mut size) }
        == 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut attributes = AttributeList(storage);
    // SAFETY: the handle array and attribute storage outlive CreateProcessW.
    if unsafe {
        UpdateProcThreadAttribute(
            attributes.0.as_mut_ptr().cast(),
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            handles.as_ptr().cast(),
            std::mem::size_of_val(&handles),
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: these Win32 structs permit zero initialization; required fields
    // are populated below before the process is created.
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = handles[0];
    startup.StartupInfo.hStdOutput = handles[1];
    startup.StartupInfo.hStdError = handles[1];
    startup.lpAttributeList = attributes.0.as_mut_ptr().cast();
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: strings are NUL-terminated UTF-16, the environment is double-NUL
    // terminated, and all buffers/handles remain alive for the duration of spawn.
    if unsafe {
        CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            CREATE_NO_WINDOW
                | CREATE_NEW_PROCESS_GROUP
                | CREATE_UNICODE_ENVIRONMENT
                | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr().cast(),
            std::ptr::null(),
            &startup.StartupInfo,
            &mut process,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful CreateProcessW transfers these two handles to us.
    let _thread = unsafe { OwnedHandle::from_raw_handle(process.hThread) };
    Ok(Helper(unsafe {
        OwnedHandle::from_raw_handle(process.hProcess)
    }))
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}
