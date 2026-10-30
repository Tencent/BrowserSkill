//! Exercise a real CLI signal against a controlled late successful RPC response.
#![cfg(unix)]

use bsk::daemon::info::DaemonInfo;
use nix::{
    sys::signal::{Signal, kill},
    unistd::Pid,
};
use serde_json::{Value, json};
use std::{
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
    process::Command,
    sync::{Notify, watch},
};

#[tokio::test]
async fn sigint_stops_step_even_when_the_current_rpc_returns_success() {
    for stage in ["tool.click", "tool.wait_for_element", "tool.cooperate"] {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let sock = home.path().join("ipc.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let info = DaemonInfo::now(std::process::id(), sock.clone(), 0, "0.3.3");
        std::fs::write(
            home.path().join("daemon.json"),
            serde_json::to_vec(&info).unwrap(),
        )
        .unwrap();
        let pending = Arc::new(Notify::new());
        let methods = Arc::new(Mutex::new(Vec::new()));
        let (cancel, cancelled) = watch::channel(false);
        let server_pending = pending.clone();
        let server_methods = methods.clone();
        let server = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let pending = server_pending.clone();
                let methods = server_methods.clone();
                let cancel = cancel.clone();
                let mut cancelled = cancelled.clone();
                let sock = sock.clone();
                connections.spawn(async move {
                    let (read, mut write) = stream.into_split();
                    let mut line = String::new();
                    BufReader::new(read).read_line(&mut line).await.unwrap();
                    let request: Value = serde_json::from_str(&line).unwrap();
                    let method = request["method"].as_str().unwrap();
                    methods.lock().unwrap().push(method.to_owned());
                    if method == stage {
                        pending.notify_one();
                        cancelled.wait_for(|v| *v).await.unwrap();
                    }
                    let result = match method {
                        "system.status" => {
                            json!({"daemon_version":"0.3.3","protocol_version":"1.8",
                            "pid":std::process::id(),"uptime_secs":0,"ws_port":0,"sock_path":sock,
                            "browsers":[],"sessions":[]})
                        }
                        "tool.click" => json!({"tab_id":42,"delivered":true}),
                        "tool.wait_for_element" => json!({"tab_id":42,"satisfied":true}),
                        "tool.cooperate" => {
                            json!({"tab_id":42,"context_id":"fresh","control_policy":"target"})
                        }
                        "cancel" => {
                            cancel.send(true).unwrap();
                            // The original operation finished just before cancellation.
                            json!({"cancelled":false})
                        }
                        _ => panic!("unexpected method {method}"),
                    };
                    let mut bytes =
                        serde_json::to_vec(&json!({"id":request["id"],"result":result})).unwrap();
                    bytes.push(b'\n');
                    write.write_all(&bytes).await.unwrap();
                });
            }
        });
        let child = Command::new(env!("CARGO_BIN_EXE_bsk"))
            .env("BSK_HOME", home.path())
            .env("BSK_AUTO_START", "0")
            .env("BSK_AUTO_UPDATE", "off")
            .env_remove("BSK_CANCEL_ON_STDIN_CLOSE")
            .args([
                "step",
                "--session",
                "fixture",
                "--action",
                "click",
                "--params",
                r#"{"ref":"e1"}"#,
                "--until-visible",
                "#ready",
                "--json",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), pending.notified())
            .await
            .unwrap();
        kill(Pid::from_raw(child.id().unwrap() as i32), Signal::SIGINT).unwrap();
        let out = tokio::time::timeout(Duration::from_secs(8), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        server.abort();
        let _ = server.await;
        let result: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(out.status.code(), Some(2), "{stage}: {result}");
        assert_eq!(result["ok"], false);
        assert_eq!(result["cancelled"], true);
        assert_eq!(result["action"]["result"]["delivered"], true);
        if stage == "tool.cooperate" {
            assert_eq!(result["post"]["context_id"], "fresh");
        } else {
            assert!(result.get("post").is_none());
        }
        let methods = methods.lock().unwrap();
        let cancel_index = methods.iter().position(|m| m == "cancel").unwrap();
        assert_eq!(
            cancel_index + 1,
            methods.len(),
            "RPC after cancellation: {methods:?}"
        );
        assert_eq!(methods.iter().filter(|m| *m == "tool.click").count(), 1);
    }
}
