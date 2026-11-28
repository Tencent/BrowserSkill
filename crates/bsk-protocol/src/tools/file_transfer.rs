//! Content-transparent file transfer contracts.
//!
//! Public tool calls carry opaque transfer ids. Filesystem paths are injected
//! by the daemon only on the daemon -> extension hop and are never accepted as
//! an agent-facing source or destination.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::ActionExpectation;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UploadFile {
    pub transfer_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged_path: Option<String>,
    /// Daemon-injected, Safari only: the file's bytes (standard base64) for
    /// extensions that cannot read `staged_path` (a sandboxed Safari app
    /// extension has no filesystem access). Never agent-facing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_base64: Option<String>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum UploadMode {
    #[default]
    Input,
    Drop,
}

impl UploadMode {
    fn is_input(&self) -> bool {
        matches!(self, Self::Input)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UploadParams {
    pub session_id: String,
    #[serde(
        rename = "ref",
        alias = "ref_",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub ref_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    pub files: Vec<UploadFile>,
    #[serde(default, skip_serializing_if = "UploadMode::is_input")]
    pub mode: UploadMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u32>,
    /// Context actually returned by sync. Reusable for target-policy DOM actions;
    /// strict policy consumes it after one action. Never fill it from cached state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub context_id: Option<String>,
    /// Sync's single-use baseline for untargeted/visual actions under target policy,
    /// including untargeted keys and displacement-only drags. Drags with a
    /// target ref/selector need only context_id. A script needs it only when it
    /// states no expect facts; passing both checks the whole page as well.
    /// Strict-policy drag instead accepts its legacy ref-map observation token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation_id: Option<String>,
    /// Strict policy only: observed decision regions. Target policy requires exact
    /// business facts in expect; regions cannot be translated to facts automatically.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Vec<String>", length(max = 16))]
    pub depends_on: Option<Vec<String>>,
    /// Literal conditions checked before input. Selectors search the main document;
    /// use observed refs for iframe/shadow-root targets. Text includes all whitespace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Vec<ActionExpectation>", length(max = 16))]
    pub expect: Option<Vec<ActionExpectation>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UploadResult {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_selector: Option<String>,
    pub file_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DownloadParams {
    pub session_id: String,
    #[serde(
        rename = "ref",
        alias = "ref_",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub ref_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u32>,
    /// Daemon-injected relative directory beneath Chrome's Downloads root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_relative_dir: Option<String>,
    /// Daemon-injected authoritative transfer size limit. The extension uses
    /// it only for early cancellation; daemon import remains the final check.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_byte_size: Option<u64>,
    /// Context actually returned by sync. Reusable for target-policy DOM actions;
    /// strict policy consumes it after one action. Never fill it from cached state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub context_id: Option<String>,
    /// Sync's single-use baseline for untargeted/visual actions under target policy,
    /// including untargeted keys and displacement-only drags. Drags with a
    /// target ref/selector need only context_id. A script needs it only when it
    /// states no expect facts; passing both checks the whole page as well.
    /// Strict-policy drag instead accepts its legacy ref-map observation token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation_id: Option<String>,
    /// Strict policy only: observed decision regions. Target policy requires exact
    /// business facts in expect; regions cannot be translated to facts automatically.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Vec<String>", length(max = 16))]
    pub depends_on: Option<Vec<String>>,
    /// Literal conditions checked before input. Selectors search the main document;
    /// use observed refs for iframe/shadow-root targets. Text includes all whitespace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Vec<ActionExpectation>", length(max = 16))]
    pub expect: Option<Vec<ActionExpectation>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DownloadResult {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_selector: Option<String>,
    pub suggested_filename: String,
    pub byte_size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub danger: Option<String>,
    /// Extension-internal completed Chrome download path, stripped by the daemon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_path: Option<String>,
    /// Opaque id returned by the daemon to the CLI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transfer_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TransferBeginParams {
    pub session_id: String,
    pub name: String,
    pub byte_size: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TransferBeginResult {
    pub transfer_id: String,
    pub chunk_size: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TransferChunkParams {
    pub transfer_id: String,
    pub offset: u64,
    pub data_base64: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TransferReadParams {
    pub transfer_id: String,
    pub offset: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_base64: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TransferChunkResult {
    pub next_offset: u64,
    #[serde(default)]
    pub eof: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_base64: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TransferIdParams {
    pub transfer_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TransferReadyResult {
    pub transfer_id: String,
    pub byte_size: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TransferReleaseResult {
    pub released: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_agent_shape_omits_daemon_path_and_uses_ref_wire_name() {
        let value = serde_json::to_value(UploadParams {
            session_id: "s1".into(),
            ref_: Some("@e3".into()),
            selector: None,
            tab_id: None,
            files: vec![UploadFile {
                transfer_id: "tr_1".into(),
                name: "image.png".into(),
                staged_path: None,
                data_base64: None,
            }],
            mode: UploadMode::Input,
            timeout_ms: None,
            context_id: None,
            observation_id: None,
            depends_on: None,
            expect: None,
        })
        .unwrap();
        assert_eq!(value["ref"], "@e3");
        assert!(value["files"][0].get("staged_path").is_none());
        assert!(value.get("mode").is_none());
    }

    #[test]
    fn upload_drop_mode_is_explicit_on_the_wire() {
        let value = serde_json::to_value(UploadParams {
            session_id: "s1".into(),
            ref_: Some("@e3".into()),
            selector: None,
            tab_id: None,
            files: vec![UploadFile {
                transfer_id: "tr_1".into(),
                name: "image.png".into(),
                staged_path: None,
                data_base64: None,
            }],
            mode: UploadMode::Drop,
            timeout_ms: None,
            context_id: None,
            observation_id: None,
            depends_on: None,
            expect: None,
        })
        .unwrap();
        assert_eq!(value["mode"], "drop");
    }

    #[test]
    fn download_agent_shape_omits_daemon_path() {
        let value = serde_json::to_value(DownloadParams {
            session_id: "s1".into(),
            ref_: None,
            selector: Some("#export".into()),
            tab_id: None,
            timeout_ms: None,
            browser_relative_dir: None,
            max_byte_size: None,
            context_id: None,
            observation_id: None,
            depends_on: None,
            expect: None,
        })
        .unwrap();
        assert!(value.get("browser_relative_dir").is_none());
        assert!(value.get("max_byte_size").is_none());
    }
}
