//! Exercise `bsk plan` through the actual CLI process against a fake daemon.
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

/// `refuse` names the IPC method that answers with a structured refusal.
async fn run_cli(
    protocol: &'static str,
    args: &[&str],
    refuse: Option<&'static str>,
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
            let method = request["method"].as_str().unwrap();
            let mut response = json!({"id":request["id"]});
            if refuse == Some(method) {
                response["error"] = json!({"code":"permission_denied","message":"Page changed",
                    "data":{"reason":"target_unavailable","effect_state":"none"}});
            } else {
                response["result"] = match method {
                    "system.status" => {
                        json!({"daemon_version":"0.4.0","protocol_version":protocol,
                        "pid":std::process::id(),"uptime_secs":0,"ws_port":0,"sock_path":sock,
                        "browsers":[],"sessions":[]})
                    }
                    "tool.cooperate" => {
                        json!({"tab_id":7,"context_id":"next","control_policy":"target",
                        "kind":"baseline","observation":{"text":"button Done"}})
                    }
                    _ => json!({"tab_id":7}),
                };
            }
            let mut response = serde_json::to_vec(&response).unwrap();
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

const FORM: &str = r##"[
    {"action":"fill","ref":"@e1","value":"Ada"},
    {"action":"click","ref":"@e2","expect":[{"target":"@e9","field":"text","equals":"$12"}]}
]"##;

fn tools(requests: &[Value]) -> Vec<&str> {
    requests
        .iter()
        .map(|request| request["method"].as_str().unwrap())
        .filter(|method| *method != "system.status")
        .collect()
}

#[tokio::test]
async fn context_reaches_only_the_actions_and_expect_only_its_own_step() {
    let args = [
        "plan",
        "--session",
        "s",
        "--context",
        "c",
        "--observation",
        "unused",
        "--steps",
        FORM,
    ];
    let (output, requests) = run_cli("2.0", &args, None).await;
    assert!(output.status.success(), "{output:?}");
    let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reply["ok"], true);
    assert_eq!(reply["completed"], 2);
    assert_eq!(reply["post"]["context_id"], "next");
    assert_eq!(
        tools(&requests),
        ["tool.fill", "tool.click", "tool.cooperate"]
    );
    let actions: Vec<_> = requests
        .iter()
        .filter(|request| matches!(request["method"].as_str(), Some("tool.fill" | "tool.click")))
        .collect();
    for action in &actions {
        assert_eq!(action["params"]["context_id"], "c");
        assert!(action["params"].get("observation_id").is_none());
    }
    assert!(actions[0]["params"].get("expect").is_none());
    assert_eq!(actions[1]["params"]["expect"][0]["equals"], "$12");
    assert_eq!(actions[1]["params"]["tab_id"], 7);
}

#[tokio::test]
async fn a_refused_step_stops_the_plan_with_a_nonzero_exit_and_fresh_state() {
    let args = ["plan", "--session", "s", "--context", "c", "--steps", FORM];
    let (output, requests) = run_cli("2.0", &args, Some("tool.fill")).await;
    assert!(!output.status.success());
    let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["completed"], 0);
    assert_eq!(reply["stopped"]["effect_state"], "none");
    assert_eq!(reply["stopped"]["action"], "fill");
    assert_eq!(reply["not_run"], json!([1]));
    assert_eq!(reply["post"]["context_id"], "next");
    assert_eq!(tools(&requests), ["tool.fill", "tool.cooperate"]);
}

#[tokio::test]
async fn an_old_daemon_is_rejected_before_any_step() {
    for protocol in ["1.9", "3.0"] {
        let args = ["plan", "--session", "s", "--context", "c", "--steps", FORM];
        let (output, requests) = run_cli(protocol, &args, None).await;
        assert!(!output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("incompatible") && stderr.contains("2.0"),
            "{stderr}"
        );
        assert!(tools(&requests).is_empty());
    }
}

#[tokio::test]
async fn an_invalid_plan_or_global_expect_never_reaches_the_daemon() {
    let expect = r##"[{"target":"#price","field":"text","equals":"$12"}]"##;
    for args in [
        vec!["plan", "--session", "s", "--steps", "not json"],
        vec!["plan", "--session", "s", "--steps", "[]"],
        vec![
            "plan",
            "--session",
            "s",
            "--steps",
            r#"[{"action":"navigate","url":"https://example.org/"}]"#,
        ],
        vec![
            "plan",
            "--session",
            "s",
            "--expect",
            expect,
            "--steps",
            FORM,
        ],
        vec![
            "plan",
            "--session",
            "s",
            "--depends-on",
            "@e1",
            "--steps",
            FORM,
        ],
    ] {
        let (output, requests) = run_cli("2.0", &args, None).await;
        assert!(!output.status.success(), "{args:?}");
        assert!(requests.is_empty(), "{args:?}");
    }
}
