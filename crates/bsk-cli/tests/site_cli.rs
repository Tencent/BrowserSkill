//! End-to-end `bsk site` coverage against a real `BSK_HOME`.
//!
//! These run the built binary rather than the library so the exit codes, the
//! `--json` envelope and the on-disk layout are all exercised the way an agent
//! sees them. None of the commands may start or need the daemon, so the whole
//! file runs with `BSK_AUTO_START=0`.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;

fn bin() -> PathBuf {
    // `CARGO_BIN_EXE_<name>` is set by cargo for integration tests.
    PathBuf::from(env!("CARGO_BIN_EXE_bsk"))
}

struct Env {
    home: tempfile::TempDir,
}

impl Env {
    fn new() -> Self {
        Self {
            home: tempfile::tempdir().expect("temp home"),
        }
    }

    fn sites(&self) -> PathBuf {
        self.home.path().join("sites")
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(bin())
            .args(args)
            .env("BSK_HOME", self.home.path())
            .env("BSK_AUTO_START", "0")
            // Keep the update-check probe and tracing out of the captured output.
            .env("BSK_NO_UPDATE_CHECK", "1")
            .output()
            .expect("run bsk")
    }

    fn ok(&self, args: &[&str]) -> String {
        let out = self.run(args);
        assert!(
            out.status.success(),
            "expected success from {args:?}\nstdout: {}\nstderr: {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn json(&self, args: &[&str]) -> Value {
        let mut argv = vec!["--json"];
        argv.extend_from_slice(args);
        let text = self.ok(&argv);
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("{args:?} -> {text}: {e}"))
    }

    /// Run a command expected to fail, returning `(exit code, parsed --json)`.
    fn json_err(&self, args: &[&str]) -> (i32, Value) {
        let mut argv = vec!["--json"];
        argv.extend_from_slice(args);
        let out = self.run(&argv);
        assert!(!out.status.success(), "expected failure from {args:?}");
        let text = String::from_utf8_lossy(&out.stdout);
        let value = serde_json::from_str(&text)
            .unwrap_or_else(|e| panic!("{args:?} produced non-JSON {text}: {e}"));
        (out.status.code().unwrap_or(-1), value)
    }
}

/// A trace bundle shaped exactly like `bsk record start --output <dir>` writes
/// one: page text lives in `states/`, and `trace.json` references it as `page`.
fn write_bundle(dir: &Path) -> PathBuf {
    std::fs::create_dir_all(dir.join("states")).unwrap();
    std::fs::write(
        dir.join("states").join("s1.txt"),
        "# bsk-observation 1\nRootWebArea \"新建工单\"\n",
    )
    .unwrap();
    let trace = serde_json::json!({
        "version": 3,
        "purpose": "提交一张工单",
        "recorded_at": "2026-09-12T09:31:00Z",
        "stopped_by": "user_finish",
        "entry": { "start_url": "https://ticket.corp.example/" },
        "recorder": { "bsk": "0.2.1", "vom": 1 },
        "states": [{
            "id": "s1",
            "url": "https://ticket.corp.example/new",
            "title": "新建工单",
            "page": "s1.txt"
        }],
        "steps": [
            { "op": "navigate", "id": 1, "state": "s1", "result": { "state": "s1" },
              "to": "https://ticket.corp.example/new", "cause": "user_typed" },
            { "op": "scroll", "id": 2, "state": "s1", "result": { "state": "s1" } },
            { "op": "fill", "id": 3, "state": "s1", "result": { "state": "s1" },
              "target": { "ref": "e12", "role": "textbox", "name": "title", "ctx": "工单信息" },
              "value": "打印机坏了", "commit": "blur" },
            { "op": "fill", "id": 4, "state": "s1", "result": { "state": "s1" },
              "target": { "ref": "e13", "role": "textbox", "name": "password" },
              "value": "***", "commit": "blur", "redacted": true },
            { "op": "click", "id": 5, "state": "s1", "result": { "state": "s1" },
              "target": { "ref": "e21", "role": "button", "name": "提交", "ctx": "底部操作栏" } }
        ]
    });
    let path = dir.join("trace.json");
    std::fs::write(&path, serde_json::to_string_pretty(&trace).unwrap()).unwrap();
    path
}

const SITE_MD: &str = "# ticket.corp.example\n\n\
需要公司 VPN 才能打开。 [verified 2026-09-15]\n\n\
新建工单入口是 /new。 [verified 2026-09-15]\n";

#[test]
fn full_chain_from_a_record_bundle_to_verified_memory() {
    let env = Env::new();
    let rec = env.home.path().join("rec");
    let trace = write_bundle(&rec);
    let trace = trace.to_string_lossy().into_owned();
    let host = "ticket.corp.example";

    // 1. context on an unknown host is empty but succeeds, and stages a draft.
    let context = env.json(&["site", "context", "--host", host, "--task", "T1"]);
    assert_eq!(context["revision"], 0);
    assert_eq!(context["readOnly"], false);
    assert_eq!(context["workflows"].as_array().unwrap().len(), 0);
    assert_eq!(context["pendingCandidates"], 0);
    let draft = PathBuf::from(context["draft"]["path"].as_str().unwrap());
    assert!(draft.is_dir(), "context must stage a draft");
    assert_eq!(context["draft"]["baseRevision"], context["revision"]);

    // 2. save derives a workflow from the bundle the recorder actually wrote.
    let saved = env.json(&[
        "site",
        "workflow",
        "save",
        "--from",
        &trace,
        "--id",
        "submit-ticket",
        "--task",
        "T1",
    ]);
    assert_eq!(saved["host"], host);
    assert_eq!(saved["steps"], 4, "scroll is dropped, 5 steps become 4");
    assert_eq!(saved["droppedSteps"], 1);
    assert_eq!(saved["needsReview"], true);

    // Neither the record-local ref nor any recorded value may reach disk.
    let workflow_json =
        std::fs::read_to_string(draft.join("workflows/submit-ticket.json")).unwrap();
    assert!(!workflow_json.contains("\"ref\""), "{workflow_json}");
    assert!(!workflow_json.contains("e12"), "{workflow_json}");
    assert!(!workflow_json.contains("打印机坏了"), "{workflow_json}");
    assert!(!workflow_json.contains("***"), "{workflow_json}");

    // 3. checkpoint publishes the draft.
    std::fs::write(draft.join("SITE.md"), SITE_MD).unwrap();
    let committed = env.json(&[
        "site",
        "checkpoint",
        "--host",
        host,
        "--task",
        "T1",
        "--reason",
        "direct_correction",
    ]);
    assert_eq!(committed["status"], "committed");
    assert_eq!(committed["revision"], 1);
    assert!(env.sites().join(host).join("SITE.md").is_file());

    // 4. show renders the published workflow.
    let shown = env.json(&["site", "workflow", "show", "submit-ticket", "--host", host]);
    assert_eq!(shown["strategy"], "ui-only");
    assert_eq!(shown["lastVerified"], Value::Null);
    let human = env.ok(&["site", "workflow", "show", "submit-ticket", "--host", host]);
    assert!(
        human.contains("1. navigate https://ticket.corp.example/new"),
        "{human}"
    );
    assert!(human.contains("last verified: never"), "{human}");

    // Freshly saved memory is UNVERIFIED, not STALE: nothing has expired.
    let listed = env.json(&["site", "workflow", "list", "--host", host]);
    assert_eq!(
        listed[0]["stale"], false,
        "a workflow saved now is not stale"
    );
    assert_eq!(listed[0]["unverified"], true);
    assert_eq!(listed[0]["needsReview"], true);
    let listed_human = env.ok(&["site", "workflow", "list", "--host", host]);
    assert!(listed_human.contains("UNVERIFIED"), "{listed_human}");
    assert!(!listed_human.contains("STALE"), "{listed_human}");

    // 5. verify --pass stamps it, clears the review flags, and advances the revision.
    let verified = env.json(&[
        "site",
        "workflow",
        "verify",
        "submit-ticket",
        "--host",
        host,
        "--pass",
    ]);
    assert_eq!(verified["outcome"], "pass");
    assert_eq!(verified["revision"], 2);
    assert_eq!(verified["clearedReview"], true);
    let listed = env.json(&["site", "workflow", "list", "--host", host]);
    assert_eq!(listed[0]["stale"], false);
    assert_eq!(listed[0]["unverified"], false);
    assert_eq!(
        listed[0]["needsReview"], false,
        "running the workflow through IS the review"
    );
    assert_eq!(listed[0]["daysSinceVerified"], 0);
    let listed_human = env.ok(&["site", "workflow", "list", "--host", host]);
    assert!(!listed_human.contains("NEEDS REVIEW"), "{listed_human}");
    assert!(!listed_human.contains("UNVERIFIED"), "{listed_human}");
    let shown_human = env.ok(&["site", "workflow", "show", "submit-ticket", "--host", host]);
    assert!(!shown_human.contains("[needs review]"), "{shown_human}");
    assert!(!shown_human.contains("still needs review"), "{shown_human}");

    // 6. candidates accumulate as pending evidence without touching memory.
    let added = env.json(&[
        "site",
        "candidate",
        "add",
        "--host",
        host,
        "--kind",
        "better_path",
        "--claim",
        "priority matches the option value, not the label",
    ]);
    let candidate_id = added["id"].as_str().unwrap().to_string();
    let shown = env.json(&["site", "candidate", "show", &candidate_id, "--host", host]);
    assert_eq!(shown["status"], "pending");
    let pending = env.json(&[
        "site",
        "candidate",
        "list",
        "--host",
        host,
        "--status",
        "pending",
    ]);
    assert_eq!(pending.as_array().unwrap().len(), 1);
}

#[test]
fn a_stale_expected_revision_conflicts_then_recovers_after_context() {
    let env = Env::new();
    let host = "ticket.corp.example";
    let context = env.json(&["site", "context", "--host", host, "--task", "T1"]);
    let draft = PathBuf::from(context["draft"]["path"].as_str().unwrap());
    std::fs::write(draft.join("SITE.md"), SITE_MD).unwrap();
    env.json(&[
        "site",
        "checkpoint",
        "--host",
        host,
        "--task",
        "T1",
        "--reason",
        "direct_correction",
    ]);

    // A second task branched from revision 0 now collides.
    let other = env.json(&["site", "context", "--host", host, "--task", "T2"]);
    let other_draft = PathBuf::from(other["draft"]["path"].as_str().unwrap());
    std::fs::write(other_draft.join("SITE.md"), SITE_MD).unwrap();
    let (code, conflict) = env.json_err(&[
        "site",
        "checkpoint",
        "--host",
        host,
        "--task",
        "T2",
        "--reason",
        "direct_correction",
        "--expected-revision",
        "0",
    ]);
    assert_eq!(conflict["status"], "conflict");
    assert_eq!(conflict["expected"], 0);
    assert_eq!(conflict["actual"], 1);
    assert_ne!(code, 0, "a conflict must not report success");

    // The documented recovery: re-read context, then checkpoint again.
    let refreshed = env.json(&["site", "context", "--host", host, "--task", "T2"]);
    assert_eq!(refreshed["draft"]["baseRevision"], 1);
    let committed = env.json(&[
        "site",
        "checkpoint",
        "--host",
        host,
        "--task",
        "T2",
        "--reason",
        "direct_correction",
    ]);
    assert_eq!(committed["status"], "committed");
    assert_eq!(committed["revision"], 2);
}

/// Every entry point applies the same credential-surface gate, and each failure
/// uses the CLI's standard `--json` error envelope.
#[test]
fn sensitive_hosts_are_refused_at_every_entry_point() {
    let env = Env::new();
    let rec = env.home.path().join("rec");
    let trace = write_bundle(&rec);
    let trace = trace.to_string_lossy().into_owned();

    let cases: Vec<Vec<&str>> = vec![
        vec!["site", "context", "--host", "okta.com"],
        vec![
            "site", "workflow", "save", "--from", &trace, "--id", "x", "--host", "okta.com",
        ],
        vec!["site", "workflow", "show", "x", "--host", "okta.com"],
        vec![
            "site", "workflow", "verify", "x", "--host", "okta.com", "--pass",
        ],
        vec![
            "site",
            "candidate",
            "add",
            "--host",
            "okta.com",
            "--kind",
            "access",
            "--claim",
            "x",
        ],
        vec!["site", "candidate", "list", "--host", "okta.com"],
        vec![
            "site",
            "checkpoint",
            "--host",
            "okta.com",
            "--task",
            "T1",
            "--reason",
            "direct_correction",
        ],
    ];
    for args in cases {
        let (code, body) = env.json_err(&args);
        assert_eq!(code, 1, "{args:?}");
        assert_eq!(body["code"], "invalid_params", "{args:?} -> {body}");
        assert_eq!(body["exit_code"], 1, "{args:?}");
        let message = body["message"].as_str().unwrap_or_default();
        assert!(
            message.contains("blocked domain") || message.contains("credential-surface"),
            "{args:?} -> {message}"
        );
    }
    assert!(!env.sites().join("okta.com").exists());
}

/// H2: a path or query must not be able to name a different host.
#[test]
fn userinfo_in_a_path_cannot_smuggle_a_host_past_the_gate() {
    let env = Env::new();
    let (_, body) = env.json_err(&[
        "site",
        "context",
        "--host",
        "https://login.microsoftonline.com/x@ticket.corp.example",
    ]);
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("login.microsoftonline.com"),
        "{body}"
    );

    // The benign case still resolves to the authority's host.
    let context = env.json(&[
        "site",
        "context",
        "--host",
        "https://a.example.com/r?to=x@okta.com",
    ]);
    assert_eq!(context["host"], "a.example.com");
}

#[test]
fn a_recording_cannot_be_refiled_under_a_different_host() {
    let env = Env::new();
    let rec = env.home.path().join("rec");
    let trace = write_bundle(&rec);
    let trace = trace.to_string_lossy().into_owned();
    let (_, body) = env.json_err(&[
        "site",
        "workflow",
        "save",
        "--from",
        &trace,
        "--id",
        "x",
        "--host",
        "elsewhere.example",
    ]);
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("recording starts on ticket.corp.example"),
        "{body}"
    );
}

#[test]
fn secrets_are_refused_in_candidates_and_in_site_md() {
    let env = Env::new();
    let host = "ticket.corp.example";
    let (_, body) = env.json_err(&[
        "site",
        "candidate",
        "add",
        "--host",
        host,
        "--kind",
        "access",
        "--claim",
        "send Authorization: Bearer abc123def456",
    ]);
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("bearer token"),
        "{body}"
    );

    let context = env.json(&["site", "context", "--host", host, "--task", "T1"]);
    let draft = PathBuf::from(context["draft"]["path"].as_str().unwrap());
    std::fs::write(
        draft.join("SITE.md"),
        "the session cookie=abc123 works [verified 2026-09-15]\n",
    )
    .unwrap();
    let (_, body) = env.json_err(&[
        "site",
        "checkpoint",
        "--host",
        host,
        "--task",
        "T1",
        "--reason",
        "direct_correction",
    ]);
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("cookie"),
        "{body}"
    );
    assert!(!env.sites().join(host).join("SITE.md").exists());
}

/// Ordinary candidates need a second sighting on a different UTC day;
/// `high_consequence` does not.
#[test]
fn candidate_ingestion_enforces_the_evidence_rule() {
    let env = Env::new();
    let host = "ticket.corp.example";
    let context = env.json(&["site", "context", "--host", host, "--task", "T1"]);
    let draft = PathBuf::from(context["draft"]["path"].as_str().unwrap());
    std::fs::write(draft.join("SITE.md"), SITE_MD).unwrap();

    let first = env.json(&[
        "site",
        "candidate",
        "add",
        "--host",
        host,
        "--kind",
        "better_path",
        "--claim",
        "use the priority dropdown",
    ]);
    let first_id = first["id"].as_str().unwrap().to_string();

    let (_, body) = env.json_err(&[
        "site",
        "checkpoint",
        "--host",
        host,
        "--task",
        "T1",
        "--reason",
        "candidate_ingestion",
        "--ingest",
        &first_id,
    ]);
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("two independent observations"),
        "{body}"
    );

    // A sighting recorded on another day corroborates it.
    let candidates = env.sites().join(host).join("candidates");
    std::fs::write(
        candidates.join("2026-01-02-001.json"),
        serde_json::json!({
            "id": "2026-01-02-001",
            "host": host,
            "observedDateUtc": "2026-01-02",
            "kind": "better_path",
            "claim": "Use the  priority DROPDOWN",
            "status": "pending"
        })
        .to_string(),
    )
    .unwrap();
    let committed = env.json(&[
        "site",
        "checkpoint",
        "--host",
        host,
        "--task",
        "T1",
        "--reason",
        "candidate_ingestion",
        "--ingest",
        &first_id,
    ]);
    assert_eq!(committed["status"], "committed");
    assert_eq!(
        committed["ingested"].as_array().unwrap(),
        &vec![Value::String(first_id.clone())]
    );
    let settled = env.json(&["site", "candidate", "show", &first_id, "--host", host]);
    assert_eq!(settled["status"], "ingested");
}

/// No `bsk site` command may start the daemon: agents run these under
/// `BSK_AUTO_START=0` in a sandbox.
#[test]
fn site_commands_never_start_the_daemon() {
    let env = Env::new();
    env.json(&[
        "site",
        "context",
        "--host",
        "ticket.corp.example",
        "--task",
        "T1",
    ]);
    env.json(&["site", "workflow", "list"]);
    assert!(!env.home.path().join("daemon.json").exists());
    assert!(!env.home.path().join("daemon.lock").exists());
}

/// A trace shaped like the real Wikipedia recording that broke derivation:
/// it opens on a `select` rather than a navigation, carries an `about:blank`
/// left by backing out past the start page, and names its controls with the
/// VOM's bracketed state annotations.
fn write_noisy_bundle(dir: &Path) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let trace = serde_json::json!({
        "version": 3,
        "recorded_at": "2026-09-16T01:00:00Z",
        "stopped_by": "user_finish",
        "entry": { "start_url": "https://www.wikipedia.org/" },
        "recorder": { "bsk": "0.2.1", "vom": 1 },
        "states": [],
        "steps": [
            { "op": "select", "id": 1, "state": "s1", "result": { "state": "s1" },
              "target": { "ref": "e12", "role": "combobox", "name": "ZH [has-submenu]" },
              "selection": [{ "value": "zh", "label": "中文" }] },
            { "op": "fill", "id": 2, "state": "s1", "result": { "state": "s2" },
              "target": { "ref": "e11", "role": "searchbox", "name": "Search Wikipedia" },
              "value": "珠穆朗玛峰", "commit": "blur" },
            { "op": "navigate", "id": 3, "state": "s2", "result": { "state": "s3" },
              "to": "https://zh.wikipedia.org/wiki/x", "cause": "browser" },
            { "op": "navigate", "id": 4, "state": "s3", "result": { "state": "s4" },
              "to": "about:blank", "cause": "history" }
        ]
    });
    let path = dir.join("trace.json");
    std::fs::write(&path, serde_json::to_string_pretty(&trace).unwrap()).unwrap();
    path
}

/// S2: a recording full of ordinary noise must still derive. One
/// `about:blank` used to exit 1 and discard the whole bundle.
#[test]
fn a_noisy_recording_still_derives_a_usable_workflow() {
    let env = Env::new();
    let trace = write_noisy_bundle(&env.home.path().join("rec"));
    let trace = trace.to_string_lossy().into_owned();

    let saved = env.json(&[
        "site",
        "workflow",
        "save",
        "--from",
        &trace,
        "--id",
        "wiki-search",
        "--task",
        "T1",
    ]);
    // The host is where the recording started, not the article it landed on.
    assert_eq!(saved["host"], "wikipedia.org");
    // about:blank is dropped, not fatal; the article navigation the page
    // made after the search is an effect of the fill, not a step.
    assert_eq!(saved["droppedSteps"], 2, "{saved}");
    // navigate(entry) + select + fill
    assert_eq!(saved["steps"], 3);
    // The select's option value is a site constant, so it is not a parameter;
    // the typed search term still is, under a name free of `[has-submenu]`.
    assert_eq!(
        saved["params"].as_array().unwrap(),
        &[Value::String("search_wikipedia".into())]
    );

    let path = PathBuf::from(saved["path"].as_str().unwrap());
    let workflow: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let steps = workflow["steps"].as_array().unwrap();
    assert_eq!(steps[0]["op"], "navigate");
    assert_eq!(steps[0]["to"], "https://www.wikipedia.org/");
    assert_eq!(steps[1]["op"], "select");
    assert_eq!(steps[1]["value"], "zh");
    assert_eq!(steps[2]["valueFrom"], "search_wikipedia");
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(!raw.contains("珠穆朗玛峰"), "{raw}");
    assert!(
        steps.iter().all(|step| step["to"] != "about:blank"),
        "{raw}"
    );
    // It is reported as dropped rather than silently vanishing.
    assert!(
        workflow["reviewNotes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|note| note.as_str().unwrap().contains("about:blank")),
        "{raw}"
    );
    // The widget-state annotation describes recording-time state, not the
    // control's identity: it is dropped from the anchor and the parameter.
    assert_eq!(steps[1]["target"]["name"], "ZH");
    for param in workflow["params"].as_array().unwrap() {
        let name = param["name"].as_str().unwrap();
        assert!(!name.contains("submenu"), "{name}");
    }

    // The host the recording started on is the one `--host` must name.
    env.json(&[
        "site",
        "workflow",
        "save",
        "--from",
        &trace,
        "--id",
        "wiki-search",
        "--task",
        "T1",
        "--host",
        "www.wikipedia.org",
    ]);
    let (_, err) = env.json_err(&[
        "site",
        "workflow",
        "save",
        "--from",
        &trace,
        "--id",
        "wiki-search",
        "--task",
        "T1",
        "--host",
        "zh.wikipedia.org",
    ]);
    assert!(
        err["message"]
            .as_str()
            .unwrap()
            .contains("starts on wikipedia.org"),
        "{err}"
    );
}

/// A workflow staged but not yet checkpointed is still this task's workflow.
/// Hiding it made `workflow save` look like it had done nothing.
#[test]
fn context_lists_the_drafts_own_unpublished_workflows() {
    let env = Env::new();
    let trace = write_bundle(&env.home.path().join("rec"));
    let trace = trace.to_string_lossy().into_owned();
    let host = "ticket.corp.example";
    env.json(&[
        "site",
        "workflow",
        "save",
        "--from",
        &trace,
        "--id",
        "submit-ticket",
        "--task",
        "T1",
    ]);

    let context = env.json(&["site", "context", "--host", host, "--task", "T1"]);
    let listed = context["workflows"].as_array().unwrap();
    assert_eq!(listed.len(), 1, "{context}");
    assert_eq!(listed[0]["id"], "submit-ticket");
    assert_eq!(listed[0]["draft"], true);
    let human = env.ok(&["site", "context", "--host", host, "--task", "T1"]);
    assert!(human.contains("DRAFT"), "{human}");

    // Another task must not see it, and nor must a context without --task.
    let other = env.json(&["site", "context", "--host", host, "--task", "T2"]);
    assert_eq!(other["workflows"].as_array().unwrap().len(), 0);

    // Once published it is ordinary active memory, no longer flagged.
    env.json(&[
        "site",
        "checkpoint",
        "--host",
        host,
        "--task",
        "T1",
        "--reason",
        "direct_correction",
    ]);
    let context = env.json(&["site", "context", "--host", host, "--task", "T1"]);
    assert_eq!(context["workflows"][0].get("draft"), None, "{context}");
}

/// S7: the documented conflict recovery must not discard the commit that won
/// the race. `context` re-seeds the draft from what is published; the agent
/// replays its own edit on top, and both lines survive.
#[test]
fn conflict_recovery_preserves_the_other_writers_commit() {
    let env = Env::new();
    let host = "ticket.corp.example";
    let a_line = "A 的事实。 [verified 2026-09-15]\n";
    let b_line = "B 的事实。 [verified 2026-09-15]\n";

    let a = env.json(&["site", "context", "--host", host, "--task", "TA"]);
    let b = env.json(&["site", "context", "--host", host, "--task", "TB"]);
    let a_draft = PathBuf::from(a["draft"]["path"].as_str().unwrap());
    let b_draft = PathBuf::from(b["draft"]["path"].as_str().unwrap());
    std::fs::write(a_draft.join("SITE.md"), a_line).unwrap();
    std::fs::write(b_draft.join("SITE.md"), b_line).unwrap();

    env.json(&[
        "site",
        "checkpoint",
        "--host",
        host,
        "--task",
        "TA",
        "--reason",
        "direct_correction",
    ]);
    let (_, conflict) = env.json_err(&[
        "site",
        "checkpoint",
        "--host",
        host,
        "--task",
        "TB",
        "--reason",
        "direct_correction",
    ]);
    assert_eq!(conflict["status"], "conflict");

    // Recovery: re-read context. The draft now holds A's published prose and
    // says so, so B knows its own edit has to be replayed.
    let refreshed = env.json(&["site", "context", "--host", host, "--task", "TB"]);
    assert_eq!(refreshed["draft"]["baseRevision"], 1);
    assert_eq!(refreshed["draft"]["rebased"], true);
    assert!(
        refreshed["draft"]["hint"]
            .as_str()
            .unwrap()
            .contains("replay your edits"),
        "{refreshed}"
    );
    let staged = std::fs::read_to_string(b_draft.join("SITE.md")).unwrap();
    assert_eq!(staged, a_line, "the draft must show what is published now");

    std::fs::write(b_draft.join("SITE.md"), format!("{a_line}{b_line}")).unwrap();
    let committed = env.json(&[
        "site",
        "checkpoint",
        "--host",
        host,
        "--task",
        "TB",
        "--reason",
        "direct_correction",
    ]);
    assert_eq!(committed["revision"], 2);
    let published = std::fs::read_to_string(env.sites().join(host).join("SITE.md")).unwrap();
    assert!(published.contains("A 的事实"), "{published}");
    assert!(published.contains("B 的事实"), "{published}");
}

/// S7: one host's checkpoint must not push an untouched host's draft into the
/// conflict path. The revision counter lives under each host.
#[test]
fn revisions_are_scoped_to_one_host() {
    let env = Env::new();
    let site_md = "一条事实。 [verified 2026-09-15]\n";
    for host in ["ticket.corp.example", "example.org"] {
        let context = env.json(&["site", "context", "--host", host, "--task", "T1"]);
        assert_eq!(context["revision"], 0, "{host} starts at 0");
        let draft = PathBuf::from(context["draft"]["path"].as_str().unwrap());
        std::fs::write(draft.join("SITE.md"), site_md).unwrap();
        let committed = env.json(&[
            "site",
            "checkpoint",
            "--host",
            host,
            "--task",
            "T1",
            "--reason",
            "direct_correction",
        ]);
        assert_eq!(
            committed["revision"], 1,
            "{host} commits its own revision 1"
        );
    }
    assert!(!env.sites().join(".revision").exists(), "no global counter");
    for host in ["ticket.corp.example", "example.org"] {
        assert!(env.sites().join(host).join(".revision").is_file());
        assert!(env.sites().join(host).join(".journal.jsonl").is_file());
    }
}

/// S10: the draft tree used to be world-listable, exposing task ids to any
/// other account on the machine, and the lock file was world-readable.
#[cfg(unix)]
#[test]
fn site_memory_is_private_on_disk() {
    use std::os::unix::fs::PermissionsExt;
    let env = Env::new();
    let host = "ticket.corp.example";
    let context = env.json(&["site", "context", "--host", host, "--task", "T1"]);
    let draft = PathBuf::from(context["draft"]["path"].as_str().unwrap());
    std::fs::write(draft.join("SITE.md"), SITE_MD).unwrap();
    env.json(&[
        "site",
        "checkpoint",
        "--host",
        host,
        "--task",
        "T1",
        "--reason",
        "direct_correction",
    ]);
    env.json(&[
        "site",
        "candidate",
        "add",
        "--host",
        host,
        "--kind",
        "better_path",
        "--claim",
        "the dropdown is faster",
    ]);

    let mode = |path: PathBuf| {
        let meta = std::fs::metadata(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        (path, meta.permissions().mode() & 0o777)
    };
    let sites = env.sites();
    for (path, mode) in [
        mode(sites.clone()),
        mode(sites.join(".drafts")),
        mode(sites.join(".drafts").join("t1")),
        mode(draft.clone()),
        mode(sites.join(host)),
        mode(sites.join(host).join("candidates")),
    ] {
        assert_eq!(mode, 0o700, "{} must be 0700", path.display());
    }
    for (path, mode) in [
        mode(sites.join(".lock")),
        mode(sites.join(host).join(".revision")),
        mode(sites.join(host).join(".journal.jsonl")),
        mode(sites.join(host).join("SITE.md")),
        mode(draft.join(".context.json")),
    ] {
        assert_eq!(mode, 0o600, "{} must be 0600", path.display());
    }
}

/// D1: `verify --pass` used to clear `needsReview` on an anchorless step too.
/// The validator rightly refuses an unflagged anchorless step, so every later
/// checkpoint on that host failed. A pass now leaves those steps flagged.
#[test]
fn verify_pass_keeps_anchorless_steps_flagged_so_later_checkpoints_still_pass() {
    let env = Env::new();
    let dir = env.home.path().join("rec");
    std::fs::create_dir_all(&dir).unwrap();
    let trace = serde_json::json!({
        "version": 3,
        "recorded_at": "2026-09-16T01:00:00Z",
        "stopped_by": "user_finish",
        "entry": { "start_url": "https://www.wikipedia.org/" },
        "recorder": { "bsk": "0.2.1", "vom": 1 },
        "states": [],
        "steps": [
            { "op": "fill", "id": 1, "state": "s1", "result": { "state": "s1" },
              "target": { "ref": "e11", "role": "searchbox", "name": "Search Wikipedia" },
              "value": "珠穆朗玛峰", "commit": "blur" },
            { "op": "click", "id": 2, "state": "s1", "result": { "state": "s2" },
              "target": { "unmatched": true } }
        ]
    });
    let path = dir.join("trace.json");
    std::fs::write(&path, serde_json::to_string_pretty(&trace).unwrap()).unwrap();
    let trace = path.to_string_lossy().into_owned();
    let host = "wikipedia.org";

    env.json(&["site", "context", "--host", host, "--task", "A"]);
    env.json(&[
        "site", "workflow", "save", "--from", &trace, "--id", "wf", "--task", "A",
    ]);
    let committed = env.json(&[
        "site",
        "checkpoint",
        "--host",
        host,
        "--task",
        "A",
        "--reason",
        "direct_correction",
    ]);
    assert_eq!(committed["status"], "committed", "{committed}");

    let verified = env.json(&["site", "workflow", "verify", "wf", "--host", host, "--pass"]);
    assert_eq!(verified["outcome"], "pass");
    let listed = env.json(&["site", "workflow", "list", "--host", host]);
    assert_eq!(
        listed[0]["needsReview"], false,
        "workflow-level flag clears"
    );

    // A later task on the same host must still be able to publish.
    env.json(&["site", "context", "--host", host, "--task", "B"]);
    let site_md = env.sites().join(".drafts/B").join(host).join("SITE.md");
    std::fs::write(
        &site_md,
        "# wikipedia.org\n\n- fact. [verified 2026-09-16]\n",
    )
    .unwrap();
    let committed = env.json(&[
        "site",
        "checkpoint",
        "--host",
        host,
        "--task",
        "B",
        "--reason",
        "direct_correction",
    ]);
    assert_eq!(committed["status"], "committed", "{committed}");

    let shown = env.json(&["site", "workflow", "show", "wf", "--host", host]);
    let steps = shown["steps"].as_array().unwrap();
    let anchorless = steps.iter().find(|s| s["op"] == "click").unwrap();
    assert_eq!(anchorless["needsReview"], true, "{shown}");
}
