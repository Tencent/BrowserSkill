//! Serde model for the local site-memory tree (`$BSK_HOME/sites`).
//!
//! Every type here is persisted verbatim as JSON, so the wire names are
//! camelCase to match design §3.2 / §3.4. `deny_unknown_fields` is deliberate:
//! it is the schema-level half of the "no `@eN` refs in site memory" rule —
//! a derived workflow that still carries a record-local `ref` fails to parse
//! instead of silently persisting a dead anchor.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::{Date, Month, OffsetDateTime};

/// Version stamped into every `workflows/<id>.json`.
pub const WORKFLOW_SCHEMA_VERSION: u32 = 1;

/// A workflow unverified for longer than this is reported as stale.
pub const STALE_AFTER_DAYS: i64 = 30;

/// `SITE.md` hard budget: a longer file is rejected at checkpoint.
pub const SITE_MD_HARD_LINE_BUDGET: usize = 500;

/// `SITE.md` soft budget: past this, checkpoint warns and asks for references.
pub const SITE_MD_SOFT_LINE_BUDGET: usize = 200;

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

/// Replay strategy. Only `ui-only` exists by design (§6): a workflow may only
/// be reproduced through observe/act inside the Agent Window, never by
/// replaying cookies or intercepting requests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowStrategy {
    #[default]
    UiOnly,
}

/// Semantic anchor for a step target: role + accessible name + context text.
///
/// The record-local `ref` of [`bsk_protocol::tools::TargetDescriptorV3`] is
/// stripped during derivation and rejected here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StepTarget {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ctx: Option<String>,
}

impl StepTarget {
    pub fn is_empty(&self) -> bool {
        self.role.is_none() && self.name.is_none() && self.ctx.is_none()
    }

    /// One-line human rendering, e.g. `role=button name="提交" ctx="底部操作栏"`.
    pub fn describe(&self) -> String {
        let mut parts = Vec::new();
        if let Some(role) = &self.role {
            parts.push(format!("role={role}"));
        }
        if let Some(name) = &self.name {
            parts.push(format!("name={name:?}"));
        }
        if let Some(ctx) = &self.ctx {
            parts.push(format!("ctx={ctx:?}"));
        }
        if parts.is_empty() {
            "(no anchor)".to_string()
        } else {
            parts.join(" ")
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StepOp {
    Navigate,
    Click,
    Hover,
    Fill,
    Select,
    Press,
}

impl StepOp {
    pub fn as_str(self) -> &'static str {
        match self {
            StepOp::Navigate => "navigate",
            StepOp::Click => "click",
            StepOp::Hover => "hover",
            StepOp::Fill => "fill",
            StepOp::Select => "select",
            StepOp::Press => "press",
        }
    }
}

/// One replayable step. Flat rather than an internally tagged enum so the
/// on-disk shape matches design §3.2 and so validation can report a precise
/// "op `fill` requires `value` or `valueFrom`" style message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowStep {
    /// 1-based position; validated to be dense and ordered.
    pub n: u32,
    pub op: StepOp,
    /// `navigate` destination.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    /// Semantic anchor. `null` when the recorder could not match the element;
    /// such a step always carries `needsReview`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<StepTarget>,
    /// Inlined constant for `fill` / `select`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// Name of a declared parameter supplying this step's value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_from: Option<String>,
    /// How a `fill` is committed (`enter` / `suggestion` / `blur`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// `press` key name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Set by derivation wherever a human must confirm the projection.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub needs_review: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowParam {
    pub name: String,
    #[serde(default)]
    pub required: bool,
    /// A secret parameter never carries a value on disk (design §3.2).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub secret: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, rename = "enum", skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Precondition {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PostconditionExpect {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_pattern: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Postcondition {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub expect: Vec<PostconditionExpect>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceTrace {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recorded_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recorder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretsPolicy {
    /// Always `false`: recorded input values for redacted fields never land on
    /// disk (design §6, mirroring the operation-audit promise).
    #[serde(default)]
    pub store_values: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub redacted_fields: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workflow {
    pub schema_version: u32,
    pub id: String,
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    #[serde(default)]
    pub strategy: WorkflowStrategy,
    /// `YYYY-MM-DD` — the structured equivalent of webcmd's `[verified date]`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_verified: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_trace: Option<SourceTrace>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub params: Vec<WorkflowParam>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub preconditions: Vec<Precondition>,
    pub steps: Vec<WorkflowStep>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub postcondition: Option<Postcondition>,
    #[serde(default)]
    pub secrets_policy: SecretsPolicy,
    /// True while any derived step still needs a human pass.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub needs_review: bool,
    /// Free-form derivation notes for the agent reading this workflow.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub review_notes: Vec<String>,
}

impl Workflow {
    /// Days since `lastVerified`, or `None` when never verified / unparseable.
    pub fn days_since_verified(&self) -> Option<i64> {
        let verified = parse_date(self.last_verified.as_deref()?)?;
        Some(days_between(verified, OffsetDateTime::now_utc().date()))
    }

    /// True when a workflow *was* verified, but too long ago.
    ///
    /// A never-verified workflow is [`Self::is_unverified`], not stale. The two
    /// used to be the same flag, which made every freshly saved workflow read
    /// back as STALE + NEEDS REVIEW — an agent has no reason to distrust
    /// memory it just wrote, and conflating the two taught it to.
    pub fn is_stale(&self) -> bool {
        match self.days_since_verified() {
            Some(days) => days > STALE_AFTER_DAYS,
            None => false,
        }
    }

    /// True when the workflow has never been confirmed against the live site
    /// (no `lastVerified`, or one that does not parse).
    pub fn is_unverified(&self) -> bool {
        self.days_since_verified().is_none()
    }
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, clap::ValueEnum,
)]
#[serde(rename_all = "snake_case")]
#[clap(rename_all = "snake_case")]
pub enum CandidateKind {
    ActionSpace,
    BetterPath,
    Access,
    /// Exempt from the two-observation rule: one sighting is enough (§3.4).
    HighConsequence,
    RepeatedMistake,
}

impl CandidateKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CandidateKind::ActionSpace => "action_space",
            CandidateKind::BetterPath => "better_path",
            CandidateKind::Access => "access",
            CandidateKind::HighConsequence => "high_consequence",
            CandidateKind::RepeatedMistake => "repeated_mistake",
        }
    }

    /// Whether promoting this candidate needs corroboration from a second day.
    pub fn needs_corroboration(self) -> bool {
        !matches!(self, CandidateKind::HighConsequence)
    }
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, clap::ValueEnum,
)]
#[serde(rename_all = "snake_case")]
#[clap(rename_all = "snake_case")]
pub enum CandidateStatus {
    Pending,
    Ingested,
    Rejected,
}

impl CandidateStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            CandidateStatus::Pending => "pending",
            CandidateStatus::Ingested => "ingested",
            CandidateStatus::Rejected => "rejected",
        }
    }
}

/// Append-only observation. Candidates are never deleted — only their status
/// moves from `pending` to `ingested` / `rejected` at checkpoint (§3.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Candidate {
    pub id: String,
    pub host: String,
    /// `YYYY-MM-DD` in UTC. Two distinct values are what corroboration means.
    pub observed_date_utc: String,
    pub kind: CandidateKind,
    pub claim: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consequence: Option<String>,
    pub status: CandidateStatus,
    /// Set when the candidate came from `workflow verify --fail`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
}

/// Claims compare after trimming, lowercasing and collapsing whitespace so
/// "Submit needs the P2 dropdown" and "submit needs  the p2 dropdown"
/// corroborate each other.
pub fn normalize_claim(claim: &str) -> String {
    claim
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

// ---------------------------------------------------------------------------
// Draft context and journal
// ---------------------------------------------------------------------------

/// `.drafts/<taskId>/<host>/.context.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftContext {
    /// True when the host could not be normalised: the draft may be written
    /// but never promoted into active memory (§3.1 provisional fallback).
    pub read_only: bool,
    /// Revision the draft branched from; the default `expectedRevision`.
    pub base_revision: u64,
    pub host: String,
    pub task_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub revision: u64,
    pub at: String,
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub reason: String,
    pub paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ingested: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rejected: Vec<String>,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, clap::ValueEnum,
)]
#[serde(rename_all = "snake_case")]
#[clap(rename_all = "snake_case")]
pub enum CheckpointReason {
    CandidateIngestion,
    DirectCorrection,
    MajorRewrite,
}

impl CheckpointReason {
    pub fn as_str(self) -> &'static str {
        match self {
            CheckpointReason::CandidateIngestion => "candidate_ingestion",
            CheckpointReason::DirectCorrection => "direct_correction",
            CheckpointReason::MajorRewrite => "major_rewrite",
        }
    }
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/// Today in UTC as `YYYY-MM-DD`.
pub fn today_utc() -> String {
    format_date(OffsetDateTime::now_utc().date())
}

pub fn format_date(date: Date) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

/// Parse a strict `YYYY-MM-DD` date. Anything looser is rejected so a typo in
/// `[verified …]` surfaces at checkpoint instead of silently ageing out.
pub fn parse_date(text: &str) -> Option<Date> {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    if !bytes
        .iter()
        .enumerate()
        .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
    {
        return None;
    }
    let year: i32 = text[0..4].parse().ok()?;
    let month: u8 = text[5..7].parse().ok()?;
    let day: u8 = text[8..10].parse().ok()?;
    Date::from_calendar_date(year, Month::try_from(month).ok()?, day).ok()
}

pub fn days_between(from: Date, to: Date) -> i64 {
    i64::from(to.to_julian_day()) - i64::from(from.to_julian_day())
}

pub fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| today_utc())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strategy_serialises_as_ui_only() {
        let json = serde_json::to_value(WorkflowStrategy::UiOnly).unwrap();
        assert_eq!(json, serde_json::json!("ui-only"));
    }

    #[test]
    fn step_target_rejects_record_local_ref() {
        let err = serde_json::from_value::<StepTarget>(serde_json::json!({
            "role": "button",
            "ref": "e12"
        }))
        .unwrap_err();
        assert!(err.to_string().contains("ref"), "{err}");
    }

    #[test]
    fn parse_date_is_strict() {
        assert!(parse_date("2026-09-15").is_some());
        assert!(parse_date("2026-9-15").is_none());
        assert!(parse_date("2026-13-01").is_none());
        assert!(parse_date("2026-02-30").is_none());
        assert!(parse_date("not-a-date").is_none());
        assert!(parse_date("2026-09-15T00:00:00Z").is_none());
    }

    #[test]
    fn days_between_counts_calendar_days() {
        let a = parse_date("2026-01-01").unwrap();
        let b = parse_date("2026-03-01").unwrap();
        assert_eq!(days_between(a, b), 59);
        assert_eq!(days_between(b, a), -59);
    }

    #[test]
    fn never_verified_workflow_is_unverified_not_stale() {
        let wf = Workflow {
            schema_version: WORKFLOW_SCHEMA_VERSION,
            id: "x".into(),
            host: "example.com".into(),
            purpose: None,
            strategy: WorkflowStrategy::UiOnly,
            last_verified: None,
            source_trace: None,
            params: Vec::new(),
            preconditions: Vec::new(),
            steps: Vec::new(),
            postcondition: None,
            secrets_policy: SecretsPolicy::default(),
            needs_review: false,
            review_notes: Vec::new(),
        };
        assert!(wf.is_unverified(), "no lastVerified means unverified");
        assert!(
            !wf.is_stale(),
            "a workflow saved a minute ago is not stale; it is simply unverified"
        );
        assert_eq!(wf.days_since_verified(), None);

        let fresh = Workflow {
            last_verified: Some(today_utc()),
            ..wf.clone()
        };
        assert!(!fresh.is_unverified());
        assert!(!fresh.is_stale());

        let old = Workflow {
            last_verified: Some(format_date(
                OffsetDateTime::now_utc().date() - time::Duration::days(STALE_AFTER_DAYS + 1),
            )),
            ..wf
        };
        assert!(old.is_stale());
        assert!(!old.is_unverified());
    }

    #[test]
    fn normalize_claim_collapses_case_and_whitespace() {
        assert_eq!(
            normalize_claim("  Submit  needs\tthe P2 dropdown "),
            "submit needs the p2 dropdown"
        );
    }

    #[test]
    fn high_consequence_skips_corroboration() {
        assert!(!CandidateKind::HighConsequence.needs_corroboration());
        assert!(CandidateKind::ActionSpace.needs_corroboration());
    }
}
