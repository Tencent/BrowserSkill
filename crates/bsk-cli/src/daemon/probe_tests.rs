use super::*;
use crate::daemon::{paths, test_support::isolated};
use bsk_protocol::{Frame, ResponseBody, ResponseFrame};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::time::Instant;

fn fixture_info() -> DaemonInfo {
    DaemonInfo::now(
        std::process::id(),
        paths::bsk_home().unwrap().join("probe.sock"),
        12345,
        env!("CARGO_PKG_VERSION"),
    )
}

fn status(info: &DaemonInfo) -> ResponseBody {
    ResponseBody::Ok(serde_json::json!({
        "pid": info.pid, "daemon_version": info.version, "protocol_version": "1.1",
        "uptime_secs": 1, "ws_port": info.ws_port, "sock_path": info.sock_path,
        "browsers": [], "sessions": []
    }))
}

struct Server {
    stop: Arc<AtomicBool>,
    requests: Arc<AtomicUsize>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Server {
    fn new(
        listener: UnixListener,
        mut reply: impl FnMut(usize) -> ResponseBody + Send + 'static,
    ) -> Self {
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        let requests = Arc::new(AtomicUsize::new(0));
        let count = requests.clone();
        let thread = std::thread::spawn(move || {
            while !done.load(Ordering::Relaxed) {
                let stream = match listener.accept() {
                    Ok((stream, _)) => stream,
                    Err(err) if err.kind() == ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(err) => panic!("accept: {err}"),
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                if !matches!(reader.read_line(&mut line), Ok(n) if n > 0) {
                    continue;
                }
                let Frame::Request(request) = serde_json::from_str(&line).unwrap() else {
                    panic!("expected request");
                };
                let body = reply(count.fetch_add(1, Ordering::SeqCst));
                let response = Frame::Response(ResponseFrame {
                    id: request.id,
                    body,
                });
                // A timed-out client may already have closed its connection.
                let _ = writeln!(
                    reader.get_mut(),
                    "{}",
                    serde_json::to_string(&response).unwrap()
                );
            }
        });
        Self {
            stop,
            requests,
            thread: Some(thread),
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.thread.take().unwrap().join().unwrap();
    }
}

#[test]
fn readiness_waits_for_bound_endpoint_to_serve_and_publish_new_metadata() {
    isolated(
        concat!(
            module_path!(),
            "::readiness_waits_for_bound_endpoint_to_serve_and_publish_new_metadata"
        ),
        || {
            let current = fixture_info();
            let mut stale = current.clone();
            stale.pid += 1;
            info::write(&stale).unwrap();
            let listener = UnixListener::bind(&current.sock_path).unwrap();
            let server = Server::new(listener, move |n| {
                if n == 0 {
                    // Start the delay only after receiving the first probe. The
                    // endpoint is bound but cannot serve within one probe budget.
                    std::thread::sleep(PROBE_TIMEOUT + Duration::from_millis(150));
                    info::write(&current).unwrap();
                }
                status(&current)
            });
            let started = Instant::now();
            let daemon = wait_for_ready(Duration::from_secs(3)).unwrap();
            assert_eq!(daemon.info.pid, std::process::id());
            assert!(started.elapsed() >= PROBE_TIMEOUT);
            assert!(server.requests.load(Ordering::SeqCst) >= 2);
            assert!(!paths::lock_path().unwrap().exists());
        },
    );
}

#[test]
fn readiness_timeout_uses_the_caller_deadline_and_preserves_the_cause() {
    isolated(
        concat!(
            module_path!(),
            "::readiness_timeout_uses_the_caller_deadline_and_preserves_the_cause"
        ),
        || {
            let stale = fixture_info();
            info::write(&stale).unwrap();
            let _listener = UnixListener::bind(&stale.sock_path).unwrap();
            let deadline = Duration::from_millis(1200);
            let started = Instant::now();
            let error = wait_for_ready(deadline)
                .err()
                .expect("unserved endpoint must time out");
            assert!(started.elapsed() >= deadline);
            assert!(started.elapsed() < Duration::from_secs(3));
            assert!(error.is::<tokio::time::error::Elapsed>());
            assert!(format!("{error:#}").contains("failed to become ready within"));
            assert_eq!(info::read().unwrap(), Some(stale));
            assert!(!paths::lock_path().unwrap().exists());
        },
    );
}

#[test]
fn readiness_retries_pid_mismatch_and_discovery_changes() {
    isolated(
        concat!(
            module_path!(),
            "::readiness_retries_pid_mismatch_and_discovery_changes"
        ),
        || {
            for changing_metadata in [false, true] {
                let current = fixture_info();
                let mut initial = current.clone();
                initial.pid += 1;
                info::write(&initial).unwrap();
                let listener = UnixListener::bind(&current.sock_path).unwrap();
                let path = current.sock_path.clone();
                let server = Server::new(listener, move |n| {
                    let mut published = current.clone();
                    if changing_metadata {
                        published.started_at_epoch_secs += n.min(4) as u64;
                    }
                    if changing_metadata || n >= 4 {
                        info::write(&published).unwrap();
                    }
                    status(&published)
                });
                let daemon = wait_for_ready(Duration::from_secs(3)).unwrap();
                assert_eq!(daemon.info.pid, std::process::id());
                assert!(server.requests.load(Ordering::SeqCst) >= 5);
                drop(server);
                std::fs::remove_file(path).unwrap();
            }
        },
    );
}

#[test]
fn readiness_does_not_retry_invalid_responses() {
    isolated(
        concat!(
            module_path!(),
            "::readiness_does_not_retry_invalid_responses"
        ),
        || {
            let current = fixture_info();
            info::write(&current).unwrap();
            let listener = UnixListener::bind(&current.sock_path).unwrap();
            let server = Server::new(listener, |_| {
                ResponseBody::Ok(serde_json::json!({"unexpected": true}))
            });
            assert!(wait_for_ready(Duration::from_secs(3)).is_err());
            assert_eq!(server.requests.load(Ordering::SeqCst), 1);
            assert_eq!(info::read().unwrap(), Some(current));
        },
    );
}
