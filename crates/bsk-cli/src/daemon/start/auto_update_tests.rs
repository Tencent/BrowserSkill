//! Exercise the updater and real IPC without CLI/serve skill-sync side effects.
//! Each case owns its BSK_HOME, installation and loopback release server.

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bsk_protocol::{ErrorCode, Frame, Method, ResponseBody, ResponseFrame};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{
    DaemonConfig, TransactionSlot, lock_slot, prepare_handover, start_replacement_with_spawn,
};
use crate::cli::update::{InstallOutcome, ManifestAsset, UpdateCandidate, state};
use crate::daemon::browsers::{self, BrowserClient, BrowserId, BrowserSink, Liveness, Pending};
use crate::daemon::sessions::{SessionRegistry, UpdateBlocked};
use crate::daemon::{DaemonHandle, paths, test_support};
use crate::ipc_client::{Client, RpcOutcome};

const WAIT: Duration = Duration::from_secs(10);
const ORIGINAL: &[u8] = b"private previous executable";

struct Release {
    candidate: UpdateCandidate,
    requested: mpsc::Receiver<()>,
    release: Option<mpsc::Sender<()>>,
    address: SocketAddr,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl Release {
    fn new(binary: &[u8], held: bool) -> Self {
        let mut tar = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_size(binary.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        tar.append_data(&mut header, "bsk", binary).unwrap();
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gzip.write_all(&tar.into_inner().unwrap()).unwrap();
        let archive = gzip.finish().unwrap();
        let sha256 = Sha256::digest(&archive)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (requested_tx, requested) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(WAIT)).unwrap();
            stream.set_write_timeout(Some(WAIT)).unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|s| s == b"\r\n\r\n") {
                match stream.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => request.extend_from_slice(&buffer[..n]),
                }
            }
            let _ = requested_tx.send(());
            if release_rx.recv_timeout(WAIT).is_err() {
                return;
            }
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                archive.len()
            );
            let _ = stream.write_all(&archive);
        });
        let mut release = Self {
            candidate: UpdateCandidate {
                current: env!("CARGO_PKG_VERSION").parse().unwrap(),
                latest: "99.0.0".parse().unwrap(),
                tag: "cli-v99.0.0".into(),
                release_url: None,
                asset: ManifestAsset {
                    url: format!("http://{address}/bsk.tar.gz"),
                    sha256: Some(sha256),
                },
            },
            requested,
            release: Some(release_tx),
            address,
            worker: Some(worker),
        };
        if !held {
            release.finish();
        }
        release
    }

    fn finish(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
    }
}

impl Drop for Release {
    fn drop(&mut self) {
        self.finish();
        // Also unblock accept if a case fails before it requests the archive.
        let _ = TcpStream::connect(self.address);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

struct Installation {
    root: tempfile::TempDir,
    exe: PathBuf,
    transaction: TransactionSlot,
}

impl Installation {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let exe = root
            .path()
            .join(if cfg!(windows) { "bsk.exe" } else { "bsk" });
        fs::write(&exe, ORIGINAL).unwrap();
        Self {
            root,
            exe,
            transaction: Arc::new(Mutex::new(None)),
        }
    }

    fn checked_release(&self) -> Vec<u8> {
        let source = self.root.path().join("release.rs");
        let executable = self
            .root
            .path()
            .join(format!("release{}", std::env::consts::EXE_SUFFIX));
        fs::write(&source, r#"fn main() { assert_eq!(std::env::args().nth(1).as_deref(), Some("--version")); println!("bsk 99.0.0"); }"#).unwrap();
        let mut compiler =
            std::process::Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()));
        compiler
            .args(["--edition", "2021", "-o"])
            .arg(&executable)
            .arg(source);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            compiler.creation_flags(0x0800_0000);
        }
        let output = compiler.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        fs::read(executable).unwrap()
    }

    fn prepare(
        &self,
        candidate: &UpdateCandidate,
        sessions: &Arc<SessionRegistry>,
        stopped: bool,
    ) -> anyhow::Result<InstallOutcome<()>> {
        prepare_handover(
            candidate,
            Some(&self.exe),
            &self.transaction,
            &AtomicBool::new(stopped),
            sessions,
        )
    }

    fn restored_and_open(&self, sessions: &Arc<SessionRegistry>) {
        assert_eq!(fs::read(&self.exe).unwrap(), ORIGINAL);
        assert!(lock_slot(&self.transaction).is_none());
        let id = sessions
            .reserve_id(BrowserId("after-rollback".into()), 64, || 0)
            .expect("the same registry must accept a session after the operation returns");
        sessions.cancel_reservation(&id);
    }
}

struct TestDaemon {
    handle: DaemonHandle,
    socket: PathBuf,
    browser: Arc<BrowserClient>,
    requests: tokio::sync::mpsc::UnboundedReceiver<Frame>,
}

impl TestDaemon {
    async fn new() -> Self {
        #[cfg(windows)]
        let socket = PathBuf::from(paths::pipe_name());
        #[cfg(not(windows))]
        let socket = paths::bsk_home().unwrap().join("test.sock");
        let handle = crate::daemon::run(DaemonConfig::new(0), Some(socket.clone()))
            .await
            .unwrap();
        let (tx, requests) = tokio::sync::mpsc::unbounded_channel();
        let browser = Arc::new(BrowserClient {
            id: BrowserId("update-test".into()),
            browser_name: "fixture".into(),
            browser_version: "1".into(),
            extension_version: env!("CARGO_PKG_VERSION").into(),
            extension_protocol_version: crate::daemon::state::PROTOCOL_VERSION.into(),
            label: String::new(),
            sink: BrowserSink { tx },
            pending: Mutex::new(Pending::default()),
            generation: browsers::next_browser_generation(),
            connected_at_ms: 0,
            version_skew: false,
            liveness: Liveness::default(),
        });
        handle.state().browsers.insert(Arc::clone(&browser));
        Self {
            handle,
            socket,
            browser,
            requests,
        }
    }

    async fn start(&mut self, token: Option<String>) -> Value {
        let socket = self.socket.clone();
        let method = if token.is_some() {
            Method::SessionStartTracked
        } else {
            Method::SessionStart
        };
        let mut params = json!({"browser_instance_id": self.browser.id.0, "focused": false});
        if let Some(token) = token {
            params["request_id"] = token.into();
        }
        let started = tokio::spawn(async move { rpc(&socket, method, params).await });
        let Frame::Request(request) = tokio::time::timeout(WAIT, self.requests.recv())
            .await
            .unwrap()
            .unwrap()
        else {
            panic!("expected a session creation request")
        };
        assert_eq!(request.method, Method::ToolSessionStart);
        assert!(self.browser.pending.lock().unwrap().resolve(ResponseFrame {
            id: request.id,
            body: ResponseBody::Ok(json!({"agent_window_id": 71})),
        }));
        started.await.unwrap().unwrap()
    }

    async fn prepare_request(&self) -> String {
        let expiry = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
            + 60_000;
        let id = format!("{expiry}:{}", uuid::Uuid::new_v4());
        let result = rpc(
            &self.socket,
            Method::SessionRequest,
            json!({"request_id": id, "action": "prepare"}),
        )
        .await
        .unwrap();
        assert_eq!(result["state"], "prepared");
        id
    }
}

async fn rpc(socket: &Path, method: Method, params: Value) -> RpcOutcome<Value> {
    Client::connect_path(socket.to_owned())
        .await
        .unwrap()
        .call(method, &params, WAIT)
        .await
        .unwrap()
}

#[test]
fn session_started_during_download_postpones_installation() {
    test_support::isolated(
        concat!(
            module_path!(),
            "::session_started_during_download_postpones_installation"
        ),
        || {
            tokio::runtime::Runtime::new().unwrap().block_on(async {
                let mut daemon = TestDaemon::new().await;
                let sessions = Arc::clone(&daemon.handle.state().sessions);
                let installation = Installation::new();
                let mut release = Release::new(b"must not be installed", true);
                let candidate = release.candidate.clone();
                let exe = installation.exe.clone();
                let transaction = Arc::clone(&installation.transaction);
                let owned_sessions = Arc::clone(&sessions);
                let prepared = tokio::task::spawn_blocking(move || {
                    prepare_handover(
                        &candidate,
                        Some(&exe),
                        &transaction,
                        &AtomicBool::new(false),
                        &owned_sessions,
                    )
                });
                release.requested.recv_timeout(WAIT).unwrap();
                let session = daemon.start(None).await;
                assert_eq!(sessions.len(), 1);
                release.finish();
                assert!(
                    matches!(
                        prepared.await.unwrap(),
                        Ok(InstallOutcome::PostponedSessions(1))
                    ),
                    "installation must be postponed when a session starts during download"
                );
                let record = state::current().unwrap();
                assert_eq!(record.result, state::UpdateResult::Skipped);
                assert_eq!(record.stage, Some(state::UpdateStage::Download));
                assert_eq!(record.skip_reason, Some(state::SkipReason::ActiveSessions));
                assert_eq!(record.retry_after_epoch_secs, None);
                assert_eq!(fs::read(&installation.exe).unwrap(), ORIGINAL);
                assert!(lock_slot(&installation.transaction).is_none());
                let status = rpc(&daemon.socket, Method::SystemStatus, json!({}))
                    .await
                    .unwrap();
                assert_eq!(status["sessions"][0]["session_id"], session["session_id"]);
                daemon.handle.shutdown().await;
            });
        },
    );
}

#[test]
fn self_check_failure_reopens_the_same_registry_after_return() {
    test_support::isolated(
        concat!(
            module_path!(),
            "::self_check_failure_reopens_the_same_registry_after_return"
        ),
        || {
            let sessions = Arc::new(SessionRegistry::new());
            let installation = Installation::new();
            let release = Release::new(b"not an executable", false);
            let error = installation
                .prepare(&release.candidate, &sessions, false)
                .err()
                .unwrap();
            assert!(error.to_string().contains("self-check"));
            let record = state::current().unwrap();
            assert_eq!(record.result, state::UpdateResult::Failed);
            assert_eq!(record.recovery, Some(state::Recovery::Unchanged));
            installation.restored_and_open(&sessions);
        },
    );
}

#[test]
fn spawn_failure_rolls_back_and_reopens_the_same_registry() {
    test_support::isolated(
        concat!(
            module_path!(),
            "::spawn_failure_rolls_back_and_reopens_the_same_registry"
        ),
        || {
            let sessions = Arc::new(SessionRegistry::new());
            let installation = Installation::new();
            let release = Release::new(&installation.checked_release(), false);
            assert!(matches!(
                installation
                    .prepare(&release.candidate, &sessions, false)
                    .unwrap(),
                InstallOutcome::Installed(())
            ));
            assert!(!start_replacement_with_spawn(
                &installation.transaction,
                0,
                || {
                    assert!(matches!(
                        sessions.try_begin_update(),
                        Err(UpdateBlocked::Updating)
                    ));
                    anyhow::bail!("injected replacement spawn failure")
                }
            ));
            installation.restored_and_open(&sessions);
            let record = state::current().unwrap();
            assert_eq!(record.result, state::UpdateResult::Failed);
            assert_eq!(record.stage, Some(state::UpdateStage::Handover));
            assert_eq!(
                record.recovery,
                Some(state::Recovery::Restored {
                    daemon_serving: true
                })
            );
            assert!(
                record
                    .error
                    .unwrap()
                    .contains("injected replacement spawn failure")
            );
        },
    );
}

#[test]
fn abandoned_update_restores_before_reopening_admission() {
    test_support::isolated(
        concat!(
            module_path!(),
            "::abandoned_update_restores_before_reopening_admission"
        ),
        || {
            let sessions = Arc::new(SessionRegistry::new());
            let installation = Installation::new();
            let release = Release::new(&installation.checked_release(), false);
            installation
                .prepare(&release.candidate, &sessions, false)
                .unwrap();
            assert!(matches!(
                sessions.try_begin_update(),
                Err(UpdateBlocked::Updating)
            ));
            let mut observed_restore = false;
            lock_slot(&installation.transaction)
                .take()
                .unwrap()
                .abandon_with(|| {
                    // This is the success callback of the real file restoration,
                    // before roll_back returns to the transaction.
                    assert_eq!(fs::read(&installation.exe).unwrap(), ORIGINAL);
                    assert!(
                        matches!(sessions.try_begin_update(), Err(UpdateBlocked::Updating)),
                        "admission reopened before rollback completed"
                    );
                    assert!(
                        sessions
                            .reserve_id(BrowserId("during-rollback".into()), 64, || 0)
                            .is_none()
                    );
                    observed_restore = true;
                    state::Recovery::Restored {
                        daemon_serving: false,
                    }
                });
            assert!(observed_restore, "the actual restore callback must run");
            installation.restored_and_open(&sessions);
            assert_eq!(
                state::current().unwrap().recovery,
                Some(state::Recovery::Restored {
                    daemon_serving: false
                })
            );
        },
    );
}

#[test]
fn stopped_download_leaves_admission_open_and_executable_unchanged() {
    test_support::isolated(
        concat!(
            module_path!(),
            "::stopped_download_leaves_admission_open_and_executable_unchanged"
        ),
        || {
            let sessions = Arc::new(SessionRegistry::new());
            let installation = Installation::new();
            let release = Release::new(b"must not be installed", false);
            let error = installation
                .prepare(&release.candidate, &sessions, true)
                .err()
                .unwrap();
            assert!(
                error
                    .to_string()
                    .contains("stopped before the update was installed")
            );
            installation.restored_and_open(&sessions);
            assert_eq!(
                state::current().unwrap().stage,
                Some(state::UpdateStage::Download)
            );
        },
    );
}

#[test]
fn duplicate_update_finishes_the_record_without_releasing_another_guard() {
    test_support::isolated(
        concat!(
            module_path!(),
            "::duplicate_update_finishes_the_record_without_releasing_another_guard"
        ),
        || {
            let sessions = Arc::new(SessionRegistry::new());
            let admission = sessions.try_begin_update().unwrap();
            let installation = Installation::new();
            let release = Release::new(b"must not be installed", false);
            let error = installation
                .prepare(&release.candidate, &sessions, false)
                .err()
                .unwrap();
            assert!(error.to_string().contains("already installing"));
            let record = state::current().unwrap();
            assert_eq!(record.result, state::UpdateResult::Failed);
            assert_eq!(record.stage, Some(state::UpdateStage::Download));
            assert_eq!(record.recovery, Some(state::Recovery::Unchanged));
            assert!(record.error.unwrap().contains("already installing"));
            assert!(matches!(
                sessions.try_begin_update(),
                Err(UpdateBlocked::Updating)
            ));
            drop(admission);
            installation.restored_and_open(&sessions);
        },
    );
}

#[test]
fn tracked_start_retry_requires_a_new_prepared_request() {
    test_support::isolated(
        concat!(
            module_path!(),
            "::tracked_start_retry_requires_a_new_prepared_request"
        ),
        || {
            tokio::runtime::Runtime::new().unwrap().block_on(async {
                let mut daemon = TestDaemon::new().await;
                let admission = daemon.handle.state().sessions.try_begin_update().unwrap();
                let id = daemon.prepare_request().await;
                let params = json!({"request_id": id, "browser_instance_id": daemon.browser.id.0});
                let refused = rpc(&daemon.socket, Method::SessionStartTracked, params.clone())
                    .await
                    .unwrap_err();
                assert_eq!(refused.code, ErrorCode::ProtocolError);
                assert_eq!(refused.data, Some(json!({"reason": "daemon_updating"})));
                assert!(daemon.requests.try_recv().is_err());
                assert!(daemon.handle.state().sessions.is_empty());
                drop(admission);
                let cached = rpc(&daemon.socket, Method::SessionStartTracked, params)
                    .await
                    .unwrap_err();
                assert_eq!(cached, refused);
                assert!(daemon.requests.try_recv().is_err());
                let fresh = daemon.prepare_request().await;
                assert_ne!(fresh, id);
                let session = daemon.start(Some(fresh)).await;
                assert!(session["session_id"].is_string());
                daemon.handle.shutdown().await;
            });
        },
    );
}
