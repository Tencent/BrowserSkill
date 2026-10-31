//! Exercise policy negotiation and explicit conditions through the actual CLI process.
#![cfg(unix)]

use bsk::daemon::info::DaemonInfo;
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
};

async fn run_cli(
    protocol: &'static str,
    args: &[&str],
    tool_reply: Value,
) -> (std::process::Output, Vec<Value>) {
    let home = tempfile::tempdir_in("/tmp").unwrap();
    let sock = home.path().join("ipc.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let info = DaemonInfo::now(std::process::id(), sock.clone(), 0, "0.4.0");
    std::fs::write(
        home.path().join("daemon.json"),
        serde_json::to_vec(&info).unwrap(),
    )
    .unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = requests.clone();
    let server = tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut line = String::new();
            BufReader::new(read).read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            captured.lock().unwrap().push(request.clone());
            let result = if request["method"] == "system.status" {
                json!({"daemon_version":"0.4.0","protocol_version":protocol,
                    "pid":std::process::id(),"uptime_secs":0,"ws_port":0,"sock_path":sock,
                    "browsers":[],"sessions":[]})
            } else {
                tool_reply.clone()
            };
            let mut response =
                serde_json::to_vec(&json!({"id":request["id"], "result":result})).unwrap();
            response.push(b'\n');
            write.write_all(&response).await.unwrap();
        }
    });
    let command = Command::new(env!("CARGO_BIN_EXE_bsk"))
        .env("BSK_HOME", home.path())
        .env("BSK_AUTO_START", "0")
        .env("BSK_AUTO_UPDATE", "off")
        .env_remove("BSK_CANCEL_ON_STDIN_CLOSE")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let output = tokio::time::timeout(Duration::from_secs(5), command.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    server.abort();
    let _ = server.await;
    let requests = requests.lock().unwrap().clone();
    (output, requests)
}

#[tokio::test]
async fn incompatible_daemon_cannot_silently_drop_new_action_evidence() {
    for protocol in ["1.7", "2.0"] {
        for extra in [
            vec![
                "--expect",
                r##"[{"target":"#price","field":"text","equals":"$12"}]"##,
            ],
            vec!["--observation", "observed"],
        ] {
            let mut args = vec!["click", "@e1", "--session", "s", "--context", "c", "--json"];
            args.extend(extra);
            let (output, requests) =
                run_cli(protocol, &args, json!({"tab_id":7,"x":1,"y":2})).await;
            assert!(!output.status.success());
            let error: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert!(
                error["message"]
                    .as_str()
                    .unwrap()
                    .contains("daemon protocol 1.8")
            );
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0]["method"], "system.status");
            assert!(
                error["message"]
                    .as_str()
                    .unwrap()
                    .contains("compatible 1.x")
            );
        }
    }
}

#[tokio::test]
async fn target_sync_requires_acknowledgement_but_strict_remains_compatible() {
    for policy in [None, Some("strict")] {
        let mut args = vec!["cooperate", "sync", "--session", "s", "--json"];
        if let Some(policy) = policy {
            args.extend(["--policy", policy]);
        }
        let (output, requests) =
            run_cli("1.7", &args, json!({"tab_id":7,"context_id":"legacy"})).await;
        assert_eq!(
            requests[1]["params"]["control_policy"],
            policy.unwrap_or("auto")
        );
        assert_eq!(output.status.success(), policy.is_some());
        let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
        if policy.is_none() {
            assert_eq!(reply["code"], "unsupported");
            assert_eq!(reply["data"]["effect_state"], "none");
            assert!(reply.get("context_id").is_none());
            assert!(
                reply["message"]
                    .as_str()
                    .unwrap()
                    .contains("every sync/enable and step")
            );
        }
    }
}

#[tokio::test]
async fn current_daemon_receives_exact_conditions_without_extra_status_calls() {
    let checks = json!([
        {"target":"#price","field":"text","equals":"  $12 [sale]  "},
        {"target":format!("#{}", "中".repeat(400)),"field":"exists","equals":true}
    ])
    .to_string();
    let (output, requests) = run_cli(
        "1.8",
        &[
            "click",
            "@e1",
            "--session",
            "s",
            "--context",
            "c",
            "--observation",
            "observed",
            "--expect",
            &checks,
            "--json",
        ],
        json!({"tab_id":7,"x":1,"y":2}),
    )
    .await;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1]["method"], "tool.click");
    let params = &requests[1]["params"];
    assert_eq!(params["context_id"], "c");
    assert_eq!(params["observation_id"], "observed");
    assert_eq!(
        params["expect"],
        serde_json::from_str::<Value>(&checks).unwrap()
    );
}
