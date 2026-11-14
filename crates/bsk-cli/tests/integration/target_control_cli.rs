//! Exercise policy negotiation and explicit conditions through the actual CLI process.
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
    let mut command = Command::new(env!("CARGO_BIN_EXE_bsk"));
    command
        .env("BSK_HOME", home.path())
        .env("BSK_AUTO_START", "0")
        .env("BSK_AUTO_UPDATE", "off")
        .env_remove("BSK_CANCEL_ON_STDIN_CLOSE")
        .env_remove("BSK_SESSION")
        .env_remove("BSK_SCOPE");
    for key in [
        "CLAUDE_CODE_AGENT_ID",
        "CODEX_THREAD_ID",
        "ANTIGRAVITY_CONVERSATION_ID",
        "CURSOR_TRACE_ID",
        "DSH_SESSION_ID",
    ] {
        command.env_remove(key);
    }
    let command = command
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
    for protocol in ["1.9", "3.0"] {
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
            let message = error["message"].as_str().unwrap();
            assert!(
                message.contains("incompatible") && message.contains("2.0"),
                "{error}"
            );
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0]["method"], "system.status");
        }
    }
}

#[tokio::test]
async fn explicit_target_policy_is_rejected_before_legacy_daemon_can_lock_the_session() {
    for protocol in ["1.9", "3.0"] {
        for mut args in [
            vec!["cooperate", "sync", "--session", "s"],
            vec!["cooperate", "enable", "--session", "s"],
            vec![
                "step",
                "--session",
                "s",
                "--context",
                "c",
                "--action",
                "click",
                "--params",
                r#"{"ref":"e1"}"#,
            ],
        ] {
            args.extend(["--policy", "target", "--json"]);
            let (output, requests) =
                run_cli(protocol, &args, json!({"tab_id":7,"context_id":"legacy"})).await;
            assert!(!output.status.success());
            let error: Value = serde_json::from_slice(&output.stdout).unwrap();
            let message = error["message"].as_str().unwrap();
            assert!(
                message.contains("incompatible") && message.contains("2.0"),
                "{error}"
            );
            assert_eq!(requests.len(), 1, "no action or negotiation may be sent");
            assert_eq!(requests[0]["method"], "system.status");
        }
    }
}

#[tokio::test]
async fn target_sync_requires_acknowledgement_but_strict_remains_compatible() {
    for policy in [None, Some("auto"), Some("strict")] {
        let mut args = vec!["cooperate", "sync", "--session", "s", "--json"];
        if let Some(policy) = policy {
            args.extend(["--policy", policy]);
        }
        let (output, requests) =
            run_cli("2.0", &args, json!({"tab_id":7,"context_id":"legacy"})).await;
        assert_eq!(
            requests[1]["params"]["control_policy"],
            policy.unwrap_or("auto")
        );
        assert_eq!(requests.len(), 2);
        assert_eq!(output.status.success(), policy == Some("strict"));
        let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
        if policy != Some("strict") {
            assert_eq!(reply["code"], "unsupported");
            assert_eq!(reply["data"]["effect_state"], "none");
            assert_eq!(reply["data"]["required_protocol"], "2.0");
            assert!(reply.get("context_id").is_none());
            assert!(
                reply["message"]
                    .as_str()
                    .unwrap()
                    .contains("require protocol 2.0+")
            );
        }
    }
}

#[tokio::test]
async fn compatible_daemon_receives_target_policy_without_extra_status_calls() {
    for protocol in ["2.0", "2.1"] {
        for action in ["sync", "enable"] {
            let (output, requests) = run_cli(
                protocol,
                &[
                    "cooperate",
                    action,
                    "--session",
                    "s",
                    "--policy",
                    "target",
                    "--json",
                ],
                json!({"tab_id":7,"context_id":"c","control_policy":"target"}),
            )
            .await;
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stdout)
            );
            assert_eq!(requests.len(), 2);
            assert_eq!(requests[0]["method"], "system.status");
            assert_eq!(requests[1]["method"], "tool.cooperate");
            assert_eq!(requests[1]["params"]["control_policy"], "target");
        }
    }
}

#[tokio::test]
async fn step_keeps_auto_compatible_and_forwards_target_to_a_current_daemon() {
    for (policy, acknowledged) in [("auto", false), ("target", true)] {
        let mut reply = json!({"tab_id":7,"context_id":"c"});
        if acknowledged {
            reply["control_policy"] = "target".into();
        }
        let (output, requests) = run_cli(
            "2.0",
            &[
                "step",
                "--session",
                "s",
                "--context",
                "c",
                "--action",
                "click",
                "--params",
                r#"{"ref":"e1"}"#,
                "--policy",
                policy,
                "--json",
            ],
            reply,
        )
        .await;
        assert_eq!(output.status.success(), acknowledged);
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0]["method"], "system.status");
        assert_eq!(requests[1]["method"], "tool.click");
        assert_eq!(requests[1]["params"]["context_id"], "c");
        assert_eq!(requests[2]["method"], "tool.cooperate");
        assert_eq!(requests[2]["params"]["control_policy"], policy);
        assert!(requests[2]["params"].get("context_id").is_none());
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["action"]["result"]["tab_id"], 7);
        assert_eq!(result["action_replayed"], false);
        if !acknowledged {
            assert_eq!(result["post_error"]["code"], "unsupported");
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
        "2.0",
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

#[tokio::test]
async fn dom_read_requires_new_daemon_and_never_falls_back_to_evaluate() {
    let result = json!({"tab_id":7,"page_url":"https://example.test/","frame_url":"https://example.test/",
        "frame_id":"root","title":"Test","captured_at":"now","scope":"current_dom","items":[],"truncated":false});
    for protocol in ["1.9", "2.0"] {
        let (output, calls) = run_cli(
            protocol,
            &[
                "read",
                "--session",
                "s",
                "--context",
                "c",
                "--selector",
                "#data",
                "--json",
            ],
            result.clone(),
        )
        .await;
        let data: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(output.status.success(), protocol == "2.0", "{data}");
        assert!(!calls.iter().any(|c| c["method"] == "tool.evaluate"));
        assert_eq!(
            calls.iter().filter(|c| c["method"] == "tool.read").count(),
            usize::from(protocol == "2.0")
        );
        if protocol == "1.9" {
            let msg = data["message"].as_str().unwrap();
            assert!(
                msg.contains("incompatible") && msg.contains("2.0"),
                "{data}"
            );
        } else {
            let read_call = calls.iter().find(|c| c["method"] == "tool.read").unwrap();
            assert_eq!(read_call["params"]["context_id"], "c");
        }
    }
    let (output, calls) = run_cli(
        "2.0",
        &[
            "read",
            "--session",
            "s",
            "--fields-json",
            r#"[{"key":"x","read":"text","expression":"setTimeout(()=>fetch('/write'),0)"}]"#,
            "--json",
        ],
        result,
    )
    .await;
    assert!(!output.status.success());
    assert!(
        !calls
            .iter()
            .any(|c| c["method"] == "tool.read" || c["method"] == "tool.evaluate")
    );
}

#[tokio::test]
async fn unguarded_commands_fail_closed_when_given_action_conditions_while_multi_phase_keeps_auxiliary_clean()
 {
    let expect_arg = r##"[{"target":"#price","field":"text","equals":"$12"}]"##;
    for base in [
        vec!["status"],
        vec!["doctor"],
        vec!["logs"],
        vec!["snapshot", "--session", "s"],
        vec!["observe", "--session", "s"],
        vec!["screenshot", "--session", "s"],
        vec!["wait-for-element", "#ready", "--session", "s"],
        vec!["tab", "list", "--session", "s"],
        vec!["tab", "create", "--session", "s"],
        vec!["debug", "requests", "--session", "s"],
        vec!["video", "status", "--session", "s"],
        vec!["sync", "--session", "s"],
    ] {
        for condition in [
            vec!["--context", "c"],
            vec!["--observation", "o"],
            vec!["--expect", expect_arg],
        ] {
            let mut args = base.clone();
            args.extend(condition);
            args.push("--json");
            let (output, calls) = run_cli("2.0", &args, json!({})).await;
            assert_eq!(output.status.code(), Some(1), "args: {args:?}");
            let err: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(err["code"], "invalid_params", "args: {args:?}");
            assert!(
                calls.is_empty(),
                "unexpected daemon calls for {args:?}: {calls:?}"
            );
        }
    }

    // `read` accepts `--context`, but rejects `--expect`, `--observation`, and `--depends-on`.
    for rejected in [
        vec!["--observation", "o"],
        vec!["--expect", expect_arg],
        vec!["--context", "c", "--depends-on", "@e1"],
    ] {
        let mut args = vec!["read", "--session", "s", "--selector", "#x", "--json"];
        args.extend(rejected);
        let (output, calls) = run_cli("2.0", &args, json!({})).await;
        assert_eq!(output.status.code(), Some(1), "args: {args:?}");
        let err: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(err["code"], "invalid_params", "args: {args:?}");
        assert!(
            calls.is_empty(),
            "unexpected daemon calls for {args:?}: {calls:?}"
        );
    }

    // `observe --probe-hover` IS guarded and forwards action conditions.
    let (output, calls) = run_cli(
        "2.0",
        &[
            "observe",
            "--probe-hover",
            "--session",
            "s",
            "--context",
            "c",
            "--expect",
            expect_arg,
            "--json",
        ],
        json!({"tab_id":7,"url":"https://example.test/","title":"T","viewport":{"width":800,"height":600},"observation_id":"o2","captured_at":"now","text":"page","node_count":1,"ref_count":0,"truncated":false}),
    )
    .await;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let observe_call = calls
        .iter()
        .find(|c| c["method"] == "tool.observe")
        .unwrap();
    assert_eq!(observe_call["params"]["context_id"], "c");
    assert!(observe_call["params"]["expect"].is_array());

    // Multi-phase `screenshot --full-page --out` attaches conditions ONLY to `tool.screenshot_full_page`,
    // keeping `tool.screenshot_read` and `tool.screenshot_release` clean.
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    let out_path = dir.path().join("full.png");
    let png_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    let (output, calls) = run_cli(
        "2.0",
        &[
            "screenshot",
            "--full-page",
            "--out",
            out_path.to_str().unwrap(),
            "--session",
            "s",
            "--context",
            "c",
            "--expect",
            expect_arg,
            "--json",
        ],
        json!({
            "tab_id": 7,
            "capture_id": "cap-1",
            "format": "png",
            "byte_size": 68,
            "width": 1,
            "height": 1,
            "data_base64": png_b64,
            "next_offset": 68,
            "eof": true,
            "released": true
        }),
    )
    .await;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let capture_call = calls
        .iter()
        .find(|c| c["method"] == "tool.screenshot_full_page")
        .unwrap();
    assert_eq!(capture_call["params"]["context_id"], "c");
    assert!(capture_call["params"]["expect"].is_array());
    for aux_method in ["tool.screenshot_read", "tool.screenshot_release"] {
        let aux = calls.iter().find(|c| c["method"] == aux_method).unwrap();
        assert!(aux["params"].get("context_id").is_none(), "{aux:?}");
        assert!(aux["params"].get("expect").is_none(), "{aux:?}");
    }
}
