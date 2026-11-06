//! Turns what a session just did into a recipe draft to review.
//!
//! The log holds no input values, so every fill and selection becomes a parameter.
//! The author names them, restores what is really constant, and adds outputs.
use super::model::{self, Action, Param, ParamType, Recipe, Risk, Segment, Site, Step, Until};
use super::vom::Target;
use crate::daemon::run_log::{LoggedStep, RunLog};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const DEFAULT_UNTIL_MS: u64 = 8000;

fn parse_action(name: &str) -> Option<Action> {
    serde_json::from_value(json!(name)).ok()
}

/// A readable parameter name where the label allows one.
fn param_name(label: &str, taken: &BTreeMap<String, Param>) -> String {
    let slug: String = label
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let slug = slug.trim_matches('_').to_owned();
    let usable = slug.len() <= 40 && slug.starts_with(|c: char| c.is_ascii_alphabetic());
    let base = if usable { slug } else { "param".to_owned() };
    if usable && !taken.contains_key(&base) {
        return base;
    }
    (1..)
        .map(|index| format!("{base}_{index}"))
        .find(|name| !taken.contains_key(name))
        .expect("an unused name exists")
}

fn add_param(params: &mut BTreeMap<String, Param>, label: &str) -> String {
    let name = param_name(label, params);
    params.insert(
        name.clone(),
        Param {
            kind: ParamType::String,
            description: Some(label.to_owned()),
            values: Vec::new(),
            pattern: None,
            default: None,
        },
    );
    format!("{{{{{name}}}}}")
}

#[derive(Default)]
struct Builder {
    origins: Vec<String>,
    start: Option<String>,
    params: BTreeMap<String, Param>,
    segments: Vec<Segment>,
    current: Option<Segment>,
    /// The latest observation the current segment's targets come from.
    horizon: u32,
    boundary_after_wait: bool,
    pending_navigation: Option<String>,
    warnings: Vec<String>,
    errors: Vec<String>,
}

impl Builder {
    fn close_segment(&mut self, next_target: Option<&Target>) {
        if let Some(mut segment) = self.current.take() {
            if let Some(target) = next_target {
                segment.until = Some(Until {
                    text: None,
                    target: Some(target.clone()),
                    timeout_ms: DEFAULT_UNTIL_MS,
                });
            }
            self.segments.push(segment);
        }
    }

    fn open_segment(&mut self) -> &mut Segment {
        let id = format!("s{}", self.segments.len() + 1);
        let navigate = self.pending_navigation.take();
        self.current.get_or_insert_with(|| Segment {
            id,
            navigate,
            requires: Vec::new(),
            steps: Vec::new(),
            until: None,
        })
    }

    fn navigate(&mut self, origin: Option<&String>, path: Option<&String>, dropped_query: bool) {
        if let Some(origin) = origin
            && !self.origins.contains(origin)
        {
            self.origins.push(origin.clone());
        }
        let first = self.segments.is_empty() && self.current.is_none() && self.start.is_none();
        self.close_segment(None);
        if let Some(path) = path {
            if first {
                self.start = Some(path.clone());
            } else {
                self.pending_navigation = Some(path.clone());
            }
        }
        if dropped_query {
            self.warnings.push(format!(
                "A query string on {} was left out because it may hold data; add it back, with parameters, if the page needs it.",
                path.map_or("a navigation", String::as_str)
            ));
        }
    }

    fn step(&mut self, logged: &LoggedStep) {
        let LoggedStep::Action {
            action,
            target,
            first_seen,
            values,
            key,
            modifiers,
            heading,
            sensitive,
            ..
        } = logged
        else {
            return;
        };
        let Some(action) = parse_action(action) else {
            self.errors.push(format!("Unknown action {action}."));
            return;
        };
        if matches!(action, Action::Fill | Action::Select)
            && (*sensitive || model::names_sensitive(&target.name))
        {
            self.errors.push(format!(
                "\"{}\" holds a secret or card data, so this flow cannot become a recipe.",
                target.name
            ));
            return;
        }
        // A target that appeared only after earlier steps cannot be resolved with them.
        let appeared_later = self.current.is_some() && *first_seen > self.horizon;
        if appeared_later {
            self.close_segment(Some(target));
        } else if self.boundary_after_wait && self.current.is_some() {
            self.close_segment(None);
            self.warnings.push(format!(
                "A wait came before \"{}\": give the previous segment an until that says what it waited for.",
                target.name
            ));
        }
        self.boundary_after_wait = false;
        if self.current.is_none() {
            self.horizon = *first_seen;
        }
        let (value, selected) = match action {
            Action::Fill => (Some(add_param(&mut self.params, &target.name)), None),
            Action::Select => {
                let chosen = (0..values.unwrap_or(1))
                    .map(|_| add_param(&mut self.params, &target.name))
                    .collect();
                (None, Some(chosen))
            }
            _ => (None, None),
        };
        let mut step = Step {
            action,
            target: target.clone(),
            value,
            values: selected,
            key: key.clone(),
            modifiers: modifiers
                .as_ref()
                .and_then(|value| value.as_array().cloned()),
            expect: Vec::new(),
            risk: None,
        };
        if step.inferred_risk() == Risk::Commit {
            step.risk = Some(Risk::Commit);
            self.warnings.push(format!(
                "\"{}\" looks irreversible. This version cannot replay a commit step: keep it out, or set its risk to reversible if it really can be undone.",
                target.name
            ));
        }
        let segment = self.open_segment();
        if segment.requires.is_empty()
            && let Some(heading) = heading
        {
            segment.requires.push(Target {
                role: "heading".into(),
                name: heading.clone(),
                ctx: None,
            });
        }
        segment.steps.push(step);
    }

    fn skipped(&mut self, method: &str, reason: &str) {
        let why = match reason {
            "css_selector" => "it used a CSS selector; use a ref so its role and name are known",
            "untargeted" => "it had no target",
            "unknown_ref" => "its ref was not in an observation seen by this session",
            "unnamed" => "its element has no name",
            "ambiguous" => "its role, name and context do not identify one element",
            "character_key" => "it typed a character, which is an input value",
            "script" => "recipes cannot run scripts",
            "wheel" => "recipes cannot scroll by wheel; use scroll-to on a target",
            "drag" => "recipes cannot drag",
            "focus" => "recipes do not hold focus changes",
            "file_transfer" => "recipes cannot upload or download",
            "history_navigation" => "recipes navigate only to explicit paths",
            _ => "recipes cannot hold it",
        };
        self.errors.push(format!("Left out {method}: {why}."));
    }
}

fn request_summary(url: &str) -> String {
    reqwest::Url::parse(url).map_or_else(
        |_| "an unreadable address".to_owned(),
        |url| format!("{}{}", url.origin().ascii_serialization(), url.path()),
    )
}

/// Requests that may have changed something, as `METHOD origin/path`.
pub(crate) fn writes(network: &Value) -> Vec<String> {
    let mut writes: Vec<String> = network["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let method = entry["method"].as_str()?;
            (!["GET", "HEAD", "OPTIONS"].contains(&method)).then(|| {
                format!(
                    "{method} {}",
                    request_summary(entry["url"].as_str().unwrap_or_default())
                )
            })
        })
        .collect();
    writes.sort();
    writes.dedup();
    writes
}

pub(crate) fn build(
    log: &RunLog,
    name: &str,
    description: &str,
    current_url: Option<&str>,
    writes: &[String],
) -> Value {
    let mut builder = Builder::default();
    for step in &log.steps {
        match step {
            LoggedStep::Navigate {
                origin,
                path,
                dropped_query,
            } => builder.navigate(origin.as_ref(), path.as_ref(), *dropped_query),
            LoggedStep::Action { .. } => builder.step(step),
            LoggedStep::Wait => builder.boundary_after_wait = true,
            LoggedStep::Skipped { method, reason } => builder.skipped(method, reason),
            LoggedStep::Uncertain { method } => builder.errors.push(format!(
                "The effect of {method} is unknown, so this run may not show the real flow."
            )),
        }
    }
    builder.close_segment(None);
    if let Some(origin) = current_url.and_then(model::origin_of)
        && !builder.origins.contains(&origin)
    {
        builder.origins.push(origin);
    }
    if log.truncated {
        builder
            .errors
            .push("The run was longer than the log keeps, so later steps are missing.".into());
    }
    if builder
        .segments
        .iter()
        .all(|segment| segment.steps.is_empty())
    {
        builder
            .errors
            .push("This session recorded no action a recipe can hold. Draft before stopping a session: its log ends with it.".into());
    }
    if builder.start.is_none() {
        builder.warnings.push(
            "No navigation was recorded, so site.start is empty; add the path where the flow begins."
                .into(),
        );
    }
    if !writes.is_empty() {
        builder.warnings.push(format!(
            "The session sent requests that may change data: {}. Mark any step that caused a lasting change as a commit step.",
            writes.join(", ")
        ));
    }
    builder.warnings.push(
        "Add an until to the last segment and outputs for what the task reads. Literal values for parameters that never change can replace their placeholders."
            .into(),
    );
    let draft = Recipe {
        recipe_version: model::RECIPE_VERSION,
        name: name.to_owned(),
        revision: 1,
        vom: bsk_protocol::tools::VOM_FORMAT_VERSION,
        description: description.to_owned(),
        site: Site {
            origins: builder.origins,
            start: builder.start,
        },
        params: builder.params,
        segments: builder.segments,
        outputs: BTreeMap::new(),
        interrupts: Vec::new(),
    };
    // Serialized without `revision`: a new recipe has no base to conflict with.
    let mut draft = serde_json::to_value(&draft).expect("serializable draft");
    if let Some(fields) = draft.as_object_mut() {
        fields.remove("revision");
    }
    json!({"draft":draft,"warnings":builder.warnings,"errors":builder.errors,
        "next":"Review it, name the parameters, then save it with recipe save once the user agrees."})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action(name: &str, target: Target, first_seen: u32) -> LoggedStep {
        LoggedStep::Action {
            action: name.into(),
            target,
            element: "e1".into(),
            first_seen,
            values: (name == "select").then_some(1),
            key: None,
            modifiers: None,
            heading: Some("Sales".into()),
            sensitive: false,
        }
    }

    fn target(role: &str, name: &str) -> Target {
        Target {
            role: role.into(),
            name: name.into(),
            ctx: None,
        }
    }

    fn navigate(path: &str) -> LoggedStep {
        LoggedStep::Navigate {
            origin: Some("https://erp.example.com".into()),
            path: Some(path.into()),
            dropped_query: false,
        }
    }

    fn draft_of(steps: Vec<LoggedStep>) -> Value {
        build(
            &RunLog {
                steps,
                ..RunLog::default()
            },
            "sales",
            "Read the total",
            None,
            &[],
        )
    }

    #[test]
    fn a_run_becomes_a_parameterized_recipe_that_can_be_saved() {
        let reply = draft_of(vec![
            navigate("/report"),
            action("select", target("combobox", "Region"), 1),
            action("fill", target("textbox", "收货人"), 1),
            action("click", target("button", "Search"), 1),
        ]);
        let draft = &reply["draft"];
        assert_eq!(draft["site"]["start"], "/report");
        assert_eq!(draft["site"]["origins"][0], "https://erp.example.com");
        let steps = &draft["segments"][0]["steps"];
        assert_eq!(steps[0]["values"], json!(["{{region}}"]));
        assert_eq!(steps[1]["value"], "{{param_1}}");
        assert_eq!(draft["params"]["param_1"]["description"], "收货人");
        assert_eq!(draft["segments"][0]["requires"][0]["name"], "Sales");
        assert_eq!(reply["errors"], json!([]));
        // The draft is itself a valid recipe.
        let recipe = model::from_value(draft.clone())
            .map_err(|e| e.message)
            .unwrap();
        assert_eq!(recipe.segments.len(), 1);
    }

    #[test]
    fn a_target_that_appeared_later_starts_a_segment_and_its_appearance_is_the_wait() {
        let reply = draft_of(vec![
            action("click", target("button", "Search"), 1),
            action("click", target("link", "Sort"), 1),
            action("click", target("button", "Export"), 2),
            action("hover", target("link", "Sort"), 1),
        ]);
        let segments = &reply["draft"]["segments"];
        assert_eq!(segments.as_array().unwrap().len(), 2);
        assert_eq!(segments[0]["until"]["target"]["name"], "Export");
        assert_eq!(segments[0]["until"]["timeout_ms"], 8000);
        assert_eq!(segments[1]["steps"].as_array().unwrap().len(), 2);
        assert!(segments[1].get("until").is_none());
    }

    #[test]
    fn a_later_navigation_opens_its_own_segment_on_that_path() {
        let reply = draft_of(vec![
            navigate("/a"),
            action("click", target("button", "One"), 1),
            navigate("/b"),
            action("click", target("button", "Two"), 2),
        ]);
        let segments = &reply["draft"]["segments"];
        assert_eq!(reply["draft"]["site"]["start"], "/a");
        assert!(segments[0].get("navigate").is_none());
        assert!(segments[0].get("until").is_none());
        assert_eq!(segments[1]["navigate"], "/b");
    }

    #[test]
    fn a_recorded_wait_splits_and_asks_for_a_condition() {
        let reply = draft_of(vec![
            action("select", target("combobox", "Province"), 1),
            LoggedStep::Wait,
            action("select", target("combobox", "City"), 1),
        ]);
        assert_eq!(reply["draft"]["segments"].as_array().unwrap().len(), 2);
        assert!(reply["warnings"].to_string().contains("A wait came before"));
    }

    #[test]
    fn what_a_recipe_cannot_hold_is_reported_not_silently_dropped() {
        let reply = draft_of(vec![
            action("click", target("button", "Search"), 1),
            LoggedStep::Skipped {
                method: "tool.evaluate".into(),
                reason: "script".into(),
            },
            LoggedStep::Skipped {
                method: "tool.click".into(),
                reason: "css_selector".into(),
            },
            LoggedStep::Uncertain {
                method: "tool.click".into(),
            },
        ]);
        let errors = reply["errors"].to_string();
        assert!(errors.contains("cannot run scripts"), "{errors}");
        assert!(errors.contains("CSS selector"), "{errors}");
        assert!(errors.contains("unknown"), "{errors}");
    }

    #[test]
    fn secrets_are_refused_even_when_only_the_mask_gave_them_away() {
        let mut masked = action("fill", target("textbox", "Reference"), 1);
        if let LoggedStep::Action { sensitive, .. } = &mut masked {
            *sensitive = true;
        }
        let reply = draft_of(vec![
            masked,
            action("fill", target("textbox", "登录密码"), 1),
        ]);
        assert!(reply["errors"].to_string().contains("secret or card"));
        assert_eq!(reply["errors"].as_array().unwrap().len(), 3, "{reply}");
        assert_eq!(reply["draft"]["params"], Value::Null);
    }

    #[test]
    fn irreversible_steps_are_marked_and_cannot_be_saved_as_they_are() {
        let reply = draft_of(vec![
            navigate("/apply"),
            action("click", target("button", "提交申请"), 1),
        ]);
        assert_eq!(reply["draft"]["segments"][0]["steps"][0]["risk"], "commit");
        assert!(reply["warnings"].to_string().contains("looks irreversible"));
        let error = model::from_value(reply["draft"].clone()).err().unwrap();
        assert!(error.message.contains("commit step"), "{}", error.message);
    }

    #[test]
    fn dropped_queries_and_data_changing_requests_are_called_out() {
        let reply = build(
            &RunLog {
                steps: vec![
                    LoggedStep::Navigate {
                        origin: Some("https://a.test".into()),
                        path: Some("/x".into()),
                        dropped_query: true,
                    },
                    action("click", target("button", "Search"), 1),
                ],
                ..RunLog::default()
            },
            "n",
            "d",
            Some("https://b.test/after"),
            &["POST https://a.test/api".to_owned()],
        );
        let warnings = reply["warnings"].to_string();
        assert!(warnings.contains("query string"), "{warnings}");
        assert!(warnings.contains("POST https://a.test/api"), "{warnings}");
        assert_eq!(
            reply["draft"]["site"]["origins"],
            json!(["https://a.test", "https://b.test"])
        );
    }

    #[test]
    fn network_entries_reduce_to_writes_without_their_data() {
        let network = json!({"entries":[
            {"method":"GET","url":"https://a.test/x"},
            {"method":"POST","url":"https://a.test/save?token=secret"},
            {"method":"POST","url":"https://a.test/save?token=other"},
            {"kind":"failure"}
        ]});
        assert_eq!(writes(&network), ["POST https://a.test/save"]);
    }

    #[test]
    fn parameter_names_stay_unique_and_usable() {
        let reply = draft_of(vec![
            action("fill", target("textbox", "Name"), 1),
            action("fill", target("textbox", "Name"), 1),
            action("fill", target("textbox", "2nd"), 1),
            action("fill", target("textbox", "公司"), 1),
        ]);
        let params = reply["draft"]["params"].as_object().unwrap();
        let mut names: Vec<_> = params.keys().map(String::as_str).collect();
        names.sort_unstable();
        assert_eq!(names, ["name", "name_1", "param_1", "param_2"], "{reply}");
    }
}
