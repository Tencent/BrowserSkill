//! Explicit local observation files. Viewing never contacts the daemon or issues a context.
use super::error::{CliError, Format};
use anyhow::{Context, ensure};
use clap::Args;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn digest(value: &Value) -> String {
    Sha256::digest(serde_json::to_vec(value).expect("JSON value"))
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[derive(Debug, Clone, Args)]
pub struct ViewArgs {
    /// A saved cooperate sync or step JSON reply. This is historical evidence.
    pub file: PathBuf,
    /// First VOM line to display (1-based).
    #[arg(long, default_value_t = 1, value_parser = clap::value_parser!(u32).range(1..))]
    pub start_line: u32,
    /// Maximum lines displayed; omission is always explicit.
    #[arg(long, default_value_t = 120, value_parser = clap::value_parser!(u32).range(1..=2000))]
    pub line_count: u32,
    /// Find a literal, case-sensitive string; report every matching line number.
    #[arg(long)]
    pub find: Option<String>,
}

pub(crate) fn read(path: &Path) -> anyhow::Result<Value> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .context("open observation file")?
        .take(32 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .context("read observation file")?;
    ensure!(
        bytes.len() <= 32 * 1024 * 1024,
        "observation file exceeds 32 MiB"
    );
    let mut value: Value = serde_json::from_slice(&bytes).context("decode observation file")?;
    if value.get("post").is_some() {
        value = value["post"].take();
    }
    ensure!(value.is_object(), "file contains no synchronization reply");
    Ok(value)
}

/// Reuse only an explicitly supplied, exact unchanged predecessor. Never rebase an action.
pub(crate) fn attach(reply: &mut Value, session: &str, baseline: Option<&Value>) {
    if reply.get("observation").is_some() {
        reply["observation_origin"] = json!({"kind":"capture","session_id":session,
            "capture_context_id":reply["context_id"],"payload_sha256":digest(&reply["observation"])});
        return;
    }
    let Some(old) = baseline else { return };
    let reusable = reply["kind"] == "unchanged"
        && reply["history_complete"] == true
        && reply["changes"].as_array().is_some_and(Vec::is_empty)
        && reply["previous_context_id"]
            .as_str()
            .is_some_and(|c| old["context_id"] == c)
        && reply["tab_id"].as_i64().is_some_and(|t| old["tab_id"] == t)
        && old["observation_origin"]["session_id"] == session
        && old
            .pointer("/observation/text")
            .and_then(Value::as_str)
            .is_some()
        && old["presentation"]["filtered"] != true
        && old["observation_origin"]["payload_sha256"] == digest(&old["observation"]);
    reply["cache_reuse"] = json!({"used":reusable,
        "reason":if reusable {"exact_unchanged_predecessor"} else {"no_exact_unchanged_predecessor"}});
    if reusable {
        reply["observation"] = old["observation"].clone();
        reply["observation_origin"] = old["observation_origin"].clone();
        reply["observation_origin"]["kind"] = "reused".into();
    }
}

pub fn dispatch(args: ViewArgs, _format: Format) -> Result<(), CliError> {
    let value = read(&args.file)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&project(&value, &args)?).context("render local view")?
    );
    Ok(())
}

fn project(value: &Value, args: &ViewArgs) -> anyhow::Result<Value> {
    let text = value
        .pointer("/observation/text")
        .and_then(Value::as_str)
        .context("file has no VOM; view its baseline file or synchronize with --baseline")?;
    ensure!(
        args.find.as_ref().is_none_or(|s| !s.trim().is_empty()),
        "--find must not be empty"
    );
    let lines: Vec<_> = text.lines().collect();
    let matches: Vec<_> = args
        .find
        .as_ref()
        .map(|s| {
            lines
                .iter()
                .enumerate()
                .filter_map(|(i, l)| l.contains(s).then_some(i + 1))
                .collect()
        })
        .unwrap_or_default();
    let start = if args.start_line == 1 && args.find.is_some() {
        // Reserve one line for the match, even in a one-line window.
        let leading = 12.min(args.line_count as usize - 1);
        matches
            .first()
            .copied()
            .unwrap_or(1)
            .saturating_sub(leading + 1)
    } else {
        args.start_line as usize - 1
    }
    .min(lines.len());
    let end = (start + args.line_count as usize).min(lines.len());
    Ok(
        json!({"historical":true,"browser_calls":0,"source_file":args.file,
        "source_context_id":value["context_id"],"observation_origin":value["observation_origin"],
        "observation_id":value["observation"]["observation_id"],"tab_id":value["tab_id"],
        "capture_truncated":value["observation"]["truncated"],
        "partial_view":start!=0 || end!=lines.len(),"total_lines":lines.len(),
        "start_line":start+1,"end_line":end,"matching_lines":matches,
        "no_match":args.find.is_some() && matches.is_empty(),"changes":value["changes"],
        "text":lines[start..end].join("\n"),
        "warning":"Historical local view; no new action context. Missing/truncated lines are unknown. Validate live state before acting; a new view does not refresh refs."}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn old() -> Value {
        let mut v = json!({"context_id":"c1","tab_id":42,"kind":"baseline","observation":{"text":"@vom 1\nL1 page\n  @e1 button \"A\"\n  @e2 button \"A\"\n  alert \"Price changed\"","truncated":false,"observation_id":"obs"}});
        attach(&mut v, "s", None);
        v
    }
    fn unchanged() -> Value {
        json!({"context_id":"c2","previous_context_id":"c1","tab_id":42,"kind":"unchanged","history_complete":true,"changes":[]})
    }
    #[test]
    fn unchanged_reuses_exact_baseline_without_reissuing_its_context() {
        let old = old();
        let mut v = unchanged();
        attach(&mut v, "s", Some(&old));
        assert_eq!(v["observation"], old["observation"]);
        assert_eq!(v["context_id"], "c2");
        assert_eq!(v["observation_origin"]["capture_context_id"], "c1");
        assert_eq!(v["observation_origin"]["kind"], "reused");
        let mut next = unchanged();
        next["previous_context_id"] = "c2".into();
        next["context_id"] = "c3".into();
        attach(&mut next, "s", Some(&v));
        assert_eq!(next["observation"], old["observation"]);
    }
    #[test]
    fn mismatch_delta_history_gap_filtered_or_cross_session_never_reuses() {
        for variant in 0..8 {
            let mut old = old();
            let mut v = unchanged();
            let session = if variant == 0 { "other" } else { "s" };
            match variant {
                1 => v["previous_context_id"] = "other".into(),
                2 => v["tab_id"] = 99.into(),
                3 => v["kind"] = "delta".into(),
                4 => v["history_complete"] = false.into(),
                5 => v["changes"] = json!([{"value":"new"}]),
                6 => old["presentation"] = json!({"filtered":true}),
                7 => old["observation"]["text"] = "edited cached contents".into(),
                _ => {}
            }
            attach(&mut v, session, Some(&old));
            assert!(v.get("observation").is_none(), "variant {variant}");
            assert_eq!(v["cache_reuse"]["used"], false);
        }
    }
    #[test]
    fn new_capture_wins_and_truncation_is_not_repaired_by_cache() {
        let mut old = old();
        old["observation"]["truncated"] = true.into();
        attach(&mut old, "s", None);
        let mut v = unchanged();
        attach(&mut v, "s", Some(&old));
        assert_eq!(v["observation"]["truncated"], true);
        let mut fresh = old.clone();
        fresh["context_id"] = "new".into();
        fresh["observation"]["text"] = "new page".into();
        attach(&mut fresh, "s", Some(&old));
        assert_eq!(fresh["observation"]["text"], "new page");
        assert_eq!(fresh["observation_origin"]["capture_context_id"], "new");
    }
    #[test]
    fn local_views_are_historical_bounded_and_report_all_duplicate_matches() {
        let args = ViewArgs {
            file: "saved.json".into(),
            start_line: 1,
            line_count: 3,
            find: Some("button \"A\"".into()),
        };
        let v = project(&old(), &args).unwrap();
        assert_eq!(v["browser_calls"], 0);
        assert_eq!(v["historical"], true);
        assert!(v.get("context_id").is_none());
        assert_eq!(v["matching_lines"], json!([3, 4]));
        assert_eq!(v["partial_view"], true);
        assert_eq!(v["total_lines"], 5);
        let mut miss = args;
        miss.find = Some("missing".into());
        let v = project(&old(), &miss).unwrap();
        assert_eq!(v["no_match"], true);
        assert!(v["warning"].as_str().unwrap().contains("unknown"));
        miss.start_line = 999;
        assert_eq!(project(&old(), &miss).unwrap()["text"], "");
    }
    #[test]
    fn reads_step_and_sync_files_without_live_browser_and_rejects_broken_files() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("saved.json");
        for v in [old(), json!({"action":{"result":{}},"post":old()})] {
            std::fs::write(&p, serde_json::to_vec(&v).unwrap()).unwrap();
            assert_eq!(read(&p).unwrap()["context_id"], "c1");
        }
        std::fs::write(&p, "invalid json").unwrap();
        assert!(read(&p).is_err());
        std::fs::write(&p, r#"{"post":null}"#).unwrap();
        assert!(read(&p).is_err());
    }
    #[test]
    fn search_window_includes_the_hit_even_when_smaller_than_leading_context() {
        let text = (1..=30)
            .map(|line| format!("line {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        let value = json!({"observation":{"text":text}});
        for hit in [1, 15, 30] {
            for line_count in [1, 5, 12, 13, 120] {
                let args = ViewArgs {
                    file: "saved.json".into(),
                    start_line: 1,
                    line_count,
                    find: Some(format!("line {hit}")),
                };
                let v = project(&value, &args).unwrap();
                assert!(
                    v["text"]
                        .as_str()
                        .unwrap()
                        .lines()
                        .any(|l| l == format!("line {hit}"))
                );
                assert!(v["text"].as_str().unwrap().lines().count() <= line_count as usize);
            }
        }
        let args = ViewArgs {
            file: "saved.json".into(),
            start_line: 10,
            line_count: 5,
            find: Some("line 30".into()),
        };
        assert_eq!(project(&value, &args).unwrap()["start_line"], 10);
    }
}
