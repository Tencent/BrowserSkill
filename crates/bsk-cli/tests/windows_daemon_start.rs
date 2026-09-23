//! Native Windows startup regression: process exit, pipe EOF and Job lifetime
//! are independent assertions. Every process uses a private BSK_HOME.
#![cfg(windows)]

use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use bsk::daemon::info::DaemonInfo;
use windows_sys::Win32::Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
};

const BUDGET: Duration = Duration::from_secs(8);

struct Job(OwnedHandle);

impl Job {
    fn new(breakaway: u32) -> Self {
        // SAFETY: no name or inheritable security descriptor; this test owns it.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        assert!(!handle.is_null(), "{}", std::io::Error::last_os_error());
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | breakaway;
        assert_ne!(
            unsafe {
                SetInformationJobObject(
                    job.0.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&limits) as u32,
                )
            },
            0,
            "{}",
            std::io::Error::last_os_error()
        );
        job
    }

    fn assign(&self, child: &Child) {
        assert_ne!(
            unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), child.as_raw_handle()) },
            0,
            "{}",
            std::io::Error::last_os_error()
        );
    }

    fn assert_empty(&self) {
        // Job accounting can lag a process's signaled exit handle briefly.
        // Poll with a deadline so a leaked suspended daemon still fails.
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
            assert_ne!(
                unsafe {
                    QueryInformationJobObject(
                        self.0.as_raw_handle(),
                        JobObjectBasicAccountingInformation,
                        (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                        std::mem::size_of_val(&info) as u32,
                        std::ptr::null_mut(),
                    )
                },
                0
            );
            if info.ActiveProcesses == 0 {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "startup left {} process(es) in the host Job",
                info.ActiveProcesses
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn terminate(&self) {
        assert_ne!(unsafe { TerminateJobObject(self.0.as_raw_handle(), 99) }, 0);
    }
}

fn in_job(process: HANDLE, job: HANDLE) -> bool {
    let mut result = 0;
    assert_ne!(unsafe { IsProcessInJob(process, job, &mut result) }, 0);
    result != 0
}

fn open_process(pid: u32) -> OwnedHandle {
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    assert!(
        !handle.is_null(),
        "open process {pid}: {}",
        std::io::Error::last_os_error()
    );
    unsafe { OwnedHandle::from_raw_handle(handle) }
}

fn assert_alive(process: &OwnedHandle) {
    assert_eq!(
        unsafe { WaitForSingleObject(process.as_raw_handle(), 0) },
        WAIT_TIMEOUT
    );
}

fn drain(mut pipe: impl Read + Send + 'static) -> Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        pipe.read_to_end(&mut bytes).unwrap();
        let _ = tx.send(bytes);
    });
    rx
}

struct Captured {
    child: Child,
    stdout: Receiver<Vec<u8>>,
    stderr: Receiver<Vec<u8>>,
    started: Instant,
}

impl Captured {
    fn finish(&mut self) -> Output {
        let deadline = self.started + BUDGET;
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "launcher did not exit within {BUDGET:?}"
            );
            thread::sleep(Duration::from_millis(10));
        };
        // Unlike wait_with_output(), these assertions distinguish launcher exit
        // from a daemon retaining either captured pipe's write end.
        let stdout = self
            .stdout
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("launcher exited but stdout never reached EOF");
        let stderr = self
            .stderr
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("launcher exited but stderr never reached EOF");
        Output {
            status,
            stdout,
            stderr,
        }
    }
}

impl Drop for Captured {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    home: PathBuf,
    exe: PathBuf,
    auto_start: bool,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("中文 daemon home & %PATH% !");
        fs::create_dir(&home).unwrap();
        Self {
            _temp: temp,
            home,
            exe: env!("CARGO_BIN_EXE_bsk").into(),
            auto_start: true,
        }
    }

    fn launch(&self, args: &[&str], jobs: &[&Job]) -> Captured {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "launcher_process",
                "--ignored",
                "--nocapture",
                "--quiet",
            ])
            .env("BSK_START_TEST_EXE", &self.exe)
            .env("BSK_START_TEST_ARGS", serde_json::to_string(args).unwrap())
            .env("BSK_HOME", &self.home)
            .env("BSK_AUTO_UPDATE", "off")
            .env("BSK_UPDATE_MANIFEST_URL", "http://127.0.0.1:1/unreachable")
            .env("BSK_BROWSER_WAIT_MS", "0")
            .env("BSK_DOCTOR_BROWSER_WAIT_MS", "0")
            .env("RUST_LOG", "error")
            .env("BSK_AUTO_START", if self.auto_start { "1" } else { "0" })
            .env_remove("BSK_DAEMONIZED")
            .env_remove("BSK_DAEMON_REPLACES_PID")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Preserve the test host's Job policy. The independent-host CI
            // suite supplies a verified Job-free host; rejection tests also
            // run directly inside the ordinary runner's restrictive Job.
            .creation_flags(CREATE_NO_WINDOW);
        let started = Instant::now();
        let mut child = command.spawn().expect("create gated test launcher");
        for job in jobs {
            job.assign(&child);
        }
        let stdout = drain(child.stdout.take().unwrap());
        let stderr = drain(child.stderr.take().unwrap());
        child.stdin.take().unwrap().write_all(b"go\n").unwrap();
        Captured {
            child,
            stdout,
            stderr,
            started,
        }
    }

    fn run(&self, args: &[&str], jobs: &[&Job]) -> Output {
        self.launch(args, jobs).finish()
    }

    fn info(&self) -> DaemonInfo {
        serde_json::from_slice(&fs::read(self.home.join("daemon.json")).unwrap()).unwrap()
    }

    fn wait_for_info(&self) -> DaemonInfo {
        let deadline = Instant::now() + BUDGET;
        loop {
            if let Ok(bytes) = fs::read(self.home.join("daemon.json")) {
                if let Ok(info) = serde_json::from_slice(&bytes) {
                    return info;
                }
            }
            assert!(
                Instant::now() < deadline,
                "daemon did not publish discovery"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn assert_stopped(&self) {
        assert!(
            !self.home.join("daemon.json").exists(),
            "failed startup published a daemon"
        );
        if let Ok(lock) = File::open(self.home.join("daemon.lock")) {
            fs2::FileExt::try_lock_exclusive(&lock).expect("startup left a locked daemon");
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Only this fixture can publish into this fresh private home. Keep a
        // process handle through termination, so cleanup cannot target a new PID.
        if let Ok(bytes) = fs::read(self.home.join("daemon.json")) {
            if let Ok(info) = serde_json::from_slice::<DaemonInfo>(&bytes) {
                let handle =
                    unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, info.pid) };
                if !handle.is_null() {
                    let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
                    unsafe {
                        TerminateProcess(handle.as_raw_handle(), 0);
                        WaitForSingleObject(handle.as_raw_handle(), 5000);
                    }
                }
            }
        }
    }
}

fn success(output: Output) {
    assert!(
        output.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn refused(output: Output) {
    assert!(!output.status.success());
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(text.contains("Job Object"), "{text}");
    assert!(text.contains("persistent host task"), "{text}");
    assert!(text.contains("BSK_AUTO_START=0"), "{text}");
}

// Re-exec the test binary as a gated launcher so assignment to a Job happens
// before bsk can create a daemon. No shell or separately compiled fixture needed.
#[test]
#[ignore = "subprocess entry point"]
fn launcher_process() {
    let Some(exe) = std::env::var_os("BSK_START_TEST_EXE") else {
        return;
    };
    let mut gate = String::new();
    std::io::stdin().read_line(&mut gate).unwrap();
    assert_eq!(gate, "go\n");
    let args: Vec<String> =
        serde_json::from_str(&std::env::var("BSK_START_TEST_ARGS").unwrap()).unwrap();
    let status = Command::new(exe)
        .args(args)
        .stdin(Stdio::null())
        .status()
        .unwrap();
    std::process::exit(status.code().unwrap_or(1));
}

#[test]
fn detached_start_closes_both_pipes_and_reuses_the_daemon() {
    let mut fixture = Fixture::new();
    let exe_dir = fixture._temp.path().join("中文 bin space & %PATH% !");
    fs::create_dir(&exe_dir).unwrap();
    fixture.exe = exe_dir.join("bsk.exe");
    fs::copy(env!("CARGO_BIN_EXE_bsk"), &fixture.exe).unwrap();
    success(fixture.run(&["daemon", "start", "--port", "0"], &[]));
    let original = fixture.info();
    let process = open_process(original.pid);
    assert!(!in_job(process.as_raw_handle(), std::ptr::null_mut()));
    for _ in 0..3 {
        success(fixture.run(&["status", "--json"], &[]));
        success(fixture.run(&["daemon", "start"], &[]));
        assert_eq!(fixture.info().pid, original.pid);
        assert_alive(&process);
    }
}

#[test]
fn detached_daemon_survives_job_close_and_termination() {
    for flags in [
        JOB_OBJECT_LIMIT_BREAKAWAY_OK,
        JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
    ] {
        for terminate in [false, true] {
            let fixture = Fixture::new();
            let job = Job::new(flags);
            success(fixture.run(&["daemon", "start", "--port", "0"], &[&job]));
            let process = open_process(fixture.info().pid);
            assert!(!in_job(process.as_raw_handle(), job.0.as_raw_handle()));
            assert!(!in_job(process.as_raw_handle(), std::ptr::null_mut()));
            if terminate {
                job.terminate();
            }
            drop(job);
            assert_alive(&process);
            success(fixture.run(&["status", "--json"], &[]));
        }
    }
}

#[test]
fn restrictive_job_refuses_explicit_and_automatic_start_without_a_daemon() {
    for args in [
        vec!["daemon", "start", "--port", "0"],
        vec!["status", "--json"],
        vec!["doctor", "--json"],
        vec!["browsers", "--json"],
    ] {
        let fixture = Fixture::new();
        let job = Job::new(0);
        refused(fixture.run(&args, &[&job]));
        fixture.assert_stopped();
        job.assert_empty();
    }
}

#[test]
fn nested_jobs_require_breakaway_from_every_level() {
    for outer_flags in [0, JOB_OBJECT_LIMIT_BREAKAWAY_OK] {
        let fixture = Fixture::new();
        let outer = Job::new(outer_flags);
        let inner = Job::new(JOB_OBJECT_LIMIT_BREAKAWAY_OK);
        let output = fixture.run(&["daemon", "start", "--port", "0"], &[&outer, &inner]);
        if outer_flags == 0 {
            refused(output);
            fixture.assert_stopped();
            inner.assert_empty();
            outer.assert_empty();
        } else {
            success(output);
            let process = open_process(fixture.info().pid);
            assert!(!in_job(process.as_raw_handle(), std::ptr::null_mut()));
            drop(inner);
            drop(outer);
            assert_alive(&process);
            success(fixture.run(&["status", "--json"], &[]));
        }
    }
}

#[test]
fn restrictive_job_reuses_an_existing_independent_daemon() {
    let fixture = Fixture::new();
    success(fixture.run(&["daemon", "start", "--port", "0"], &[]));
    let original = fixture.info();
    let process = open_process(original.pid);
    let job = Job::new(0);
    for args in [vec!["daemon", "start"], vec!["status", "--json"]] {
        success(fixture.run(&args, &[&job]));
        assert_eq!(fixture.info().pid, original.pid);
    }
    drop(job);
    assert_alive(&process);
}

#[test]
fn foreground_stays_owned_by_the_host_job() {
    let fixture = Fixture::new();
    let job = Job::new(0);
    let mut launcher = fixture.launch(&["daemon", "start", "--foreground", "--port", "0"], &[&job]);
    let process = open_process(fixture.wait_for_info().pid);
    assert!(in_job(process.as_raw_handle(), job.0.as_raw_handle()));
    assert_alive(&process);
    drop(job);
    assert_eq!(
        unsafe { WaitForSingleObject(process.as_raw_handle(), 5000) },
        WAIT_OBJECT_0
    );
    // KILL_ON_JOB_CLOSE does not promise a nonzero process exit code.
    // Termination and EOF, verified independently, are the contract here.
    let _ = launcher.finish();
}

#[test]
fn failed_start_is_bounded_and_releases_the_daemon_lock() {
    let fixture = Fixture::new();
    let occupied = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = occupied.local_addr().unwrap().port().to_string();
    let output = fixture.run(&["daemon", "start", "--port", &port], &[]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("exited during startup"));
    fixture.assert_stopped();
    drop(occupied);
    success(fixture.run(&["daemon", "start", "--port", &port], &[]));
}

#[test]
fn concurrent_starters_share_a_single_ready_daemon() {
    let fixture = Fixture::new();
    let reservation = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = reservation.local_addr().unwrap().port().to_string();
    drop(reservation);
    let mut launchers: Vec<_> = (0..6)
        .map(|_| fixture.launch(&["daemon", "start", "--port", &port], &[]))
        .collect();
    for launcher in &mut launchers {
        success(launcher.finish());
    }
    let info = fixture.info();
    assert_eq!(info.ws_port, port.parse::<u16>().unwrap());
    success(fixture.run(&["status", "--json"], &[]));
    assert_eq!(fixture.info().pid, info.pid);
}

#[test]
fn automatic_start_returns_eof_and_reuses_the_same_daemon() {
    // Auto-start intentionally uses the production default port. Never stop an
    // unrelated developer daemon to free it; CI must supply a free port.
    match TcpListener::bind("127.0.0.1:52800") {
        Ok(listener) => drop(listener),
        Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
            assert!(
                std::env::var_os("CI").is_none(),
                "default port unavailable: {err}"
            );
            eprintln!("skipping auto-start success case: default port unavailable: {err}");
            return;
        }
        Err(err) => panic!("check default port: {err}"),
    }
    let fixture = Fixture::new();
    success(fixture.run(&["status", "--json"], &[]));
    let original = fixture.info();
    success(fixture.run(&["status", "--json"], &[]));
    assert_eq!(fixture.info().pid, original.pid);
    let process = open_process(original.pid);
    assert!(!in_job(process.as_raw_handle(), std::ptr::null_mut()));
}

#[test]
fn disabled_auto_start_preserves_absence_but_allows_explicit_start_and_reuse() {
    let mut fixture = Fixture::new();
    fixture.auto_start = false;
    let output = fixture.run(&["status", "--json"], &[]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("BSK_AUTO_START=0"));
    fixture.assert_stopped();
    assert!(!fixture.home.join("daemon.lock").exists());
    success(fixture.run(&["daemon", "start", "--port", "0"], &[]));
    let original = fixture.info();
    let job = Job::new(0);
    success(fixture.run(&["status", "--json"], &[&job]));
    assert_eq!(fixture.info().pid, original.pid);
}
