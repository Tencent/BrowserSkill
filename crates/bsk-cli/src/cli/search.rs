//! Web search using You.com API.

use clap::Args;
use serde::{Deserialize, Serialize};

use crate::cli::error::CliError;

#[derive(Debug, Args)]
pub struct SearchArgs {
    /// Search query
    pub query: String,

    /// Number of results to return (default: 10, max: 20)
    #[arg(short = 'c', long, default_value = "10")]
    pub count: u32,

    /// Search type: search, news
    #[arg(short = 't', long, default_value = "search")]
    pub search_type: String,

    /// Include raw HTML content
    #[arg(long)]
    pub include_raw_content: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResult {
    pub url: String,
    pub title: String,
    pub snippet: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_content: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResponse {
    pub results: Vec<SearchResult>,
    pub query: String,
    pub count: u32,
}

pub fn dispatch(args: SearchArgs) -> Result<SearchResponse, CliError> {
    let api_key = std::env::var("YDC_API_KEY").ok();
    let base_url =
        std::env::var("YDC_BASE_URL").unwrap_or_else(|_| "https://api.you.com".to_string());

    // Validate count parameter
    let count = if args.count > 20 { 20 } else { args.count };

    let client = reqwest::blocking::Client::new();

    // Build query string manually
    let mut query_params = vec![
        format!("query={}", args.query.replace(" ", "+")),
        format!("count={}", count),
        format!("search_type={}", args.search_type),
    ];

    if args.include_raw_content {
        query_params.push("include_raw_content=true".to_string());
    }

    let url = format!("{}/v1/agents/search?{}", base_url, query_params.join("&"));

    // Build request
    let mut request_builder = client.get(&url);

    // Add authentication if available
    if let Some(key) = api_key {
        request_builder = request_builder.header("Authorization", format!("Bearer {}", key));
    }

    // Make the request
    let response = request_builder.send().map_err(|e| anyhow::Error::from(e))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response
            .text()
            .unwrap_or_else(|_| "Unknown error".to_string());

        return Err(CliError::Local(anyhow::Error::msg(format!(
            "Search API returned error {}: {}",
            status, error_text
        ))));
    }

    // Parse response
    let search_data: serde_json::Value = response.json().map_err(|e| anyhow::Error::from(e))?;

    // Extract results from the response
    let results = extract_search_results(&search_data, args.include_raw_content)?;

    Ok(SearchResponse {
        results,
        query: args.query,
        count,
    })
}

fn extract_search_results(
    data: &serde_json::Value,
    include_raw_content: bool,
) -> Result<Vec<SearchResult>, CliError> {
    let mut results = Vec::new();

    // Try to extract from different possible response formats
    if let Some(web_results) = data.get("results").and_then(|r| r.get("web")) {
        if let Some(web_array) = web_results.as_array() {
            for item in web_array {
                if let Some(result) = parse_search_item(item, include_raw_content) {
                    results.push(result);
                }
            }
        }
    } else if let Some(results_array) = data.get("results").and_then(|r| r.as_array()) {
        // Handle direct results array format
        for item in results_array {
            if let Some(result) = parse_search_item(item, include_raw_content) {
                results.push(result);
            }
        }
    } else if let Some(web_array) = data.get("web").and_then(|w| w.as_array()) {
        // Handle top-level web array format
        for item in web_array {
            if let Some(result) = parse_search_item(item, include_raw_content) {
                results.push(result);
            }
        }
    }

    Ok(results)
}

fn parse_search_item(item: &serde_json::Value, include_raw_content: bool) -> Option<SearchResult> {
    let url = item.get("url")?.as_str()?.to_string();
    let title = item.get("title")?.as_str()?.to_string();
    let snippet = item
        .get("snippet")
        .or_else(|| item.get("description"))
        .or_else(|| item.get("content"))?
        .as_str()?
        .to_string();

    let raw_content = if include_raw_content {
        item.get("raw_content")
            .and_then(|c| c.as_str())
            .map(|s| s.to_string())
    } else {
        None
    };

    Some(SearchResult {
        url,
        title,
        snippet,
        raw_content,
    })
}
