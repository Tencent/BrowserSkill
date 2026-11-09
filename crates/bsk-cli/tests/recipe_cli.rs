//! Exercise `bsk recipe` through the actual CLI process against a fake daemon.
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

const FORM: &str =
    "@vom 1\nL1 page\n  heading \"Sales\"\n  @e1 combobox \"Region\"\n  @e2 button \"Search\"";
const DONE: &str = "@vom 1\nL1 page\n  heading \"Sales\"\n  @e1 combobox \"Region\"\n  @e2 button \"Search\"\n  status \"Total $42\"";

fn recipe() -> Value {
    json!({
        "recipe_version": 1,
        "name": "sales",
        "description": "Read a region's total",
        "site": {"origins": ["http://site.test"], "start": "/report"},
        "params": {"region": {"type": "enum", "values": ["East", "North"]}},
        "segments": [{
            "id": "query",
            "requires": [{"role": "heading", "name": "Sales"}],
            "steps": [
                {"action": "select", "target": {"role": "combobox", "name": "Region"}, "values": ["{{region}}"]},
                {"action": "click", "target": {"role": "button", "name": "Search"}}
            ],
            "until": {"text": "Total", "timeout_ms": 2000}
        }],
        "outputs": {"total": {"regex": "Total \\$(\\d+)", "required": true}}
    })
}

/// What the fake daemon answers. Each request is one connection, as in the real client.
#[derive(Clone)]
struct Script {
    protocol: &'static str,
    pages: Vec<&'static str>,
    /// Drop the connection when this method arrives, as a crashing daemon would.
    die_on: Option<&'static str>,
    /// Answer this method as a daemon that does not know it.
    rejects: Option<&'static str>,
    /// Answer this method as a daemon whose session is gone.
    missing: Option<&'static str>,
    run_log: Value,
}

impl Default for Script {
    fn default() -> Self {
        Self {
            protocol: "1.9",
            pages: vec![FORM, DONE],
            die_on: None,
            rejects: None,
            missing: None,
            run_log: json!({"steps":[],"observations":0,"truncated":false,"borrowed_tabs":[]}),
        }
    }
}

struct Home {
    dir: tempfile::TempDir,
}

impl Home {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir_in("/tmp").unwrap(),
        }
    }

    fn write(&self, name: &str, value: &Value) -> String {
        let path = self.dir.path().join(name);
        std::fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
        path.to_str().unwrap().to_owned()
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_bsk"));
        command
            .env("BSK_HOME", self.dir.path())
            .env("BSK_AUTO_START", "0")
            .env("BSK_AUTO_UPDATE", "off")
            .env("BSK_RECIPES", "1")
            .env_remove("BSK_CANCEL_ON_STDIN_CLOSE")
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command
    }

    /// Runs a command that needs no daemon.
    async fn local(&self, args: &[&str]) -> (std::process::Output, Value) {
        let output = tokio::time::timeout(
            Duration::from_secs(10),
            self.command(args).spawn().unwrap().wait_with_output(),
        )
        .await
        .unwrap()
        .unwrap();
        let reply = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
        (output, reply)
    }

    fn save(&self) {
        let file = self.write("recipe.json", &recipe());
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_bsk"))
            .env("BSK_HOME", self.dir.path())
            .env("BSK_RECIPES", "1")
            .env("BSK_AUTO_UPDATE", "off")
            .args(["recipe", "save", "--file", &file])
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
    }

    async fn with_daemon(
        &self,
        script: Script,
        args: &[&str],
    ) -> (std::process::Output, Value, Vec<Value>) {
        let sock = self.dir.path().join("ipc.sock");
        let _ = std::fs::remove_file(&sock);
        let listener = UnixListener::bind(&sock).unwrap();
        let info = DaemonInfo::now(std::process::id(), sock.clone(), 0, "0.4.0");
        std::fs::write(
            self.dir.path().join("daemon.json"),
            serde_json::to_vec(&info).unwrap(),
        )
        .unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let server = tokio::spawn(serve(listener, sock.clone(), script, captured));
        let output = tokio::time::timeout(
            Duration::from_secs(20),
            self.command(args).spawn().unwrap().wait_with_output(),
        )
        .await
        .unwrap()
        .unwrap();
        server.abort();
        let _ = server.await;
        let requests = requests.lock().unwrap().clone();
        let reply = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
        (output, reply, requests)
    }
}

async fn serve(
    listener: UnixListener,
    sock: std::path::PathBuf,
    script: Script,
    captured: Arc<Mutex<Vec<Value>>>,
) {
    let mut pages = script.pages.clone();
    loop {
        let (stream, _) = listener.accept().await.unwrap();
        let (read, mut write) = stream.into_split();
        let mut line = String::new();
        BufReader::new(read).read_line(&mut line).await.unwrap();
        let request: Value = serde_json::from_str(&line).unwrap();
        captured.lock().unwrap().push(request.clone());
        let method = request["method"].as_str().unwrap();
        if script.die_on == Some(method) {
            drop(write);
            continue;
        }
        if script.rejects == Some(method) {
            // How a daemon answers a method it has never heard of.
            let frame = json!({"id":"0","error":{"code":"protocol_error",
                "message":"invalid frame: unknown variant"}});
            let mut response = serde_json::to_vec(&frame).unwrap();
            response.push(b'\n');
            write.write_all(&response).await.unwrap();
            continue;
        }
        if script.missing == Some(method) {
            let frame = json!({"id":request["id"],"error":{"code":"not_found",
                "message":"session not registered or already stopped"}});
            let mut response = serde_json::to_vec(&frame).unwrap();
            response.push(b'\n');
            write.write_all(&response).await.unwrap();
            continue;
        }
        let result = match method {
            "system.status" => json!({"daemon_version":"0.4.0","protocol_version":script.protocol,
                "pid":std::process::id(),"uptime_secs":0,"ws_port":0,"sock_path":sock,
                "browsers":[],"sessions":[]}),
            "session.start" => json!({"session_id":"new","browser_instance_id":"b"}),
            "session.run_log" => script.run_log.clone(),
            "tool.tab_list" => json!({"tabs":[{"tab_id":7,"active":true,
                "url":"http://site.test/report"}]}),
            "tool.cooperate" => {
                let page = if pages.len() > 1 {
                    pages.remove(0)
                } else {
                    pages[0]
                };
                json!({"tab_id":7,"context_id":"c","control_policy":"target","kind":"baseline",
                    "observation":{"text":page}})
            }
            "tool.network" => json!({"tab_id":7,"next_since":1,"entries":[
                {"sequence":1,"kind":"response","method":"POST",
                 "url":"http://site.test/api/save?secret=1"}]}),
            _ => json!({"tab_id":7}),
        };
        let mut response =
            serde_json::to_vec(&json!({"id":request["id"],"result":result})).unwrap();
        response.push(b'\n');
        write.write_all(&response).await.unwrap();
    }
}

fn methods(requests: &[Value]) -> Vec<&str> {
    requests
        .iter()
        .map(|request| request["method"].as_str().unwrap())
        .filter(|method| *method != "system.status")
        .collect()
}

fn inputs(requests: &[Value]) -> Vec<&Value> {
    requests
        .iter()
        .filter(|request| {
            matches!(
                request["method"].as_str(),
                Some("tool.click" | "tool.select" | "tool.fill")
            )
        })
        .collect()
}

#[tokio::test]
async fn the_cli_needs_no_switch_and_lists_the_command() {
    let home = Home::new();
    let mut command = home.command(&["recipe", "list"]);
    command.env_remove("BSK_RECIPES");
    let output = command.spawn().unwrap().wait_with_output().await.unwrap();
    assert!(output.status.success(), "{output:?}");
    let listed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(listed["recipes"], json!([]));

    let mut command = home.command(&["--help"]);
    command.env_remove("BSK_RECIPES");
    let output = command.spawn().unwrap().wait_with_output().await.unwrap();
    let help = String::from_utf8_lossy(&output.stdout);
    assert!(help.contains("recipe"), "{help}");
    assert!(!help.contains("experimental"), "{help}");
}

#[tokio::test]
async fn recipes_are_saved_listed_shown_and_removed_without_a_daemon() {
    let home = Home::new();
    let (_, listed) = home.local(&["recipe", "list"]).await;
    assert_eq!(listed["recipes"], json!([]));

    let file = home.write("recipe.json", &recipe());
    let (output, saved) = home.local(&["recipe", "save", "--file", &file]).await;
    assert!(output.status.success(), "{output:?}");
    assert_eq!(saved["revision"], 1);
    assert_eq!(saved["status"], "draft");
    assert_eq!(saved["summary"]["steps"][1]["risk"], "reversible");
    let (_, listed) = home.local(&["recipe", "list"]).await;
    assert_eq!(listed["recipes"][0]["name"], "sales");
    assert_eq!(listed["recipes"][0]["params"]["region"]["type"], "enum");
    let (_, shown) = home.local(&["recipe", "show", "sales"]).await;
    assert_eq!(shown["recipe"]["revision"], 1);
    assert_eq!(shown["state"]["runs"], 0);

    let (output, removed) = home.local(&["recipe", "rm", "sales"]).await;
    assert!(output.status.success());
    assert_eq!(removed["removed"], true);
    let (output, missing) = home.local(&["recipe", "show", "sales"]).await;
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(missing["reason"], "recipe_not_found");
}

#[tokio::test]
async fn an_invalid_file_is_refused_with_the_cause() {
    let home = Home::new();
    let mut commit = recipe();
    commit["segments"][0]["steps"][1]["target"]["name"] = "提交".into();
    let file = home.write("bad.json", &commit);
    let (output, saved) = home.local(&["recipe", "save", "--file", &file]).await;
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(saved["saved"], false);
    assert!(
        saved["message"].as_str().unwrap().contains("commit step"),
        "{saved}"
    );
    assert_eq!(
        home.local(&["recipe", "list"]).await.1["recipes"],
        json!([])
    );
}

#[tokio::test]
async fn a_session_that_is_gone_is_refused_and_never_makes_a_recipe_stale() {
    let home = Home::new();
    home.save();
    let args = [
        "recipe",
        "run",
        "sales",
        "--param",
        "region=East",
        "--session",
        "gone",
    ];
    // Whether the daemon or the browser no longer knows the session.
    for missing in [
        "session.run_log",
        "tool.tab_list",
        "tool.tab_list",
        "tool.tab_list",
    ] {
        let script = Script {
            missing: Some(missing),
            ..Script::default()
        };
        let (output, reply, requests) = home.with_daemon(script, &args).await;
        assert_eq!(output.status.code(), Some(2), "{output:?}");
        assert_eq!(reply["status"], "refused", "{reply}");
        assert_eq!(reply["reason"], "session_unavailable");
        let message = reply["message"].as_str().unwrap();
        assert!(!message.contains("restart"), "{message}");
        assert!(inputs(&requests).is_empty());
    }
    let (_, shown) = home.local(&["recipe", "show", "sales"]).await;
    assert_eq!(shown["state"]["status"], "draft");
    assert_eq!(shown["state"]["handoff_streak"], 0);

    // A draft from a session that is gone says so, rather than "recorded no action".
    let script = Script {
        missing: Some("session.run_log"),
        ..Script::default()
    };
    let args = ["recipe", "draft", "--session", "gone", "--name", "fresh"];
    let (output, _, _) = home.with_daemon(script, &args).await;
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("session not registered"), "{stderr}");
    assert!(!stderr.contains("restart"), "{stderr}");
}

#[tokio::test]
async fn a_lowered_risk_runs_only_after_a_person_approves_it_at_a_terminal() {
    let home = Home::new();
    let mut lowered = recipe();
    lowered["segments"][0]["steps"][1]["target"]["name"] = "Save filters".into();
    lowered["segments"][0]["steps"][1]["risk"] = "reversible".into();
    let file = home.write("lowered.json", &lowered);
    let (output, saved) = home.local(&["recipe", "save", "--file", &file]).await;
    assert!(output.status.success(), "{output:?}");
    assert_eq!(saved["approval"], "required");
    assert_eq!(saved["summary"]["risk_downgrades"][0]["inferred"], "commit");
    assert_eq!(
        home.local(&["recipe", "list"]).await.1["recipes"][0]["approval"],
        "required"
    );

    // Refused before any daemon or session is involved.
    let (output, reply) = home
        .local(&["recipe", "run", "sales", "--param", "region=East"])
        .await;
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert_eq!(reply["reason"], "approval_required");
    let message = reply["message"].as_str().unwrap();
    assert!(message.contains("bsk recipe approve sales"), "{message}");

    // An agent's piped input is not a person at a terminal, whatever it types.
    let mut command = home.command(&["recipe", "approve", "sales"]);
    command.stdin(Stdio::piped());
    let mut child = command.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(b"sales\n").await.unwrap();
    drop(stdin);
    let output = child.wait_with_output().await.unwrap();
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reply["reason"], "approval_needs_person");
    assert_eq!(
        home.local(&["recipe", "show", "sales"]).await.1["approval"],
        "required"
    );
}

#[tokio::test]
async fn a_run_opens_its_own_session_replays_once_and_closes_it() {
    let home = Home::new();
    home.save();
    let args = ["recipe", "run", "sales", "--param", "region=East"];
    let (output, reply, requests) = home.with_daemon(Script::default(), &args).await;
    assert!(output.status.success(), "{output:?}");
    assert_eq!(reply["status"], "completed", "{reply}");
    assert_eq!(reply["outputs"]["total"], "42");
    assert_eq!(reply["effects"]["steps_done"], 2);
    assert_eq!(reply["recipe"], "sales");
    assert_eq!(reply["session_stopped"], true);
    assert!(reply["run_id"].as_str().unwrap().starts_with("r-"));
    // The caller answers from the outputs: no page text comes back.
    assert!(reply.get("post").is_none());

    let names = methods(&requests);
    assert_eq!(names[0], "session.start");
    assert_eq!(*names.last().unwrap(), "session.stop");
    let start = requests
        .iter()
        .find(|r| r["method"] == "session.start")
        .unwrap();
    assert_eq!(start["params"]["task_name"], "recipe:sales");
    assert_eq!(start["params"]["controller"]["name"], "recipe:sales");
    let sent = inputs(&requests);
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0]["method"], "tool.select");
    assert_eq!(sent[0]["params"]["ref"], "@e1");
    assert_eq!(sent[0]["params"]["values"], json!(["East"]));
    assert_eq!(sent[0]["params"]["context_id"], "c");
    assert_eq!(sent[1]["method"], "tool.click");

    // The first success verifies the recipe, and its log holds no parameter value.
    let (_, shown) = home.local(&["recipe", "show", "sales"]).await;
    assert_eq!(shown["state"]["status"], "verified");
    assert_eq!(shown["state"]["completed"], 1);
    let runs = home.dir.path().join("recipes/sales/runs");
    let log = std::fs::read_dir(runs).unwrap().next().unwrap().unwrap();
    let log = std::fs::read_to_string(log.path()).unwrap();
    assert!(
        log.contains("params_digest") && log.contains("completed"),
        "{log}"
    );
    assert!(!log.contains("East"), "{log}");
}

#[tokio::test]
async fn a_caller_session_is_checked_first_and_left_open() {
    let home = Home::new();
    home.save();
    let args = [
        "recipe",
        "run",
        "sales",
        "--param",
        "region=North",
        "--session",
        "mine",
    ];
    let (output, reply, requests) = home.with_daemon(Script::default(), &args).await;
    assert!(output.status.success(), "{output:?}");
    assert_eq!(reply["session_id"], "mine");
    assert!(reply.get("session_stopped").is_none());
    let names = methods(&requests);
    assert_eq!(names[0], "session.run_log");
    assert!(!names.contains(&"session.start") && !names.contains(&"session.stop"));

    // A borrowed user tab is out of scope.
    let script = Script {
        run_log: json!({"steps":[],"observations":0,"truncated":false,"borrowed_tabs":[7]}),
        ..Script::default()
    };
    let (output, reply, requests) = home.with_daemon(script, &args).await;
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(reply["reason"], "borrowed_tab");
    assert!(inputs(&requests).is_empty());
}

#[tokio::test]
async fn a_changed_page_stops_before_input_and_leaves_the_session_for_the_caller() {
    let home = Home::new();
    home.save();
    let script = Script {
        pages: vec!["@vom 1\nL1 page\n  heading \"Sales\"\n  @e2 button \"Search\""],
        ..Script::default()
    };
    let args = ["recipe", "run", "sales", "--param", "region=East"];
    let (output, reply, requests) = home.with_daemon(script, &args).await;
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(reply["status"], "handoff");
    assert_eq!(reply["reason"], "target_not_found");
    assert_eq!(reply["at"]["segment"], "query");
    assert_eq!(reply["at"]["step"], 0);
    assert_eq!(reply["session_id"], "new");
    assert_eq!(reply["remaining"][0]["values"], json!(["East"]));
    assert!(
        reply["post"]["observation"]["text"]
            .as_str()
            .unwrap()
            .contains("Search")
    );
    assert!(inputs(&requests).is_empty());
    assert!(!methods(&requests).contains(&"session.stop"));
}

#[tokio::test]
async fn bad_parameters_are_refused_before_a_session_starts() {
    let home = Home::new();
    home.save();
    for (args, expected) in [
        (vec!["recipe", "run", "sales"], "missing param region"),
        (
            vec!["recipe", "run", "sales", "--param", "region=West"],
            "not one of",
        ),
        (
            vec![
                "recipe",
                "run",
                "sales",
                "--param",
                "region=East",
                "--param",
                "x=1",
            ],
            "unknown param",
        ),
    ] {
        let (output, reply, requests) = home.with_daemon(Script::default(), &args).await;
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert_eq!(reply["status"], "refused");
        assert!(
            reply["message"].as_str().unwrap().contains(expected),
            "{reply}"
        );
        assert!(methods(&requests).is_empty(), "{args:?}");
    }
    let (output, reply) = home.local(&["recipe", "run", "nothing"]).await;
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(reply["reason"], "recipe_not_found");
}

/// The failure that made replay guards necessary: the daemon dies after input is sent.
#[tokio::test]
async fn a_daemon_dying_during_a_click_is_uncertain_and_the_click_is_never_repeated() {
    let home = Home::new();
    home.save();
    let script = Script {
        die_on: Some("tool.click"),
        ..Script::default()
    };
    let args = ["recipe", "run", "sales", "--param", "region=East"];
    let (output, reply, requests) = home.with_daemon(script, &args).await;
    assert!(!output.status.success());
    assert_eq!(reply["status"], "uncertain", "{reply}");
    assert_eq!(reply["reason"], "effect_unknown");
    assert_eq!(reply["effects"]["last_effect_state"], "unknown");
    assert_eq!(reply["effects"]["steps_done"], 1);
    let clicks = inputs(&requests)
        .iter()
        .filter(|request| request["method"] == "tool.click")
        .count();
    assert_eq!(clicks, 1);
    assert!(!methods(&requests).contains(&"session.stop"));
    let (_, shown) = home.local(&["recipe", "show", "sales"]).await;
    assert_eq!(shown["state"]["uncertain"], 1);
    assert_eq!(shown["state"]["status"], "draft");

    // The recipe stays held, with no daemon running, until the caller names that run.
    let run_id = reply["run_id"].as_str().unwrap().to_owned();
    let (_, listed) = home.local(&["recipe", "list"]).await;
    assert_eq!(listed["recipes"][0]["unchecked_run"], run_id.as_str());
    for checked in [None, Some("r-someother")] {
        let mut again = args.to_vec();
        if let Some(checked) = checked {
            again.extend(["--checked", checked]);
        }
        let (output, held) = home.local(&again).await;
        assert_eq!(output.status.code(), Some(2), "{held}");
        assert_eq!(held["reason"], "effect_unchecked");
        let message = held["message"].as_str().unwrap();
        assert!(
            message.contains(&format!("--checked {run_id}")),
            "{message}"
        );
    }
    let mut checked = args.to_vec();
    checked.extend(["--checked", &run_id]);
    let (output, reply, _) = home.with_daemon(Script::default(), &checked).await;
    assert!(output.status.success(), "{output:?}");
    assert_eq!(reply["status"], "completed", "{reply}");
    let (_, listed) = home.local(&["recipe", "list"]).await;
    assert!(listed["recipes"][0].get("unchecked_run").is_none());
}

#[tokio::test]
async fn an_old_daemon_is_rejected_before_any_step() {
    let home = Home::new();
    home.save();
    let script = Script {
        protocol: "1.7",
        ..Script::default()
    };
    let args = ["recipe", "run", "sales", "--param", "region=East"];
    let (output, _, requests) = home.with_daemon(script, &args).await;
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("daemon protocol 1.8"), "{stderr}");
    assert!(methods(&requests).is_empty());
}

#[tokio::test]
async fn a_daemon_that_predates_the_run_log_says_to_restart_it() {
    let home = Home::new();
    home.save();
    let script = || Script {
        rejects: Some("session.run_log"),
        ..Script::default()
    };
    let args = [
        "recipe",
        "run",
        "sales",
        "--param",
        "region=East",
        "--session",
        "s",
    ];
    let (output, reply, requests) = home.with_daemon(script(), &args).await;
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(
        reply["message"]
            .as_str()
            .unwrap_or_default()
            .contains("restart"),
        "{reply}"
    );
    assert!(inputs(&requests).is_empty());

    let args = ["recipe", "draft", "--session", "s", "--name", "sales"];
    let (output, _, _) = home.with_daemon(script(), &args).await;
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("restart"), "{stderr}");
}

#[tokio::test]
async fn evidence_flags_do_not_apply_to_a_recipe() {
    let home = Home::new();
    home.save();
    let args = [
        "recipe",
        "run",
        "sales",
        "--context",
        "c",
        "--param",
        "region=East",
    ];
    let (output, _) = home.local(&args).await;
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("do not apply"), "{stderr}");
}

#[tokio::test]
async fn a_draft_comes_from_the_daemons_log_and_can_be_saved_after_review() {
    let home = Home::new();
    let script = Script {
        run_log: json!({"observations":1,"truncated":false,"borrowed_tabs":[],"steps":[
            {"kind":"navigate","origin":"http://site.test","path":"/report","dropped_query":false},
            {"kind":"action","action":"select","element":"e1","first_seen":1,"values":1,
             "target":{"role":"combobox","name":"Region"},"heading":"Sales"},
            {"kind":"action","action":"click","element":"e2","first_seen":1,
             "target":{"role":"button","name":"Search"},"heading":"Sales"}
        ]}),
        ..Script::default()
    };
    let out = home.dir.path().join("draft.json");
    let out = out.to_str().unwrap();
    let args = [
        "recipe",
        "draft",
        "--session",
        "s",
        "--name",
        "sales",
        "--description",
        "Read the total",
        "--out",
        out,
    ];
    let (output, reply, _) = home.with_daemon(script.clone(), &args).await;
    assert!(output.status.success(), "{output:?}");
    assert_eq!(reply["errors"], json!([]));
    let warnings = reply["warnings"].to_string();
    assert!(
        warnings.contains("POST http://site.test/api/save"),
        "{warnings}"
    );
    assert!(!warnings.contains("secret"), "{warnings}");
    assert_eq!(reply["draft"]["site"]["start"], "/report");
    assert_eq!(
        reply["draft"]["segments"][0]["steps"][0]["values"],
        json!(["{{region}}"])
    );

    let (output, saved) = home.local(&["recipe", "save", "--file", out]).await;
    assert!(output.status.success(), "{saved}");
    assert_eq!(saved["revision"], 1);

    // The file is not overwritten by a later draft.
    let (output, _, _) = home.with_daemon(Script::default(), &args).await;
    assert!(!output.status.success());

    // Nor is the saved recipe: a later draft under its name warns, and saving it is refused.
    let (output, reply, _) = home.with_daemon(script, &args[..8]).await;
    assert!(output.status.success(), "{output:?}");
    let warnings = reply["warnings"].to_string();
    assert!(
        warnings.contains("already exists at revision 1"),
        "{warnings}"
    );
    let again = home.write("again.json", &reply["draft"]);
    let (output, refused) = home.local(&["recipe", "save", "--file", &again]).await;
    assert_eq!(output.status.code(), Some(2), "{refused}");
    assert_eq!(refused["reason"], "recipe_exists");
}

/// One JSON-RPC exchange over `bsk mcp`.
async fn mcp(home: &Home, lines: &[Value]) -> Vec<Value> {
    let sock = home.dir.path().join("ipc.sock");
    let _ = std::fs::remove_file(&sock);
    let listener = UnixListener::bind(&sock).unwrap();
    let info = DaemonInfo::now(std::process::id(), sock.clone(), 0, "0.4.0");
    std::fs::write(
        home.dir.path().join("daemon.json"),
        serde_json::to_vec(&info).unwrap(),
    )
    .unwrap();
    let captured = Arc::new(Mutex::new(Vec::new()));
    let server = tokio::spawn(serve(listener, sock, Script::default(), captured));
    let mut command = home.command(&["mcp"]);
    command.stdin(Stdio::piped());
    let mut child = command.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut replies = Vec::new();
    for line in lines {
        let mut bytes = serde_json::to_vec(line).unwrap();
        bytes.push(b'\n');
        stdin.write_all(&bytes).await.unwrap();
        let mut reply = String::new();
        tokio::time::timeout(Duration::from_secs(15), stdout.read_line(&mut reply))
            .await
            .unwrap()
            .unwrap();
        replies.push(serde_json::from_str(&reply).unwrap());
    }
    drop(stdin);
    server.abort();
    let _ = server.await;
    replies
}

fn tool_call(id: u32, arguments: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":"tools/call",
        "params":{"name":"bsk_recipe","arguments":arguments}})
}

fn tool_reply(reply: &Value) -> (Value, bool) {
    let text = reply["result"]["content"][0]["text"].as_str().unwrap();
    (
        serde_json::from_str(text).unwrap(),
        reply["result"]["isError"].as_bool().unwrap(),
    )
}

#[tokio::test]
async fn mcp_clients_get_the_same_recipes_when_the_switch_is_on() {
    let home = Home::new();
    let replies = mcp(
        &home,
        &[
            json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
            tool_call(2, json!({"action":"save","recipe":recipe()})),
            tool_call(3, json!({"action":"list"})),
            tool_call(
                4,
                json!({"action":"run","name":"sales","params":{"region":"East"}}),
            ),
            tool_call(
                5,
                json!({"action":"run","name":"sales","params":{"region":"West"}}),
            ),
            tool_call(6, json!({"action":"run","params":{}})),
            tool_call(7, json!({"action":"list","name":"sales"})),
            tool_call(
                8,
                json!({"action":"run","name":"sales","session":"s","browser":"b"}),
            ),
            // Only a person at a terminal approves a lowered risk.
            tool_call(9, json!({"action":"approve","name":"sales"})),
        ],
    )
    .await;
    let tools: Vec<&str> = replies[0]["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert!(tools.contains(&"bsk_recipe"), "{tools:?}");
    assert_eq!(tool_reply(&replies[1]).0["saved"], true);
    assert_eq!(tool_reply(&replies[2]).0["recipes"][0]["name"], "sales");
    let (done, is_error) = tool_reply(&replies[3]);
    assert!(!is_error, "{done}");
    assert_eq!(done["status"], "completed");
    assert_eq!(done["outputs"]["total"], "42");
    let (bad, is_error) = tool_reply(&replies[4]);
    assert!(is_error);
    assert_eq!(bad["status"], "refused");
    for reply in &replies[5..] {
        assert!(tool_reply(reply).1, "{reply}");
    }
}

#[tokio::test]
async fn mcp_clients_do_not_see_the_tool_without_the_switch() {
    let home = Home::new();
    let mut command = home.command(&["mcp"]);
    command.env_remove("BSK_RECIPES").stdin(Stdio::piped());
    let mut child = command.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut send = async |line: Value| {
        let mut bytes = serde_json::to_vec(&line).unwrap();
        bytes.push(b'\n');
        stdin.write_all(&bytes).await.unwrap();
        let mut reply = String::new();
        stdout.read_line(&mut reply).await.unwrap();
        serde_json::from_str::<Value>(&reply).unwrap()
    };
    let listed = send(json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})).await;
    assert_eq!(listed["result"]["tools"].as_array().unwrap().len(), 7);
    let called = send(tool_call(2, json!({"action":"list"}))).await;
    assert!(called.get("error").is_some(), "{called}");
}
