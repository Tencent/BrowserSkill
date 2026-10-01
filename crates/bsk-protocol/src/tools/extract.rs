//! Bounded, passive extraction from the currently loaded DOM.
use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExtractAction {
    Discover,
    Table,
    List,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ExtractField {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub selector: String,
    pub read: ExtractRead,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribute: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExtractRead {
    Text,
    Href,
    Attribute,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ExtractParams {
    pub session_id: String,
    pub action: ExtractAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
    pub ref_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_selector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<ExtractField>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_rows: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_columns: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ExtractColumn {
    pub key: String,
    pub name: String,
    pub header_path: Vec<String>,
    pub name_source: ExtractNameSource,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExtractNameSource {
    Header,
    Generated,
    Field,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ExtractSource {
    pub page_url: String,
    pub frame_url: String,
    pub frame_id: String,
    pub title: String,
    pub captured_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ExtractRowSource {
    pub row: u32,
    pub source_row: u32,
    pub row_kind: ExtractRowKind,
    pub locator: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExtractRowKind {
    Data,
    Footer,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ExtractSpan {
    pub row: u32,
    pub column: String,
    pub row_span: u32,
    pub column_span: u32,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExtractScope {
    LoadedDom,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExtractCompleteness {
    Unknown,
    Incomplete,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ExtractCoverage {
    pub scope: ExtractScope,
    pub rows_returned: u32,
    pub truncated: bool,
    pub dataset_complete: ExtractCompleteness,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_rows: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_columns: Option<i64>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ExtractTarget {
    pub target_id: String,
    pub kind: ExtractTargetKind,
    pub name: String,
    pub frame_url: String,
    pub frame_id: String,
    pub columns: Vec<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExtractTargetKind {
    Table,
    List,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ExtractResult {
    pub schema_version: u32,
    pub kind: ExtractAction,
    pub tab_id: i64,
    pub source: ExtractSource,
    pub columns: Vec<ExtractColumn>,
    pub rows: Vec<BTreeMap<String, Option<String>>>,
    pub row_sources: Vec<ExtractRowSource>,
    pub spans: Vec<ExtractSpan>,
    pub coverage: ExtractCoverage,
    pub warnings: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub targets: Option<Vec<ExtractTarget>>,
}
