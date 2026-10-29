//! The drag entry point must reject click-move-click before an old daemon can forward it.
#![cfg(unix)]

use bsk::daemon::info::DaemonInfo;
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
    process::Command,
};

#[tokio::test]
async fn drag_gates_new_gestures_but_keeps_legacy_drags_working() {
    for protocol in ["1.6", "1.7"] {
        for click_mode in [false, true] {
            let home = tempfile::tempdir_in("/tmp").unwrap();
            let sock = home.path().join("ipc.sock");
            let listener = UnixListener::bind(&sock).unwrap();
            let info = DaemonInfo::now(std::process::id(), sock.clone(), 0, "0.3.3");
            std::fs::write(
                home.path().join("daemon.json"),
                serde_json::to_vec(&info).unwrap(),
            )
            .unwrap();
            let methods = Arc::new(Mutex::new(Vec::new()));
            let seen = methods.clone();
            let server = tokio::spawn(async move {
                loop {
                    let (stream, _) = listener.accept().await.unwrap();
                    let (read, mut write) = stream.into_split();
                    let mut line = String::new();
                    BufReader::new(read).read_line(&mut line).await.unwrap();
                    let request: Value = serde_json::from_str(&line).unwrap();
                    let method = request["method"].as_str().unwrap();
                    seen.lock().unwrap().push(method.to_owned());
                    let result = match method {
                        "system.status" => {
                            json!({"daemon_version":"0.3.3","protocol_version":protocol,
                                "pid":std::process::id(),"uptime_secs":0,"ws_port":0,"sock_path":sock,
                                "browsers":[],"sessions":[]})
                        }
                        "tool.drag" => {
                            json!({"tab_id":42,"source":{"x":10,"y":10},"target":{"x":30,"y":10}})
                        }
                        _ => panic!("unexpected method: {method}"),
                    };
                    let mut bytes =
                        serde_json::to_vec(&json!({"id":request["id"],"result":result})).unwrap();
                    bytes.push(b'\n');
                    write.write_all(&bytes).await.unwrap();
                }
            });
            let mut command = Command::new(env!("CARGO_BIN_EXE_bsk"));
            command
                .env("BSK_HOME", home.path())
                .env("BSK_AUTO_START", "0")
                .env("BSK_AUTO_UPDATE", "off")
                .env_remove("BSK_CANCEL_ON_STDIN_CLOSE")
                .kill_on_drop(true);
            command.args(["drag", "@e1", "--to", "@e2"]);
            if click_mode {
                command.args(["--mode", "click-move-click"]);
            }
            let out = tokio::time::timeout(
                Duration::from_secs(5),
                command.args(["--session", "fixture", "--json"]).output(),
            )
            .await
            .unwrap()
            .unwrap();
            server.abort();
            let _ = server.await;
            let reply: Value = serde_json::from_slice(&out.stdout).unwrap();
            let blocked = protocol == "1.6" && click_mode;
            assert_eq!(
                out.status.success(),
                !blocked,
                "protocol={protocol}, click={click_mode}: {reply}"
            );
            let methods = methods.lock().unwrap();
            if blocked {
                assert!(reply["message"].as_str().unwrap().contains("protocol 1.7"));
                assert!(
                    methods.iter().all(|m| m == "system.status"),
                    "input sent: {methods:?}"
                );
            } else {
                assert_eq!(methods.iter().filter(|m| *m == "tool.drag").count(), 1);
            }
        }
    }
}
