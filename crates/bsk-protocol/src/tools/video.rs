//! Browser-owned video artifacts outlive their task session. Reads require both
//! the original connection identity and an unguessable recording capability.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VideoQuality {
    Standard,
    Clear,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum VideoParams {
    Start {
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tab_id: Option<i64>,
        max_duration_ms: u32,
        quality: VideoQuality,
        request_id: String,
    },
    Capabilities {
        #[serde(skip_serializing_if = "Option::is_none")]
        browser: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
    List {
        #[serde(skip_serializing_if = "Option::is_none")]
        browser: Option<String>,
    },
    Status {
        browser: String,
        recording_id: String,
        capability: String,
    },
    Stop {
        browser: String,
        recording_id: String,
        capability: String,
    },
    Read {
        browser: String,
        recording_id: String,
        capability: String,
        offset: u64,
    },
    Discard {
        browser: String,
        recording_id: String,
        capability: String,
    },
    Exported {
        browser: String,
        recording_id: String,
        capability: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VideoState {
    Starting,
    Recording,
    Finalizing,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum VideoCompleteness {
    Complete,
    Partial,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VideoRecording {
    pub recording_id: String,
    pub session_id: String,
    pub tab_id: i64,
    pub title: String,
    pub state: VideoState,
    pub quality: VideoQuality,
    pub created_at: u64,
    pub expires_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    pub max_duration_ms: u32,
    pub duration_ms: u64,
    pub byte_size: u64,
    pub width: u32,
    pub height: u32,
    pub frames: u64,
    pub dropped_frames: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completeness: Option<VideoCompleteness>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub exported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VideoGrant {
    pub recording: VideoRecording,
    pub capability: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct VideoReadResult {
    pub recording_id: String,
    pub offset: u64,
    pub byte_size: u64,
    pub next_offset: u64,
    pub data_base64: String,
}
