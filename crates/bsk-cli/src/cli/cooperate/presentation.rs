//! Fold plain numbered fallback controls, retaining business text and named controls.
use serde_json::{Value, json};

fn body(line: &str) -> &str {
    let text = line.trim_start_matches(' ');
    if let Some(rest) = text.strip_prefix("@e")
        && let Some((id, rest)) = rest.split_once(' ')
        && !id.is_empty()
        && id.bytes().all(|b| b.is_ascii_digit())
    {
        return rest;
    }
    text
}
fn numbered(line: &str) -> bool {
    // Exact shape only: state, value and context suffixes are always retained.
    body(line)
        .strip_prefix("button \"item ")
        .and_then(|s| s.strip_suffix('"'))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}
fn protected(line: &str) -> bool {
    matches!(
        body(line).split_whitespace().next(),
        Some("form" | "dialog" | "alertdialog" | "alert" | "status")
    )
}

pub(crate) fn filter(reply: &mut Value, needles: &[String], context: usize) {
    let Some(text) = reply.pointer("/observation/text").and_then(Value::as_str) else {
        return;
    };
    let lines: Vec<&str> = text.lines().collect();
    let capture_truncated = reply
        .pointer("/observation/truncated")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let counts: Vec<usize> = needles
        .iter()
        .map(|n| lines.iter().filter(|l| l.contains(n)).count())
        .collect();
    let matched = lines
        .iter()
        .filter(|l| needles.iter().any(|n| l.contains(n)))
        .count();
    let mut keep = vec![true; lines.len()];
    let mut fallback = None;
    if !text.starts_with("@vom 1\n") || lines.iter().any(|l| l.starts_with('\t')) {
        fallback = Some("unknown_format");
    } else if counts.contains(&0) {
        fallback = Some("no_match");
    } else {
        let mut regions: Vec<usize> = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            let indent = line.len() - line.trim_start_matches(' ').len();
            while regions.last().is_some_and(|&depth| depth >= indent) {
                regions.pop();
            }
            if protected(line) {
                regions.push(indent);
            }
            keep[i] = !regions.is_empty() || !numbered(line);
        }
        for (i, line) in lines.iter().enumerate() {
            if needles.iter().any(|n| line.contains(n)) {
                let end = i.saturating_add(context).saturating_add(1).min(lines.len());
                keep[i.saturating_sub(context)..end].fill(true);
            }
        }
        let mut ancestors: Vec<(usize, usize)> = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            let indent = line.len() - line.trim_start_matches(' ').len();
            while ancestors.last().is_some_and(|&(_, depth)| depth >= indent) {
                ancestors.pop();
            }
            if keep[i] {
                for &(parent, _) in &ancestors {
                    keep[parent] = true;
                }
            }
            ancestors.push((i, indent));
        }
    }
    let mut output = Vec::new();
    let mut pending = 0;
    for (i, line) in lines.iter().enumerate() {
        if keep[i] {
            if pending > 0 {
                output.push(format!(
                    "… {pending} numbered controls omitted (partial presentation)"
                ));
                pending = 0;
            }
            output.push((*line).to_owned());
        } else {
            pending += 1;
        }
    }
    if pending > 0 {
        output.push(format!(
            "… {pending} numbered controls omitted (partial presentation)"
        ));
    }
    let candidate = output.join("\n");
    let mut omitted = keep.iter().filter(|&&x| !x).count();
    if omitted > 0 && candidate.len() >= text.len() {
        omitted = 0;
        fallback = Some("no_size_benefit");
    }
    let result = if omitted == 0 {
        text.to_owned()
    } else {
        candidate
    };
    let total = lines.len();
    reply["observation"]["text"] = result.into();
    // Legacy consumers must also see that displayed text is incomplete.
    reply["observation"]["capture_truncated"] = capture_truncated.into();
    reply["observation"]["truncated"] = (capture_truncated || omitted > 0).into();
    reply["presentation"] = json!({
        "filtered": omitted > 0, "complete": !capture_truncated && omitted == 0,
        "capture_truncated": capture_truncated, "strategy": "conservative_numbered_controls",
        "match_text": needles, "matches_per_query": counts, "context_lines": context,
        "matched_lines": matched, "total_lines": total, "shown_lines": total - omitted,
        "omitted_lines": omitted, "fallback_reason": fallback,
        "scope": "CLI display only; original refs, ref_count, context and full observation guard unchanged",
        "warning": "Named controls, business text, state hints and complete forms/dialogs are retained. Omitted numbered controls remain unknown; use the full reply before final business decisions."
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn page() -> Value {
        let mut text = String::from("@vom 1\nL1 page\n  RootWebArea \"Inventory\"\n");
        for row in 0..30 {
            text.push_str(&format!(
                "    @e{} link \"Product {row}\"\n    StaticText \"Capacity 10\"\n    group\n",
                row * 21
            ));
            for col in 0..20 {
                text.push_str(&format!(
                    "      @e{} button \"item {col}\"\n",
                    row * 21 + col + 1
                ));
            }
        }
        json!({"context_id":"ctx","state":{"mode":"ready"},"activity":[{"type":"edit"}],"guidance":"keep",
            "history_complete":false,"observation":{"text":text,"observation_id":"obs","ref_count":630,"truncated":false,"next_cursor":"cursor"}})
    }
    #[test]
    fn retains_distant_alerts_plain_constraints_prices_and_named_controls() {
        let mut v = page();
        let text = v["observation"]["text"].as_str().unwrap().to_owned();
        let important = "    alert \"Cannot order\"\n      StaticText \"Permission required\"\n    StaticText \"Mandatory fee 80\"\n    @e900 button \"Unavailable\"\n    @e901 button \"item 99\" [disabled]\n    @e902 button \"item 100\" [selected:class]\n    status \"Price changed\"";
        v["observation"]["text"] = format!("{text}{important}").into();
        let original = v.clone();
        filter(&mut v, &["Product 1\"".into()], 12);
        let output = v["observation"]["text"].as_str().unwrap();
        for line in important.lines() {
            assert!(output.contains(line), "lost {line}");
        }
        assert!(output.len() < text.len());
        for key in [
            "context_id",
            "state",
            "activity",
            "guidance",
            "history_complete",
        ] {
            assert_eq!(v[key], original[key]);
        }
        for key in ["observation_id", "ref_count", "next_cursor"] {
            assert_eq!(v["observation"][key], original["observation"][key]);
        }
        assert_eq!(v["observation"]["truncated"], true);
        assert_eq!(v["observation"]["capture_truncated"], false);
        assert_eq!(v["presentation"]["complete"], false);
    }
    #[test]
    fn protects_complete_forms_dialogs_and_state_hints() {
        let mut v = page();
        let region = "    form \"Other form\"\n      @e901 button \"item 99\"\n      @e902 textbox \"Name\" [invalid]\n    dialog \"Review\"\n      @e903 button \"item 100\"\n      StaticText \"No refunds\"\nL2 page … occluded by L1";
        v["observation"]["text"] =
            format!("{}{region}", v["observation"]["text"].as_str().unwrap()).into();
        filter(&mut v, &["Product 1\"".into()], 0);
        assert!(v["observation"]["text"].as_str().unwrap().contains(region));
    }
    #[test]
    fn missing_or_case_mismatched_query_returns_full_view() {
        for queries in [
            vec!["missing".into()],
            vec!["product 1".into()],
            vec!["Product 1".into(), "missing".into()],
        ] {
            let mut v = page();
            let original = v["observation"]["text"].clone();
            filter(&mut v, &queries, 12);
            assert_eq!(v["observation"]["text"], original);
            assert_eq!(v["presentation"]["fallback_reason"], "no_match");
            assert_eq!(v["presentation"]["complete"], true);
        }
    }
    #[test]
    fn truncated_capture_is_never_claimed_complete() {
        let mut v = page();
        v["observation"]["truncated"] = true.into();
        filter(&mut v, &["missing".into()], 0);
        assert_eq!(v["observation"]["capture_truncated"], true);
        assert_eq!(v["observation"]["truncated"], true);
        assert_eq!(v["presentation"]["complete"], false);
    }
    #[test]
    fn duplicate_labels_and_unicode_do_not_silently_select_one() {
        let mut v = page();
        v["observation"]["text"] = v["observation"]["text"]
            .as_str()
            .unwrap()
            .replace("Product 1\"", "商品\"")
            .replace("Product 2\"", "商品\"")
            .into();
        filter(&mut v, &["商品".into()], 24);
        assert_eq!(v["presentation"]["matches_per_query"], json!([2]));
        let text = v["observation"]["text"].as_str().unwrap();
        for label in [
            "@e21 link \"商品\"",
            "@e42 link \"商品\"",
            "@e41 button \"item 19\"",
            "@e62 button \"item 19\"",
        ] {
            assert!(text.contains(label));
        }
    }
    #[test]
    fn unknown_formats_and_small_views_never_expand() {
        for text in [
            "unknown format\n@e1 Target",
            "@vom 1\nL1 page\n  @e1 button \"Target\"\n  @e2 button \"item 0\"",
        ] {
            let mut v = json!({"observation":{"text":text,"truncated":false}});
            filter(&mut v, &["Target".into()], 0);
            assert_eq!(v["observation"]["text"], text);
            assert_eq!(v["presentation"]["filtered"], false);
        }
    }
    #[test]
    fn delta_or_ownership_response_is_unchanged() {
        let mut v = json!({"state":{"mode":"human"},"ready":false});
        let original = v.clone();
        filter(&mut v, &["x".into()], 12);
        assert_eq!(v, original);
    }
}
