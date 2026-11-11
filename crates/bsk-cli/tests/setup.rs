//! End-to-end integration tests for `bsk setup` (`RM-09`).
//!
//! Strictly isolated: every test uses a temporary `BSK_HOME`, a temporary
//! `$HOME`, an ephemeral `--port 0` daemon, and `--no-open` (or an injected
//! in-memory launcher) so the host's `~/.bsk`, port `52800`, and real browser
//! are never touched.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use bsk_protocol::local_auth::{
    AuthMessage, Bytes, ChallengeResponse, Credential, CredentialRole, Hello, Probe, ProbeMethod,
    ProbeParams, Purpose, Transcript, V1, prove, verify,
};
use bsk_protocol::{Frame, Method, RequestFrame, ResponseBody, ResponseFrame, RpcId};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderName, HeaderValue};

const EXT_ORIGIN: &str = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaap";

struct Process(Child);

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn bsk_cmd(bsk_home: &Path, user_home: &Path) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_bsk"));
    cmd.env("BSK_HOME", bsk_home)
        .env("HOME", user_home)
        .env("USERPROFILE", user_home)
        .env("CODEX_HOME", user_home.join(".codex"))
        .env("KIMI_CODE_HOME", user_home.join(".kimi-code"))
        .env("PATH", "")
        .env("BSK_AUTO_UPDATE", "off")
        .env_remove("BSK_AUTO_START")
        .env_remove("BSK_DAEMONIZED")
        .env_remove("BSK_DAEMON_REPLACES_PID")
        .stdin(Stdio::null());
    cmd
}

fn start_ephemeral_daemon(bsk_home: &Path, user_home: &Path) -> (Process, u16) {
    let log_path = bsk_home.join("test-daemon.log");
    let daemon = Process(
        bsk_cmd(bsk_home, user_home)
            .args(["daemon", "start", "--foreground", "--port", "0"])
            .stdout(Stdio::null())
            .stderr(fs::File::create(&log_path).unwrap())
            .spawn()
            .expect("spawn ephemeral test daemon"),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    let info_path = bsk_home.join("daemon.json");
    while !info_path.exists() {
        assert!(
            Instant::now() < deadline,
            "daemon.json did not appear: {}",
            fs::read_to_string(&log_path).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    // Wait until IPC responds cleanly to `status --json`.
    loop {
        let out = bsk_cmd(bsk_home, user_home)
            .args(["status", "--json"])
            .output()
            .unwrap();
        if out.status.success() {
            let status: Value = serde_json::from_slice(&out.stdout).unwrap();
            let port = status["ws_port"].as_u64().unwrap() as u16;
            assert_ne!(
                port, 52800,
                "test daemon must never bind default port 52800"
            );
            return (daemon, port);
        }
        assert!(
            Instant::now() < deadline,
            "daemon IPC did not become ready: {}",
            fs::read_to_string(&log_path).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

struct ActiveSimulatedBrowser {
    shutdown: Option<oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for ActiveSimulatedBrowser {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

/// Simulate the extension's `pair.html` one-click approval flow against the
/// `http://127.0.0.1:<port>/pair#bsk-local.v1...` launch URL:
/// 1. Verify `GET /pair` returns the strict-CSP fallback HTML without leaking secrets;
/// 2. Run the temporary `verifyLocalPairing` WebSocket activation + rotation commit;
/// 3. Reconnect with the promoted `gen = 1` key, complete `system.handshake`, and
///    stay online until dropped.
fn approve_and_connect_browser(launch_url: &str, instance_id: &str) -> ActiveSimulatedBrowser {
    let launch_url = launch_url.to_string();
    let instance_id = instance_id.to_string();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let (stop_tx, stop_rx) = oneshot::channel::<()>();

    let thread = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let res: anyhow::Result<_> = async {
                let rest = launch_url
                    .strip_prefix("http://127.0.0.1:")
                    .expect("launch url prefix");
                let (port_str, tail) = rest.split_once("/pair#").expect("pair fragment");
                let port: u16 = port_str.parse()?;
                let parts: Vec<&str> = tail.split('.').collect();
                assert_eq!(parts.len(), 5);
                assert_eq!(parts[0], "bsk-local");
                assert_eq!(parts[1], "v1");
                let daemon_id = Bytes::<16>::decode(parts[2])?;
                let device_id = Bytes::<16>::decode(parts[3])?;
                let staged_key = Bytes::<32>::decode(parts[4])?;

                // 1) Check plain HTTP GET /pair fallback page on this live daemon port.
                let mut tcp = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
                tcp.write_all(
                    format!("GET /pair HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes(),
                )
                .await?;
                let mut raw = Vec::new();
                tcp.read_to_end(&mut raw).await?;
                let http_resp = String::from_utf8(raw)?;
                assert!(http_resp.starts_with("HTTP/1.1 200 OK\r\n"));
                assert!(http_resp.to_ascii_lowercase().contains(
                    "content-security-policy: default-src 'none'; style-src 'unsafe-inline'"
                ));

                // 2) Temporary verification WebSocket (mirrors verifyLocalPairing).
                let ws_url = format!("ws://127.0.0.1:{port}/");
                let make_req = || {
                    let mut req = ws_url.as_str().into_client_request().unwrap();
                    req.headers_mut().insert(
                        HeaderName::from_static("origin"),
                        HeaderValue::from_static(EXT_ORIGIN),
                    );
                    req
                };

                let (mut verify_ws, _) = tokio_tungstenite::connect_async(make_req()).await?;
                let client_nonce = Bytes([7u8; 32]);
                let probe = Probe {
                    id: RpcId::from("verify-1"),
                    method: ProbeMethod::Ping,
                    params: ProbeParams {
                        local_auth: Hello {
                            v: V1,
                            client_nonce,
                            instance_id: instance_id.clone(),
                            credentials: vec![Credential {
                                role: CredentialRole::Staged,
                                device_id,
                                r#gen: 0,
                                pending: None,
                            }],
                        },
                    },
                };
                verify_ws
                    .send(Message::Text(serde_json::to_string(&probe)?))
                    .await?;
                let challenge_frame: ResponseFrame =
                    serde_json::from_str(&next_text(&mut verify_ws).await?)?;
                let ResponseBody::Ok(val) = challenge_frame.body else {
                    anyhow::bail!("unexpected error on probe");
                };
                let ChallengeResponse::Challenge {
                    daemon_id: ch_daemon,
                    device_id: ch_device,
                    r#gen,
                    server_nonce,
                    server_proof,
                } = serde_json::from_value(val["local_auth"].clone())?
                else {
                    anyhow::bail!("expected challenge");
                };
                assert_eq!(ch_daemon, daemon_id);
                assert_eq!(ch_device, device_id);
                assert_eq!(r#gen, 0);

                let transcript = Transcript {
                    daemon_id: &daemon_id,
                    device_id: &device_id,
                    r#gen: 0,
                    instance_id: &instance_id,
                    origin: EXT_ORIGIN,
                    client_nonce: &client_nonce,
                    server_nonce: &server_nonce,
                }
                .encode();
                assert!(verify(
                    &staged_key,
                    Purpose::Server,
                    &transcript,
                    None,
                    &server_proof
                ));
                let client_proof = prove(&staged_key, Purpose::Client, &transcript, None);
                verify_ws
                    .send(Message::Text(serde_json::to_string(&AuthMessage::Prove {
                        v: V1,
                        client_proof,
                    })?))
                    .await?;
                let AuthMessage::Ready {
                    rotation: Some(rot),
                    ..
                } = AuthMessage::parse(&next_text(&mut verify_ws).await?)?
                else {
                    anyhow::bail!("expected rotation ready");
                };
                let active_key = prove(&staged_key, Purpose::Rotate, &transcript, Some(&rot.txn));
                let confirm_proof =
                    prove(&active_key, Purpose::Confirm, &transcript, Some(&rot.txn));
                verify_ws
                    .send(Message::Text(serde_json::to_string(
                        &AuthMessage::RotateConfirm {
                            v: V1,
                            txn: rot.txn,
                            proof: confirm_proof,
                        },
                    )?))
                    .await?;
                let AuthMessage::Committed {
                    r#gen: committed_gen,
                    proof: committed_proof,
                    ..
                } = AuthMessage::parse(&next_text(&mut verify_ws).await?)?
                else {
                    anyhow::bail!("expected committed");
                };
                assert_eq!(committed_gen, 1);
                assert!(verify(
                    &active_key,
                    Purpose::Committed,
                    &transcript,
                    Some(&rot.txn),
                    &committed_proof
                ));
                let _ = verify_ws.close(None).await;

                // 3) Live extension connection with active gen=1 credential + system.handshake.
                let (mut live_ws, _) = tokio_tungstenite::connect_async(make_req()).await?;
                let live_nonce = Bytes([9u8; 32]);
                let live_probe = Probe {
                    id: RpcId::from("auth-live"),
                    method: ProbeMethod::Ping,
                    params: ProbeParams {
                        local_auth: Hello {
                            v: V1,
                            client_nonce: live_nonce,
                            instance_id: instance_id.clone(),
                            credentials: vec![Credential {
                                role: CredentialRole::Active,
                                device_id,
                                r#gen: 1,
                                pending: None,
                            }],
                        },
                    },
                };
                live_ws
                    .send(Message::Text(serde_json::to_string(&live_probe)?))
                    .await?;
                let ch2_frame: ResponseFrame =
                    serde_json::from_str(&next_text(&mut live_ws).await?)?;
                let ResponseBody::Ok(ch2_val) = ch2_frame.body else {
                    anyhow::bail!("live challenge failed");
                };
                let ChallengeResponse::Challenge {
                    server_nonce: live_server_nonce,
                    server_proof: live_server_proof,
                    ..
                } = serde_json::from_value(ch2_val["local_auth"].clone())?
                else {
                    anyhow::bail!("expected live challenge");
                };
                let live_transcript = Transcript {
                    daemon_id: &daemon_id,
                    device_id: &device_id,
                    r#gen: 1,
                    instance_id: &instance_id,
                    origin: EXT_ORIGIN,
                    client_nonce: &live_nonce,
                    server_nonce: &live_server_nonce,
                }
                .encode();
                assert!(verify(
                    &active_key,
                    Purpose::Server,
                    &live_transcript,
                    None,
                    &live_server_proof
                ));
                live_ws
                    .send(Message::Text(serde_json::to_string(&AuthMessage::Prove {
                        v: V1,
                        client_proof: prove(&active_key, Purpose::Client, &live_transcript, None),
                    })?))
                    .await?;
                let AuthMessage::Ready {
                    commit: None,
                    rotation: None,
                    ..
                } = AuthMessage::parse(&next_text(&mut live_ws).await?)?
                else {
                    anyhow::bail!("expected live ready");
                };

                let handshake_req = RequestFrame {
                    id: RpcId::from("hs-1"),
                    method: Method::SystemHandshake,
                    params: Some(json!({
                        "client": "browser-skill-extension",
                        "protocol_version": bsk::daemon::state::PROTOCOL_VERSION,
                        "min_compatible_protocol": bsk_protocol::catalog::MIN_COMPATIBLE_PROTOCOL,
                        "browser": { "name": "Chrome", "version": "131.0.0.0" },
                        "version": env!("CARGO_PKG_VERSION"),
                        "instance_id": instance_id,
                        "label": "Work",
                        "audit_enabled": false
                    })),
                };
                live_ws
                    .send(Message::Text(serde_json::to_string(&Frame::Request(
                        handshake_req,
                    ))?))
                    .await?;
                let hs_reply: ResponseFrame =
                    serde_json::from_str(&next_text(&mut live_ws).await?)?;
                assert!(matches!(hs_reply.body, ResponseBody::Ok(_)));

                Ok(live_ws)
            }
            .await;

            match res {
                Ok(mut live_ws) => {
                    let _ = ready_tx.send(Ok(()));
                    tokio::select! {
                        _ = stop_rx => {
                            let _ = live_ws.close(None).await;
                        }
                        _ = async {
                            while let Some(Ok(_)) = live_ws.next().await {}
                        } => {}
                    }
                }
                Err(err) => {
                    let _ = ready_tx.send(Err(format!("{err:#}")));
                }
            }
        });
    });

    ready_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("simulated browser timed out")
        .expect("simulated browser pairing failed");

    ActiveSimulatedBrowser {
        shutdown: Some(stop_tx),
        thread: Some(thread),
    }
}

async fn next_text<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    ws: &mut tokio_tungstenite::WebSocketStream<S>,
) -> anyhow::Result<String> {
    while let Some(msg) = ws.next().await {
        match msg? {
            Message::Text(t) => return Ok(t),
            Message::Ping(_) | Message::Pong(_) => continue,
            other => anyhow::bail!("unexpected ws frame: {other:?}"),
        }
    }
    anyhow::bail!("ws closed unexpectedly")
}

#[test]
fn setup_completes_one_click_pairing_installs_skill_mcp_and_fast_paths_when_paired() {
    let bsk_home = tempfile::tempdir().unwrap();
    let user_home = tempfile::tempdir().unwrap();
    // Create `~/.cursor` in isolated $HOME so Cursor is auto-detected.
    fs::create_dir_all(user_home.path().join(".cursor")).unwrap();

    let (_daemon, ws_port) = start_ephemeral_daemon(bsk_home.path(), user_home.path());

    // Spawn `bsk setup --no-open --mcp` and watch stderr for the generated launch URL.
    let mut setup_child = bsk_cmd(bsk_home.path(), user_home.path())
        .args(["setup", "--no-open", "--mcp", "--timeout", "15s"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn bsk setup");

    let stderr = setup_child.stderr.take().unwrap();
    let (url_tx, url_rx) = std::sync::mpsc::channel::<String>();
    let stderr_collector = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let mut lines = Vec::new();
        let mut sent = false;
        for line in reader.lines() {
            let line = line.unwrap();
            let trimmed = line.trim();
            if !sent
                && trimmed.starts_with("http://127.0.0.1:")
                && trimmed.contains("/pair#bsk-local.v1.")
            {
                let _ = url_tx.send(trimmed.to_string());
                sent = true;
            }
            lines.push(line);
        }
        lines.join("\n")
    });

    let launch_url = url_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("bsk setup should emit http://127.0.0.1:<port>/pair#bsk-local.v1... launch URL");
    assert!(launch_url.starts_with(&format!("http://127.0.0.1:{ws_port}/pair#bsk-local.v1.")));

    let browser = approve_and_connect_browser(&launch_url, "a1b2c3d4");

    let status = setup_child.wait().expect("wait for bsk setup");
    let stderr_text = stderr_collector.join().unwrap();
    assert!(status.success(), "setup failed:\n{stderr_text}");
    assert!(stderr_text.contains("[1/4] Daemon"), "{stderr_text}");
    assert!(
        stderr_text.contains("[2/4] Agent Skill & MCP"),
        "{stderr_text}"
    );
    assert!(
        stderr_text.contains("[3/4] Browser Pairing"),
        "{stderr_text}"
    );
    assert!(stderr_text.contains("[4/4] Health Check"), "{stderr_text}");
    assert!(
        stderr_text.contains("Paired & verified with Chrome"),
        "{stderr_text}"
    );
    assert!(
        stderr_text.contains("BrowserSkill is ready! Try: bsk session start"),
        "{stderr_text}"
    );

    // Verify Cursor Skill & MCP were written into isolated $HOME.
    assert!(
        user_home
            .path()
            .join(".cursor/skills/browser-skill/SKILL.md")
            .is_file()
    );
    assert!(user_home.path().join(".cursor/mcp.json").is_file());

    // 2) Re-running `bsk setup --no-open --json` hits the 0s idempotent fast path!
    let fast_start = Instant::now();
    let fast_out = bsk_cmd(bsk_home.path(), user_home.path())
        .args(["setup", "--no-open", "--json"])
        .output()
        .unwrap();
    let fast_elapsed = fast_start.elapsed();
    assert!(
        fast_out.status.success(),
        "fast-path stderr: {}",
        String::from_utf8_lossy(&fast_out.stderr)
    );
    assert!(
        fast_elapsed < Duration::from_secs(3),
        "fast-path should not poll for pairing: {fast_elapsed:?}"
    );
    let fast_json: Value = serde_json::from_slice(&fast_out.stdout).expect("valid setup json");
    assert_eq!(fast_json["ok"], true);
    assert_eq!(fast_json["daemon"]["ok"], true);
    assert_eq!(fast_json["daemon"]["ws_port"], ws_port);
    assert_eq!(fast_json["skill"]["ok"], true);
    assert_eq!(fast_json["pairing"]["status"], "already_paired");
    assert_eq!(fast_json["pairing"]["verified"], true);
    assert_eq!(fast_json["pairing"]["instance_id"], "a1b2c3d4");
    assert_eq!(fast_json["doctor"]["ok"], true);

    // 3) `--re-pair` issues a replacement pairing link even while already paired & online!
    let mut repair_child = bsk_cmd(bsk_home.path(), user_home.path())
        .args([
            "setup",
            "--re-pair",
            "--no-open",
            "--no-skill",
            "--timeout",
            "15s",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn bsk setup --re-pair");

    let repair_stderr = repair_child.stderr.take().unwrap();
    let (repair_tx, repair_rx) = std::sync::mpsc::channel::<String>();
    let repair_collector = std::thread::spawn(move || {
        let reader = BufReader::new(repair_stderr);
        let mut lines = Vec::new();
        let mut sent = false;
        for line in reader.lines() {
            let line = line.unwrap();
            let trimmed = line.trim();
            if !sent
                && trimmed.starts_with("http://127.0.0.1:")
                && trimmed.contains("/pair#bsk-local.v1.")
            {
                let _ = repair_tx.send(trimmed.to_string());
                sent = true;
            }
            lines.push(line);
        }
        lines.join("\n")
    });

    let repair_url = repair_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("--re-pair must mint a new replacement launch URL");
    assert_ne!(repair_url, launch_url);

    let _replaced_browser = approve_and_connect_browser(&repair_url, "a1b2c3d4");
    drop(browser);

    let repair_status = repair_child.wait().unwrap();
    let repair_text = repair_collector.join().unwrap();
    assert!(repair_status.success(), "re-pair failed:\n{repair_text}");
    assert!(
        repair_text.contains("Paired & verified with Chrome"),
        "{repair_text}"
    );
}

#[test]
fn setup_times_out_cleanly_with_store_links_and_structured_json() {
    let bsk_home = tempfile::tempdir().unwrap();
    let user_home = tempfile::tempdir().unwrap();
    let (_daemon, _ws_port) = start_ephemeral_daemon(bsk_home.path(), user_home.path());

    // No harnesses in empty $HOME -> skill step reports N/A (`na`) without failing;
    // pairing step times out after 350ms -> exit code 4 (Timeout) + structured JSON.
    let out = bsk_cmd(bsk_home.path(), user_home.path())
        .args(["setup", "--no-open", "--timeout", "350ms", "--json"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(4));
    let report: Value = serde_json::from_slice(&out.stdout).expect("valid timeout json");
    assert_eq!(report["ok"], false);
    assert_eq!(report["daemon"]["ok"], true);
    assert_eq!(report["skill"]["ok"], true);
    assert_eq!(report["skill"]["status"], "na");
    assert_eq!(report["pairing"]["ok"], false);
    assert_eq!(report["pairing"]["status"], "timeout");
    assert!(
        report["pairing"]["hint"]
            .as_str()
            .unwrap_or_default()
            .contains("chromewebstore.google.com")
    );
}

#[test]
fn setup_respects_bsk_auto_start_disabled_without_spawning() {
    let bsk_home = tempfile::tempdir().unwrap();
    let user_home = tempfile::tempdir().unwrap();

    let out = bsk_cmd(bsk_home.path(), user_home.path())
        .env("BSK_AUTO_START", "0")
        .args(["setup", "--no-open", "--json"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(!bsk_home.path().join("daemon.json").exists());
    let report: Value =
        serde_json::from_slice(&out.stdout).expect("valid auto-start disabled json");
    assert_eq!(report["ok"], false);
    assert_eq!(report["daemon"]["ok"], false);
    assert!(
        report["daemon"]["hint"]
            .as_str()
            .unwrap_or_default()
            .to_ascii_lowercase()
            .contains("restore the daemon")
    );
}
