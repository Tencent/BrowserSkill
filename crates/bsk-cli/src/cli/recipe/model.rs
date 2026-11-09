//! The recipe file: a reviewable, linear description of one verified flow.
use super::vom::Target;
use anyhow::{Context, bail, ensure};
use bsk_protocol::tools::{ActionExpectation, ExpectationField, ExpectedValue, VOM_FORMAT_VERSION};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) const RECIPE_VERSION: u32 = 1;
const MAX_SEGMENTS: usize = 20;
const MAX_STEPS: usize = 100;
const MAX_SEGMENT_STEPS: usize = 20;
const MAX_INTERRUPTS: usize = 3;
const MAX_PARAMS: usize = 32;
const MAX_OUTPUTS: usize = 16;
const MAX_REQUIRES: usize = 8;
const MAX_ORIGINS: usize = 8;
const MAX_TEXT: usize = 1024;
const MAX_VALUE: usize = 64 * 1024;
/// Dialogs and banners. An interrupt must not become general page control.
const INTERRUPT_ROLES: [&str; 4] = ["dialog", "alertdialog", "alert", "banner"];
/// Words in a control's name that suggest an effect that cannot be taken back.
const COMMIT_WORDS: [&str; 23] = [
    "submit",
    "pay",
    "payment",
    "purchase",
    "buy",
    "order",
    "checkout",
    "send",
    "delete",
    "remove",
    "publish",
    "post",
    "confirm",
    "approve",
    "reject",
    "transfer",
    "save",
    "sign",
    "subscribe",
    "unsubscribe",
    "refund",
    "withdraw",
    "ok",
];
const COMMIT_TEXT: [&str; 29] = [
    "提交", "支付", "付款", "购买", "下单", "结算", "发送", "删除", "移除", "发布", "确认", "确定",
    "同意", "批准", "审批", "拒绝", "驳回", "转账", "充值", "提现", "退款", "保存", "注销", "签署",
    "授权", "订阅", "退订", "上架", "下架",
];
/// Fields whose values must never be replayed from a file.
const SENSITIVE_WORDS: [&str; 10] = [
    "password", "passcode", "passwd", "pwd", "otp", "cvv", "cvc", "ssn", "pin", "2fa",
];
const SENSITIVE_PHRASES: [&str; 14] = [
    "card number",
    "credit card",
    "verification code",
    "security code",
    "one-time",
    "密码",
    "口令",
    "验证码",
    "校验码",
    "动态码",
    "卡号",
    "信用卡",
    "安全码",
    "身份证",
];

fn one() -> u32 {
    1
}
fn current_vom() -> u32 {
    VOM_FORMAT_VERSION
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Recipe {
    pub recipe_version: u32,
    pub name: String,
    #[serde(default = "one")]
    pub revision: u32,
    /// The VOM format the targets were written against.
    #[serde(default = "current_vom")]
    pub vom: u32,
    pub description: String,
    pub site: Site,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, Param>,
    pub segments: Vec<Segment>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub outputs: BTreeMap<String, Output>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub interrupts: Vec<Interrupt>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Site {
    pub origins: Vec<String>,
    /// Path where the flow begins, on the first allowed origin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ParamType {
    String,
    Enum,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Param {
    #[serde(rename = "type")]
    pub kind: ParamType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub values: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
}

/// One bsk plan: what one observation can decide before the page moves on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Segment {
    pub id: String,
    /// Path to open before this segment, on the page's current origin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub navigate: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requires: Vec<Target>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub steps: Vec<Step>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<Until>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    Click,
    Fill,
    Select,
    Press,
    Hover,
    #[serde(alias = "scroll_to")]
    ScrollTo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Read,
    Reversible,
    Commit,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
    pub action: Action,
    pub target: Target,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub expect: Vec<Expectation>,
    /// Overrides the inferred risk. A lower value is listed when saving.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk: Option<Risk>,
}

/// A fact checked by the extension right before the step's input.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Expectation {
    /// Defaults to the step's own target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<Target>,
    pub field: ExpectationField,
    pub equals: ExpectedValue,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribute: Option<String>,
}

/// A condition that must become true after the segment's steps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Until {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<Target>,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Output {
    /// Applied to the final VOM text. The first capture group is the value, if any.
    pub regex: String,
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Interrupt {
    pub when: Target,
    pub click: Target,
}

/// A refusal that names why nothing was run.
#[derive(Debug)]
pub(crate) struct Refusal {
    pub(crate) reason: &'static str,
    pub(crate) message: String,
}

impl Refusal {
    pub(crate) fn new(reason: &'static str, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
        }
    }
}

/// Reads a recipe, reporting a version from the future before its unknown fields.
pub(crate) fn from_value(value: Value) -> Result<Recipe, Refusal> {
    let version = value["recipe_version"].as_u64().unwrap_or(0);
    if version > u64::from(RECIPE_VERSION) {
        return Err(Refusal::new(
            "unsupported_version",
            format!("recipe format {version} is newer than this bsk supports; update bsk"),
        ));
    }
    let recipe: Recipe = serde_json::from_value(value)
        .map_err(|error| Refusal::new("invalid_recipe", format!("invalid recipe: {error}")))?;
    if recipe.vom > VOM_FORMAT_VERSION {
        return Err(Refusal::new(
            "unsupported_version",
            format!(
                "recipe uses VOM format {} but this bsk reads format {VOM_FORMAT_VERSION}; update bsk",
                recipe.vom
            ),
        ));
    }
    recipe
        .validate()
        .map_err(|error| Refusal::new("invalid_recipe", format!("{error:#}")))?;
    Ok(recipe)
}

pub(crate) fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_.".contains(&b))
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && !is_windows_device(name)
}

fn is_windows_device(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or_default();
    matches!(stem, "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.as_bytes()[3].is_ascii_digit())
}

fn valid_identifier(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// `{{name}}` occurrences, in order.
fn placeholders(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find("{{") {
        let tail = &rest[open + 2..];
        let Some(close) = tail.find("}}") else { break };
        found.push(tail[..close].trim().to_owned());
        rest = &tail[close + 2..];
    }
    found
}

pub(crate) fn substitute(text: &str, values: &BTreeMap<String, String>) -> String {
    substitute_with(text, values, str::to_owned)
}

fn substitute_with(
    text: &str,
    values: &BTreeMap<String, String>,
    encode: impl Fn(&str) -> String,
) -> String {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find("{{") {
        let tail = &rest[open + 2..];
        let Some(close) = tail.find("}}") else { break };
        output.push_str(&rest[..open]);
        match values.get(tail[..close].trim()) {
            Some(value) => output.push_str(&encode(value)),
            None => output.push_str(&rest[open..open + 2 + close + 2]),
        }
        rest = &tail[close + 2..];
    }
    output.push_str(rest);
    output
}

/// A parameter can fill part of a path, but never change which page it names.
fn percent_encoded(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn check_path(path: &str, label: &str) -> anyhow::Result<()> {
    ensure!(
        path.starts_with('/') && !path.starts_with("//") && !path.contains('\\'),
        "{label} must be a path on the site, such as /report"
    );
    ensure!(
        !path.chars().any(char::is_control) && path.len() <= MAX_TEXT,
        "{label} is not a usable path"
    );
    Ok(())
}

pub(crate) fn origin_of(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    matches!(parsed.scheme(), "http" | "https").then(|| parsed.origin().ascii_serialization())
}

fn check_target(target: &Target, label: &str) -> anyhow::Result<()> {
    ensure!(
        !target.role.trim().is_empty() && target.role.bytes().all(|b| b.is_ascii_alphanumeric()),
        "{label}: role must be a single word such as button"
    );
    ensure!(
        !target.name.trim().is_empty() && target.name.chars().count() <= MAX_TEXT,
        "{label}: an element needs a name of 1 to {MAX_TEXT} characters; recipes cannot address unnamed controls"
    );
    ensure!(
        target
            .ctx
            .as_deref()
            .is_none_or(|ctx| !ctx.trim().is_empty() && ctx.chars().count() <= MAX_TEXT),
        "{label}: ctx must have 1 to {MAX_TEXT} characters when present"
    );
    Ok(())
}

fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

fn names_commit(name: &str) -> bool {
    words(name)
        .iter()
        .any(|word| COMMIT_WORDS.contains(&word.as_str()))
        || COMMIT_TEXT.iter().any(|text| name.contains(text))
}

/// Whether a field's name says it holds a secret. The renderer's mask catches the
/// rest as soon as such a field has a value.
pub(crate) fn names_sensitive(name: &str) -> bool {
    let lower = name.to_lowercase();
    words(name)
        .iter()
        .any(|word| SENSITIVE_WORDS.contains(&word.as_str()))
        || SENSITIVE_PHRASES.iter().any(|text| lower.contains(text))
}

/// Personal data in a locator would be written to disk and match only one record.
pub(crate) fn personal_data_hint(text: &str) -> Option<&'static str> {
    let digits = text.bytes().filter(u8::is_ascii_digit).count();
    let at = text.find('@');
    if at.is_some_and(|at| text[at..].contains('.') && at > 0) {
        return Some("an email address");
    }
    let longest_run = text
        .split(|c: char| !c.is_ascii_digit())
        .map(str::len)
        .max()
        .unwrap_or(0);
    (longest_run >= 7 || digits >= 11).then_some("a long number or phone number")
}

impl Step {
    /// The risk its action and name suggest. Over-marking is deliberate.
    pub(crate) fn inferred_risk(&self) -> Risk {
        match self.action {
            Action::Hover | Action::ScrollTo => Risk::Read,
            Action::Fill | Action::Select => Risk::Reversible,
            Action::Press => {
                let submits = self.key.as_deref().is_some_and(|key| {
                    let key = key.to_ascii_lowercase();
                    key == "enter" || key.ends_with("+enter") || key == "numpadenter"
                });
                if submits || names_commit(&self.target.name) {
                    Risk::Commit
                } else {
                    Risk::Reversible
                }
            }
            Action::Click if names_commit(&self.target.name) => Risk::Commit,
            Action::Click => Risk::Reversible,
        }
    }

    pub(crate) fn risk(&self) -> Risk {
        self.risk.unwrap_or_else(|| self.inferred_risk())
    }

    fn strings(&self) -> Vec<&str> {
        let mut strings = vec![self.target.name.as_str()];
        strings.extend(self.target.ctx.as_deref());
        strings.extend(self.value.as_deref());
        strings.extend(self.values.iter().flatten().map(String::as_str));
        strings.extend(self.key.as_deref());
        for expect in &self.expect {
            if let Some(target) = &expect.target {
                strings.push(&target.name);
                strings.extend(target.ctx.as_deref());
            }
            if let ExpectedValue::String(equals) = &expect.equals {
                strings.push(equals);
            }
        }
        strings
    }

    fn validate(&self, label: &str) -> anyhow::Result<()> {
        check_target(&self.target, label)?;
        let has_value = self.value.is_some();
        let has_values = self.values.is_some();
        let has_key = self.key.is_some();
        match self.action {
            Action::Fill => ensure!(
                has_value && !has_values && !has_key,
                "{label}: fill takes value"
            ),
            Action::Select => {
                ensure!(
                    has_values && !has_value && !has_key,
                    "{label}: select takes values"
                );
                ensure!(
                    self.values
                        .as_ref()
                        .is_some_and(|values| !values.is_empty()),
                    "{label}: select needs at least one value"
                );
            }
            Action::Press => ensure!(
                has_key && !has_value && !has_values,
                "{label}: press takes key"
            ),
            Action::Click | Action::Hover | Action::ScrollTo => ensure!(
                !has_value && !has_values && !has_key,
                "{label}: this action takes only a target"
            ),
        }
        if !matches!(self.action, Action::Press) {
            ensure!(
                self.modifiers.is_none(),
                "{label}: only press takes modifiers"
            );
        }
        if matches!(self.action, Action::Fill | Action::Select | Action::Press)
            && names_sensitive(&self.target.name)
        {
            bail!(
                "{label}: \"{}\" looks like a secret or card field; recipes cannot contain one",
                self.target.name
            );
        }
        ensure!(
            self.expect.len() <= 16,
            "{label}: at most 16 expect conditions"
        );
        for condition in &self.expect {
            if let Some(target) = &condition.target {
                check_target(target, label)?;
            }
            // The compiled condition is what the extension receives.
            ActionExpectation {
                target: "@e1".into(),
                field: condition.field,
                equals: condition.equals.clone(),
                attribute: condition.attribute.clone(),
            }
            .validate()
            .map_err(anyhow::Error::msg)
            .with_context(|| label.to_owned())?;
        }
        Ok(())
    }
}

impl Until {
    fn validate(&self, label: &str) -> anyhow::Result<()> {
        ensure!(
            self.text.is_some() != self.target.is_some(),
            "{label}: until needs exactly one of text or target"
        );
        ensure!(
            (1..=25_000).contains(&self.timeout_ms),
            "{label}: until timeout_ms must be 1..=25000"
        );
        if let Some(text) = &self.text {
            ensure!(
                !text.trim().is_empty() && text.chars().count() <= MAX_TEXT,
                "{label}: until text must have 1 to {MAX_TEXT} characters"
            );
        }
        if let Some(target) = &self.target {
            check_target(target, label)?;
        }
        Ok(())
    }
}

impl Param {
    fn validate(&self, name: &str) -> anyhow::Result<()> {
        match self.kind {
            ParamType::Enum => {
                ensure!(!self.values.is_empty(), "param {name}: enum needs values");
                ensure!(
                    self.pattern.is_none(),
                    "param {name}: enum takes no pattern"
                );
            }
            ParamType::String => ensure!(
                self.values.is_empty(),
                "param {name}: only an enum takes values"
            ),
        }
        if let Some(pattern) = &self.pattern {
            ensure!(
                pattern.len() <= MAX_TEXT,
                "param {name}: pattern is too long"
            );
            Regex::new(pattern).with_context(|| format!("param {name}: invalid pattern"))?;
        }
        if let Some(value) = &self.default {
            self.check(name, value)?;
        }
        Ok(())
    }

    fn check(&self, name: &str, value: &str) -> anyhow::Result<()> {
        ensure!(value.len() <= MAX_VALUE, "param {name}: value is too long");
        if self.kind == ParamType::Enum {
            ensure!(
                self.values.iter().any(|allowed| allowed == value),
                "param {name}: value is not one of {:?}",
                self.values
            );
        }
        if let Some(pattern) = &self.pattern {
            let regex = Regex::new(pattern)?;
            ensure!(
                regex.is_match(value),
                "param {name}: value does not match {pattern}"
            );
        }
        Ok(())
    }
}

impl Recipe {
    fn targets(&self) -> impl Iterator<Item = &Target> {
        self.segments
            .iter()
            .flat_map(|segment| {
                segment
                    .requires
                    .iter()
                    .chain(
                        segment
                            .until
                            .iter()
                            .filter_map(|until| until.target.as_ref()),
                    )
                    .chain(segment.steps.iter().flat_map(|step| {
                        std::iter::once(&step.target)
                            .chain(step.expect.iter().filter_map(|c| c.target.as_ref()))
                    }))
            })
            .chain(self.interrupts.iter().flat_map(|i| [&i.when, &i.click]))
    }

    /// Every string a parameter may appear in.
    fn templates(&self) -> Vec<&str> {
        let mut templates = Vec::new();
        templates.extend(self.site.start.as_deref());
        for segment in &self.segments {
            templates.extend(segment.navigate.as_deref());
            for target in &segment.requires {
                templates.push(&target.name);
                templates.extend(target.ctx.as_deref());
            }
            for step in &segment.steps {
                templates.extend(step.strings());
            }
            if let Some(until) = &segment.until {
                templates.extend(until.text.as_deref());
                if let Some(target) = &until.target {
                    templates.push(&target.name);
                    templates.extend(target.ctx.as_deref());
                }
            }
        }
        templates
    }

    pub(crate) fn validate(&self) -> anyhow::Result<()> {
        ensure!(
            self.recipe_version == RECIPE_VERSION,
            "recipe_version must be {RECIPE_VERSION}"
        );
        ensure!(
            valid_name(&self.name),
            "name must use lowercase letters, digits, -, _ and ., at most 64 characters"
        );
        ensure!(self.revision >= 1, "revision starts at 1");
        ensure!(
            !self.description.trim().is_empty() && self.description.chars().count() <= MAX_TEXT,
            "description must say what the recipe does, in at most {MAX_TEXT} characters"
        );
        ensure!(
            (1..=MAX_ORIGINS).contains(&self.site.origins.len()),
            "site.origins needs 1 to {MAX_ORIGINS} origins"
        );
        for origin in &self.site.origins {
            ensure!(
                origin_of(origin).as_deref() == Some(origin.as_str()),
                "site origin {origin} must be exactly scheme://host[:port]"
            );
        }
        if let Some(start) = &self.site.start {
            check_path(start, "site.start")?;
        }
        ensure!(
            self.params.len() <= MAX_PARAMS,
            "at most {MAX_PARAMS} params"
        );
        for (name, param) in &self.params {
            ensure!(
                valid_identifier(name),
                "param name {name} is not an identifier"
            );
            param.validate(name)?;
        }
        ensure!(
            (1..=MAX_SEGMENTS).contains(&self.segments.len()),
            "a recipe needs 1 to {MAX_SEGMENTS} segments"
        );
        let steps: usize = self.segments.iter().map(|s| s.steps.len()).sum();
        ensure!(
            steps <= MAX_STEPS,
            "a recipe holds at most {MAX_STEPS} steps"
        );
        let mut ids = BTreeSet::new();
        for segment in &self.segments {
            ensure!(!segment.id.trim().is_empty(), "a segment needs an id");
            ensure!(
                ids.insert(segment.id.as_str()),
                "segment id {} is repeated",
                segment.id
            );
            let label = format!("segment {}", segment.id);
            ensure!(
                segment.steps.len() <= MAX_SEGMENT_STEPS,
                "{label}: at most {MAX_SEGMENT_STEPS} steps; split it"
            );
            ensure!(
                !segment.steps.is_empty()
                    || segment.navigate.is_some()
                    || segment.until.is_some()
                    || !segment.requires.is_empty(),
                "{label}: nothing to do"
            );
            ensure!(
                segment.requires.len() <= MAX_REQUIRES,
                "{label}: at most {MAX_REQUIRES} requires"
            );
            for target in &segment.requires {
                check_target(target, &label)?;
            }
            if let Some(path) = &segment.navigate {
                check_path(path, &label)?;
            }
            if let Some(until) = &segment.until {
                until.validate(&label)?;
            }
            for (index, step) in segment.steps.iter().enumerate() {
                let label = format!("{label} step {index}");
                step.validate(&label)?;
                ensure!(
                    step.risk() != Risk::Commit,
                    "{label}: \"{}\" is a commit step, and this version replays only read and \
                     reversible steps. If it really is reversible, set \"risk\": \"reversible\"",
                    step.target.name
                );
            }
        }
        ensure!(
            self.interrupts.len() <= MAX_INTERRUPTS,
            "at most {MAX_INTERRUPTS} interrupts"
        );
        for interrupt in &self.interrupts {
            check_target(&interrupt.when, "interrupt when")?;
            check_target(&interrupt.click, "interrupt click")?;
            ensure!(
                INTERRUPT_ROLES
                    .iter()
                    .any(|role| interrupt.when.role.eq_ignore_ascii_case(role)),
                "an interrupt matches only {INTERRUPT_ROLES:?}"
            );
            ensure!(
                !names_commit(&interrupt.click.name),
                "interrupt click \"{}\" looks like a commit action",
                interrupt.click.name
            );
        }
        ensure!(
            self.outputs.len() <= MAX_OUTPUTS,
            "at most {MAX_OUTPUTS} outputs"
        );
        for (name, output) in &self.outputs {
            ensure!(
                valid_identifier(name),
                "output name {name} is not an identifier"
            );
            ensure!(
                output.regex.len() <= MAX_TEXT,
                "output {name}: regex is too long"
            );
            Regex::new(&output.regex).with_context(|| format!("output {name}: invalid regex"))?;
        }
        for template in self.templates() {
            for placeholder in placeholders(template) {
                ensure!(
                    self.params.contains_key(&placeholder),
                    "{{{{{placeholder}}}}} is used but not declared in params"
                );
            }
        }
        Ok(())
    }

    /// Checks caller values against the declared parameters and adds defaults.
    pub(crate) fn resolve_params(
        &self,
        given: &BTreeMap<String, String>,
    ) -> anyhow::Result<BTreeMap<String, String>> {
        for name in given.keys() {
            ensure!(self.params.contains_key(name), "unknown param {name}");
        }
        let mut values = BTreeMap::new();
        for (name, param) in &self.params {
            let value = given
                .get(name)
                .or(param.default.as_ref())
                .with_context(|| format!("missing param {name}"))?;
            param.check(name, value)?;
            values.insert(name.clone(), value.clone());
        }
        Ok(values)
    }

    /// A concrete copy with every placeholder replaced. A control named by a
    /// parameter is checked again, because no one reviewed what it now says.
    pub(crate) fn bind(&self, values: &BTreeMap<String, String>) -> anyhow::Result<Self> {
        let text = |text: &mut String| *text = substitute(text, values);
        let path = |path: &mut String| *path = substitute_with(path, values, percent_encoded);
        let target = |target: &mut Target| {
            target.name = substitute(&target.name, values);
            target.ctx = target.ctx.as_deref().map(|ctx| substitute(ctx, values));
        };
        let mut bound = self.clone();
        if let Some(start) = &mut bound.site.start {
            path(start);
        }
        for segment in &mut bound.segments {
            if let Some(navigate) = &mut segment.navigate {
                path(navigate);
            }
            segment.requires.iter_mut().for_each(target);
            if let Some(until) = &mut segment.until {
                until.text.as_mut().map(text);
                until.target.as_mut().map(target);
            }
            for step in &mut segment.steps {
                let named_by_param = !placeholders(&step.target.name).is_empty();
                target(&mut step.target);
                step.value.as_mut().map(text);
                step.values.iter_mut().flatten().for_each(text);
                for condition in &mut step.expect {
                    condition.target.as_mut().map(target);
                    if let ExpectedValue::String(equals) = &mut condition.equals {
                        text(equals);
                    }
                }
                if named_by_param {
                    step.risk = None;
                }
                ensure!(
                    step.risk() != Risk::Commit,
                    "\"{}\" is a commit step, and this version replays only read and reversible steps",
                    step.target.name
                );
                if matches!(step.action, Action::Fill | Action::Select | Action::Press) {
                    ensure!(
                        !names_sensitive(&step.target.name),
                        "\"{}\" looks like a secret or card field",
                        step.target.name
                    );
                }
            }
        }
        Ok(bound)
    }

    /// What a person reviewing the saved recipe should look at.
    pub(crate) fn summary(&self) -> Value {
        let mut steps = Vec::new();
        let mut downgrades = Vec::new();
        for segment in &self.segments {
            for (index, step) in segment.steps.iter().enumerate() {
                steps.push(
                    json!({"segment":segment.id,"step":index,"action":step.action,
                    "target":step.target,"risk":step.risk()}),
                );
                if step.risk() < step.inferred_risk() {
                    downgrades.push(json!({"segment":segment.id,"step":index,
                        "target":step.target,"inferred":step.inferred_risk(),"declared":step.risk()}));
                }
            }
        }
        let mut hints = BTreeSet::new();
        for target in self.targets() {
            for text in [Some(target.name.as_str()), target.ctx.as_deref()]
                .into_iter()
                .flatten()
            {
                if let Some(kind) = personal_data_hint(text) {
                    hints.insert(format!(
                        "\"{text}\" contains {kind}; make it a parameter if it can change"
                    ));
                }
            }
        }
        for segment in &self.segments {
            for step in &segment.steps {
                for literal in step.value.iter().chain(step.values.iter().flatten()) {
                    if placeholders(literal).is_empty() {
                        if let Some(kind) = personal_data_hint(literal) {
                            hints.insert(format!(
                                "a value for \"{}\" contains {kind} and is stored in the file",
                                step.target.name
                            ));
                        }
                    }
                }
            }
        }
        json!({"segments":self.segments.len(),"steps":steps,"risk_downgrades":downgrades,
            "params":self.params.keys().collect::<Vec<_>>(),
            "outputs":self.outputs.keys().collect::<Vec<_>>(),
            "hints":hints})
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn report() -> Value {
        json!({
            "recipe_version": 1,
            "name": "sales-report",
            "description": "Read a region's total",
            "site": {"origins": ["https://erp.example.com"], "start": "/report"},
            "params": {
                "region": {"type": "enum", "values": ["East", "North"]},
                "quarter": {"type": "string", "pattern": "^Q[1-4]$"}
            },
            "segments": [{
                "id": "query",
                "requires": [{"role": "heading", "name": "Sales"}],
                "steps": [
                    {"action": "select", "target": {"role": "combobox", "name": "Region"}, "values": ["{{region}}"]},
                    {"action": "select", "target": {"role": "combobox", "name": "Quarter"}, "values": ["{{quarter}}"]},
                    {"action": "click", "target": {"role": "button", "name": "Search"}}
                ],
                "until": {"text": "Total", "timeout_ms": 1000}
            }],
            "outputs": {"total": {"regex": "Total \\$(\\d+)", "required": true}},
            "interrupts": [{
                "when": {"role": "dialog", "name": "Offer"},
                "click": {"role": "button", "name": "Close"}
            }]
        })
    }

    pub(crate) fn parsed(value: Value) -> Result<Recipe, Refusal> {
        from_value(value)
    }

    fn rejected(change: impl FnOnce(&mut Value)) -> String {
        let mut value = report();
        change(&mut value);
        parsed(value).unwrap_err().message
    }

    #[test]
    fn the_design_example_is_valid_and_round_trips() {
        let recipe = parsed(report()).unwrap();
        assert_eq!(recipe.revision, 1);
        assert_eq!(recipe.vom, VOM_FORMAT_VERSION);
        let again: Recipe = serde_json::from_value(serde_json::to_value(&recipe).unwrap()).unwrap();
        assert_eq!(again, recipe);
    }

    #[test]
    fn a_future_format_is_refused_as_a_version_not_as_a_bad_file() {
        for (key, value) in [("recipe_version", 2), ("vom", 99)] {
            let mut recipe = report();
            recipe[key] = value.into();
            recipe["from_the_future"] = true.into();
            if key == "vom" {
                recipe.as_object_mut().unwrap().remove("from_the_future");
            }
            assert_eq!(parsed(recipe).unwrap_err().reason, "unsupported_version");
        }
    }

    #[test]
    fn invalid_recipes_are_rejected_with_the_cause() {
        type Change = Box<dyn FnOnce(&mut Value)>;
        let cases: Vec<(&str, Change)> = vec![
            ("name must", Box::new(|r| r["name"] = "../up".into())),
            ("name must", Box::new(|r| r["name"] = "Upper".into())),
            ("name must", Box::new(|r| r["name"] = "nul".into())),
            ("description", Box::new(|r| r["description"] = " ".into())),
            (
                "must be exactly",
                Box::new(|r| r["site"]["origins"] = json!(["https://a.test/x"])),
            ),
            (
                "must be exactly",
                Box::new(|r| r["site"]["origins"] = json!(["ftp://a.test"])),
            ),
            (
                "path on the site",
                Box::new(|r| r["site"]["start"] = "//evil.test/".into()),
            ),
            (
                "path on the site",
                Box::new(|r| r["site"]["start"] = "https://evil.test/".into()),
            ),
            ("invalid recipe", Box::new(|r| r["typo"] = 1.into())),
            (
                "invalid recipe",
                Box::new(|r| r["segments"][0]["steps"][0]["target"]["css"] = "#a".into()),
            ),
            (
                "invalid recipe",
                Box::new(|r| r["segments"][0]["steps"][0]["action"] = "evaluate".into()),
            ),
            (
                "needs a name",
                Box::new(|r| r["segments"][0]["steps"][2]["target"]["name"] = " ".into()),
            ),
            (
                "not declared",
                Box::new(|r| r["segments"][0]["steps"][0]["values"] = json!(["{{nope}}"])),
            ),
            (
                "select takes values",
                Box::new(|r| {
                    r["segments"][0]["steps"][0]
                        .as_object_mut()
                        .unwrap()
                        .remove("values");
                }),
            ),
            (
                "takes only a target",
                Box::new(|r| r["segments"][0]["steps"][2]["value"] = "x".into()),
            ),
            (
                "repeated",
                Box::new(|r| {
                    let segment = r["segments"][0].clone();
                    r["segments"].as_array_mut().unwrap().push(segment);
                }),
            ),
            (
                "exactly one",
                Box::new(|r| r["segments"][0]["until"]["target"] = json!({"role":"a","name":"b"})),
            ),
            (
                "timeout_ms",
                Box::new(|r| r["segments"][0]["until"]["timeout_ms"] = 25001.into()),
            ),
            (
                "invalid regex",
                Box::new(|r| r["outputs"]["total"]["regex"] = "(".into()),
            ),
            (
                "invalid pattern",
                Box::new(|r| r["params"]["quarter"]["pattern"] = "(".into()),
            ),
            (
                "matches only",
                Box::new(|r| r["interrupts"][0]["when"]["role"] = "button".into()),
            ),
            (
                "commit action",
                Box::new(|r| r["interrupts"][0]["click"]["name"] = "Delete".into()),
            ),
            (
                "at most 20 steps",
                Box::new(|r| {
                    let step = r["segments"][0]["steps"][2].clone();
                    r["segments"][0]["steps"] = Value::Array(vec![step; 21]);
                }),
            ),
            (
                "at most 100 steps",
                Box::new(|r| {
                    let step = r["segments"][0]["steps"][2].clone();
                    r["segments"] = Value::Array(
                        (0..6)
                            .map(|i| json!({"id":i.to_string(),"steps":vec![step.clone();20]}))
                            .collect(),
                    );
                }),
            ),
        ];
        for (expected, change) in cases {
            let message = rejected(change);
            assert!(message.contains(expected), "{expected}: {message}");
        }
    }

    #[test]
    fn irreversible_steps_are_refused_until_their_phase_unless_downgraded() {
        for (name, key) in [
            ("Submit order", None),
            ("确认支付", None),
            ("保存草稿", None),
            ("Search", Some("Enter")),
            ("Search", Some("Ctrl+Enter")),
        ] {
            let message = rejected(|r| {
                let step = &mut r["segments"][0]["steps"][2];
                step["target"]["name"] = name.into();
                if let Some(key) = key {
                    step["action"] = "press".into();
                    step["key"] = key.into();
                }
            });
            assert!(message.contains("commit step"), "{name}: {message}");
        }
        let mut downgraded = report();
        let step = &mut downgraded["segments"][0]["steps"][2];
        step["target"]["name"] = "Save filters".into();
        step["risk"] = "reversible".into();
        let recipe = parsed(downgraded).unwrap();
        assert_eq!(recipe.summary()["risk_downgrades"][0]["inferred"], "commit");
        // Names that only contain a word are not commits.
        for name in ["Search", "Postcode", "Sales order", "Payload"] {
            let step: Step = serde_json::from_value(json!(
                {"action":"click","target":{"role":"button","name":name}}))
            .unwrap();
            assert_eq!(step.risk() == Risk::Commit, name == "Sales order", "{name}");
        }
    }

    #[test]
    fn secrets_and_card_fields_cannot_be_saved() {
        for name in ["Password", "短信验证码", "Card number", "CVV", "登录密码"] {
            let message = rejected(|r| {
                r["segments"][0]["steps"][0] = json!({"action":"fill",
                    "target":{"role":"textbox","name":name},"value":"{{region}}"});
            });
            assert!(message.contains("secret or card"), "{name}: {message}");
        }
        assert!(!names_sensitive("Spinner"));
        assert!(!names_sensitive("Shipping address"));
    }

    #[test]
    fn personal_data_in_locators_produces_a_hint() {
        let mut value = report();
        value["segments"][0]["steps"][2]["target"]["name"] = "Search".into();
        value["segments"][0]["steps"][2]["target"]["ctx"] = "ada@example.com".into();
        value["segments"][0]["steps"][1] = json!({"action":"fill",
            "target":{"role":"textbox","name":"Mobile"},"value":"13800138000"});
        let summary = parsed(value).unwrap().summary();
        let hints = summary["hints"].to_string();
        assert!(hints.contains("email"), "{hints}");
        assert!(hints.contains("stored in the file"), "{hints}");
        assert_eq!(personal_data_hint("Q3 2026"), None);
    }

    #[test]
    fn parameters_are_checked_then_substituted_everywhere() {
        let mut value = report();
        value["params"]["order"] = json!({"type":"string","default":"A-1"});
        value["segments"][0]["navigate"] = "/orders/{{order}}?q={{quarter}}".into();
        value["segments"][0]["steps"][2]["target"]["ctx"] = "Row {{order}}".into();
        value["segments"][0]["steps"][2]["expect"] =
            json!([{"field":"text","equals":"Row {{order}}"}]);
        value["segments"][0]["until"]["text"] = "Done {{ quarter }}".into();
        let recipe = parsed(value).unwrap();
        let given = |pairs: &[(&str, &str)]| {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect::<BTreeMap<_, _>>()
        };
        for (pairs, expected) in [
            (vec![("region", "South"), ("quarter", "Q1")], "not one of"),
            (
                vec![("region", "East"), ("quarter", "Q9")],
                "does not match",
            ),
            (vec![("region", "East")], "missing param quarter"),
            (
                vec![("region", "East"), ("quarter", "Q1"), ("x", "1")],
                "unknown param",
            ),
        ] {
            let error = recipe
                .resolve_params(&given(&pairs))
                .unwrap_err()
                .to_string();
            assert!(error.contains(expected), "{error}");
        }
        let values = recipe
            .resolve_params(&given(&[
                ("region", "East"),
                ("quarter", "Q1"),
                ("order", "a/b c"),
            ]))
            .unwrap();
        let bound = recipe.bind(&values).unwrap();
        let segment = &bound.segments[0];
        // Encoded, so a value cannot change which page the path names.
        assert_eq!(segment.navigate.as_deref(), Some("/orders/a%2Fb%20c?q=Q1"));
        assert_eq!(segment.steps[0].values.as_ref().unwrap(), &["East"]);
        assert_eq!(segment.steps[2].target.ctx.as_deref(), Some("Row a/b c"));
        assert_eq!(
            segment.steps[2].expect[0].equals,
            ExpectedValue::String("Row a/b c".into())
        );
        assert_eq!(
            segment.until.as_ref().unwrap().text.as_deref(),
            Some("Done Q1")
        );
    }

    #[test]
    fn a_control_named_by_a_parameter_is_classified_after_substitution() {
        let mut value = report();
        value["params"]["verb"] = json!({"type":"string"});
        let step = &mut value["segments"][0]["steps"][2];
        step["target"]["name"] = "{{verb}}".into();
        step["risk"] = "reversible".into();
        let recipe = parsed(value).unwrap();
        let mut values = BTreeMap::from([
            ("region".to_string(), "East".to_string()),
            ("quarter".to_string(), "Q1".to_string()),
            ("verb".to_string(), "Search".to_string()),
        ]);
        assert!(recipe.bind(&values).is_ok());
        values.insert("verb".into(), "Delete".into());
        // The declared downgrade described a different name.
        assert!(
            recipe
                .bind(&values)
                .unwrap_err()
                .to_string()
                .contains("commit")
        );
    }
}
