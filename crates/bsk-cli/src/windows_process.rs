//! Native process creation with an explicit handle inheritance list.
//!
//! Redirecting stdio alone does not stop other inheritable handles (including
//! a caller's output pipes or a daemon's listening socket) reaching a child.

use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::ExitStatusExt;
use std::process::ExitStatus;

use windows_sys::Win32::Foundation::{
    DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::JobObjects::IsProcessInJob;
use windows_sys::Win32::System::Threading::{
    CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
    EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess, GetExitCodeProcess, GetProcessId,
    InitializeProcThreadAttributeList, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION,
    ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess,
    UpdateProcThreadAttribute, WaitForSingleObject,
};

pub(crate) struct Process {
    handle: OwnedHandle,
    thread: OwnedHandle,
}

impl Process {
    pub(crate) fn id(&self) -> u32 {
        // SAFETY: the owned process handle remains valid for the call.
        unsafe { GetProcessId(self.handle.as_raw_handle()) }
    }

    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        // SAFETY: the owned process handle remains valid for both calls.
        match unsafe { WaitForSingleObject(self.handle.as_raw_handle(), 0) } {
            WAIT_OBJECT_0 => {
                let mut code = 0;
                if unsafe { GetExitCodeProcess(self.handle.as_raw_handle(), &mut code) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(Some(ExitStatus::from_raw(code)))
            }
            WAIT_TIMEOUT => Ok(None),
            _ => Err(io::Error::last_os_error()),
        }
    }

    pub(crate) fn kill(&mut self) -> io::Result<()> {
        // SAFETY: this is the process we created, not a reopened/reused PID.
        if unsafe { TerminateProcess(self.handle.as_raw_handle(), 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(crate) fn wait(&mut self) -> io::Result<()> {
        // Only used for cleanup after kill; never wait indefinitely on a child.
        if unsafe { WaitForSingleObject(self.handle.as_raw_handle(), 5000) } != WAIT_OBJECT_0 {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "child did not exit",
            ));
        }
        Ok(())
    }

    /// Called only for a child created suspended. A nested Job may allow only
    /// partial breakaway, so successful CreateProcessW is not sufficient.
    pub(crate) fn resume_outside_job(&self) -> io::Result<()> {
        if process_in_job(self.handle.as_raw_handle())? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "daemon is still associated with a host Job Object after breakaway",
            ));
        }
        // SAFETY: this is the primary thread returned by CreateProcessW.
        if unsafe { ResumeThread(self.thread.as_raw_handle()) } == u32::MAX {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

// The opaque attribute list needs pointer-aligned storage and explicit teardown.
struct AttributeList(Vec<usize>);

impl Drop for AttributeList {
    fn drop(&mut self) {
        // SAFETY: constructed only after successful initialization.
        unsafe { DeleteProcThreadAttributeList(self.0.as_mut_ptr().cast()) };
    }
}

pub(crate) fn spawn(
    application: &OsStr,
    command_line: &OsStr,
    environment: &[(OsString, OsString)],
    stdio: [&File; 3],
    flags: u32,
) -> io::Result<Process> {
    let application = wide(application)?;
    let mut command = wide(command_line)?;
    let mut environment = environment.to_vec();
    environment.sort_by_key(|(key, _)| key.to_string_lossy().to_uppercase());
    let mut block = Vec::new();
    for (key, value) in environment {
        let mut entry = key;
        entry.push("=");
        entry.push(value);
        block.extend(wide(&entry)?);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);

    // Duplicate dedicated stdio handles rather than changing inheritability
    // on caller-owned handles. All temporary copies close on every return path.
    let inherited = stdio.map(duplicate_inheritable);
    let inherited = inherited.into_iter().collect::<io::Result<Vec<_>>>()?;
    let handles: Vec<HANDLE> = inherited.iter().map(AsRawHandle::as_raw_handle).collect();

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
            std::mem::size_of_val(handles.as_slice()),
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: these structs permit zero initialization; required fields follow.
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = handles[0];
    startup.StartupInfo.hStdOutput = handles[1];
    startup.StartupInfo.hStdError = handles[2];
    startup.lpAttributeList = attributes.0.as_mut_ptr().cast();
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: UTF-16 strings and environment are terminated, and every supplied
    // buffer and inherited handle remains alive until CreateProcessW returns.
    if unsafe {
        CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            flags | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            block.as_ptr().cast(),
            std::ptr::null(),
            &startup.StartupInfo,
            &mut process,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful CreateProcessW transfers these handles to us.
    Ok(Process {
        handle: unsafe { OwnedHandle::from_raw_handle(process.hProcess) },
        thread: unsafe { OwnedHandle::from_raw_handle(process.hThread) },
    })
}

fn duplicate_inheritable(file: &File) -> io::Result<OwnedHandle> {
    let mut handle = std::ptr::null_mut();
    // SAFETY: duplicate a live file into this process with the same access.
    if unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            file.as_raw_handle(),
            GetCurrentProcess(),
            &mut handle,
            0,
            1,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: DuplicateHandle returned a new owned handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut value: Vec<u16> = value.encode_wide().collect();
    if value.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "interior NUL in process argument",
        ));
    }
    value.push(0);
    Ok(value)
}

/// Startup diagnostics also cover foreground daemons owned by a supervisor.
pub(crate) fn current_process_in_job() -> io::Result<bool> {
    // SAFETY: the pseudo handle is valid for the current process.
    process_in_job(unsafe { GetCurrentProcess() })
}

fn process_in_job(process: HANDLE) -> io::Result<bool> {
    let mut in_job = 0;
    // SAFETY: a null job queries membership in any Job; the output is valid.
    if unsafe { IsProcessInJob(process, std::ptr::null_mut(), &mut in_job) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(in_job != 0)
}
