//! Profile bookmarks, accessed through the extension's optional permission.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct BookmarksParams {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// Chrome's native node shape. Preserve metadata for backups.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkNode {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<BookmarkNode>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_added: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_group_modified: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_last_used: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unmodifiable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub syncing: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct BookmarksResult {
    pub nodes: Vec<BookmarkNode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed_id: Option<String>,
}
