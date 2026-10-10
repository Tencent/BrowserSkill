//! Structured DOM extraction. Only this CLI writes agent-facing output paths.
use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use bsk_protocol::tools::{ExtractAction, ExtractField, ExtractParams, ExtractResult};
use bsk_protocol::{ErrorCode, Method};
use clap::{Args, ValueEnum};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::error::{CliError, Format};
use super::{TOOL_IPC_TIMEOUT, atomic_output, business_rpc, ensure_daemon::ensure_daemon};

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum Action {
    Discover,
    Table,
    List,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum OutputFormat {
    Json,
    Csv,
}

#[derive(Debug, Clone, Args)]
pub struct ExtractArgs {
    /// Discover containers, extract a table, or extract list items.
    #[arg(value_enum)]
    pub action: Action,
    #[arg(long)]
    pub session: String,
    #[arg(long)]
    pub tab_id: Option<i64>,
    /// Unique CSS container selector in the top-level document.
    #[arg(long, conflicts_with_all = ["target", "ref_"])]
    pub selector: Option<String>,
    /// A session/document-bound target_id returned by extract discover.
    #[arg(long, conflicts_with_all = ["selector", "ref_"])]
    pub target: Option<String>,
    /// Fresh DOM reference from observe/snapshot.
    #[arg(long = "ref", conflicts_with_all = ["selector", "target"])]
    pub ref_: Option<String>,
    /// Item selector relative to the list container.
    #[arg(long)]
    pub item_selector: Option<String>,
    /// JSON file containing { "fields": [...] }; list extraction only.
    #[arg(long, conflicts_with = "fields_json")]
    pub fields: Option<PathBuf>,
    /// Inline { "fields": [...] }, useful for tool adapters.
    #[arg(long, conflicts_with = "fields")]
    pub fields_json: Option<String>,
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..=5000))]
    pub max_rows: Option<u32>,
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..=200))]
    pub max_columns: Option<u32>,
    #[arg(long, value_parser = clap::value_parser!(u32).range(1024..=4194304))]
    pub max_bytes: Option<u32>,
    /// Renderer collection budget in milliseconds (default 5000).
    #[arg(long, value_parser = clap::value_parser!(u32).range(100..=15000))]
    pub timeout_ms: Option<u32>,
    #[arg(long = "format", value_enum, default_value = "json")]
    pub output_format: OutputFormat,
    /// Save on the CLI host. CSV also saves <out>.meta.json.
    #[arg(long)]
    pub out: Option<PathBuf>,
    /// Replace existing output files after successful extraction.
    #[arg(long, requires = "out")]
    pub overwrite: bool,
    /// Prefix formula-like CSV cells with an apostrophe; record originals in metadata.
    #[arg(long)]
    pub csv_safe: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FieldsFile {
    fields: Vec<ExtractField>,
}

fn load_fields(args: &ExtractArgs) -> anyhow::Result<Option<Vec<ExtractField>>> {
    const MAX_FIELDS_BYTES: u64 = 262_144;
    let content = if let Some(path) = &args.fields {
        let mut content = Vec::new();
        std::fs::File::open(path)
            .with_context(|| format!("read fields from {}", path.display()))?
            .take(MAX_FIELDS_BYTES + 1)
            .read_to_end(&mut content)?;
        Some(content)
    } else {
        args.fields_json
            .as_ref()
            .map(|value| value.as_bytes().to_vec())
    };
    content
        .map(|content| {
            if content.len() as u64 > MAX_FIELDS_BYTES {
                bail!("fields JSON exceeds 256 KiB");
            }
            Ok(serde_json::from_slice::<FieldsFile>(&content)
                .context("parse extraction fields")?
                .fields)
        })
        .transpose()
}
fn params(args: &ExtractArgs) -> anyhow::Result<ExtractParams> {
    if !matches!(args.action, Action::List)
        && (args.fields.is_some() || args.fields_json.is_some() || args.item_selector.is_some())
    {
        bail!("--fields, --fields-json and --item-selector require list extraction");
    }
    if matches!(args.action, Action::Discover)
        && (args.target.is_some() || args.ref_.is_some() || args.output_format == OutputFormat::Csv)
    {
        bail!("discover accepts a selector scope and JSON output only");
    }
    if args.csv_safe && args.output_format != OutputFormat::Csv {
        bail!("--csv-safe requires --format csv");
    }
    Ok(ExtractParams {
        action: match args.action {
            Action::Discover => ExtractAction::Discover,
            Action::Table => ExtractAction::Table,
            Action::List => ExtractAction::List,
        },
        session_id: args.session.clone(),
        tab_id: args.tab_id,
        selector: args.selector.clone(),
        target_id: args.target.clone(),
        ref_: args.ref_.clone(),
        item_selector: args.item_selector.clone(),
        fields: load_fields(args)?,
        max_rows: args.max_rows,
        max_columns: args.max_columns,
        max_bytes: args.max_bytes,
        timeout_ms: args.timeout_ms,
    })
}
pub fn dispatch(args: ExtractArgs, format: Format) -> Result<(), CliError> {
    if args.output_format == OutputFormat::Csv
        && args.out.is_none()
        && matches!(format, Format::Json)
    {
        return Err(CliError::Local(anyhow::anyhow!(
            "--json with --format csv requires --out; otherwise stdout is CSV"
        )));
    }
    let params = params(&args).map_err(CliError::Local)?;
    if let Some(path) = &args.out {
        preflight(path, args.overwrite).map_err(CliError::Local)?;
        if args.output_format == OutputFormat::Csv {
            preflight(&metadata_path(path), args.overwrite).map_err(CliError::Local)?;
        }
    }
    let daemon = ensure_daemon().context("ensure daemon is running")?;
    let reply: ExtractResult = business_rpc::call(
        daemon.sock_path, "extract", Method::ToolExtract, Some(params), TOOL_IPC_TIMEOUT,
    ).map_err(|error| match error {
        CliError::Rpc { code: ErrorCode::UnknownMethod, .. } => CliError::Rpc {
            code: ErrorCode::Unsupported,
            message: "Structured extraction needs a matching CLI, daemon and extension; update them and restart the daemon".into(),
            data: None, source: None,
        },
        other => other,
    })?;
    render(&reply, &args, format).map_err(CliError::Local)
}
fn metadata_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".meta.json");
    name.into()
}
fn preflight(path: &Path, overwrite: bool) -> anyhow::Result<()> {
    if !overwrite && path.try_exists()? {
        bail!("output exists: {} (use --overwrite)", path.display());
    }
    Ok(())
}
fn stage(path: &Path, bytes: &[u8]) -> anyhow::Result<tempfile::NamedTempFile> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    Ok(temp)
}
fn formula_like(value: &str) -> bool {
    value.starts_with(['\t', '\r', '\n']) || value.trim_start().starts_with(['=', '+', '-', '@'])
}
fn csv_export(reply: &ExtractResult, safe: bool) -> anyhow::Result<(Vec<u8>, Value)> {
    let reserved = ["_source_url", "_source_frame_url", "_source_row"];
    let mut used: HashSet<String> = reserved.iter().map(|value| (*value).into()).collect();
    let mut headers = Vec::new();
    for column in &reply.columns {
        let base = if column.name.is_empty() {
            &column.key
        } else {
            &column.name
        };
        let mut name = base.clone();
        let mut suffix = 2;
        while !used.insert(name.clone()) {
            name = format!("{base} ({suffix})");
            suffix += 1;
        }
        headers.push(name);
    }
    headers.extend(reserved.iter().map(|value| (*value).into()));
    let mut escaped = Vec::new();
    let mut nulls = Vec::new();
    let mut writer = csv::WriterBuilder::new()
        .terminator(csv::Terminator::CRLF)
        .from_writer(Vec::new());
    let mut emitted_names = HashSet::new();
    let emitted_headers: Vec<String> = headers
        .iter()
        .enumerate()
        .map(|(column, value)| {
            let base = if safe && formula_like(value) {
                escaped.push(json!({"header": column, "original": value}));
                format!("'{value}")
            } else {
                value.clone()
            };
            let mut name = base.clone();
            let mut suffix = 2;
            while !emitted_names.insert(name.clone()) {
                name = format!("{base} ({suffix})");
                suffix += 1;
            }
            name
        })
        .collect();
    writer.write_record(&emitted_headers)?;
    for (index, row) in reply.rows.iter().enumerate() {
        let mut cells = Vec::new();
        for column in &reply.columns {
            let value = row.get(&column.key).and_then(Option::as_deref);
            if value.is_none() {
                nulls.push(json!({"row": index, "column": column.key}));
            }
            let value = value.unwrap_or("");
            cells.push(if safe && formula_like(value) {
                escaped.push(json!({"row": index, "column": column.key, "original": value}));
                format!("'{value}")
            } else {
                value.to_string()
            });
        }
        cells.push(reply.source.page_url.clone());
        cells.push(reply.source.frame_url.clone());
        cells.push(
            reply
                .row_sources
                .get(index)
                .context("missing row provenance")?
                .source_row
                .to_string(),
        );
        writer.write_record(&cells)?;
    }
    let bytes = writer.into_inner().map_err(|error| error.into_error())?;
    let metadata = json!({
        "schema_version": reply.schema_version, "kind": reply.kind,
        "source": reply.source, "columns": reply.columns, "csv_headers": emitted_headers,
        "row_sources": reply.row_sources, "spans": reply.spans,
        "coverage": reply.coverage, "warnings": reply.warnings,
        "null_cells": nulls, "escaped_cells": escaped,
        "csv_safe": safe, "csv_sha256": Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
    });
    Ok((bytes, metadata))
}
fn render(reply: &ExtractResult, args: &ExtractArgs, format: Format) -> anyhow::Result<()> {
    let (bytes, metadata) = match args.output_format {
        OutputFormat::Json => (serde_json::to_vec_pretty(reply)?, None),
        OutputFormat::Csv => {
            let (bytes, meta) = csv_export(reply, args.csv_safe)?;
            (bytes, Some(meta))
        }
    };
    if let Some(out) = &args.out {
        let data = stage(out, &bytes)?;
        let meta_path = metadata.as_ref().map(|_| metadata_path(out));
        let meta_temp = metadata
            .as_ref()
            .zip(meta_path.as_ref())
            .map(|(meta, path)| stage(path, &serde_json::to_vec_pretty(meta)?))
            .transpose()?;
        // The sidecar is committed first, with the CSV hash. Each file is atomic;
        // callers must not treat the pair as a filesystem transaction.
        if let (Some(temp), Some(path)) = (&meta_temp, &meta_path) {
            atomic_output::commit(temp.path(), path, args.overwrite)
                .context("commit extraction metadata")?;
        }
        atomic_output::commit(data.path(), out, args.overwrite).with_context(|| {
            format!(
                "commit output {}; metadata may already be present",
                out.display()
            )
        })?;
        let receipt = json!({
            "path": out, "metadata_path": meta_path, "byte_size": bytes.len(),
            "columns": reply.columns, "source": reply.source, "coverage": reply.coverage,
            "warnings": reply.warnings,
        });
        if matches!(format, Format::Json) {
            println!("{}", serde_json::to_string_pretty(&receipt)?);
        } else {
            println!("Saved {} rows to {}", reply.rows.len(), out.display());
        }
    } else {
        std::io::stdout().lock().write_all(&bytes)?;
        if args.output_format == OutputFormat::Json {
            println!();
        }
    }
    if reply.coverage.truncated {
        eprintln!(
            "warning: extraction is truncated ({})",
            reply.coverage.stop_reason.as_deref().unwrap_or("budget")
        );
    }
    if args.output_format == OutputFormat::Csv && args.out.is_none() {
        for warning in &reply.warnings {
            eprintln!("warning: {warning}");
        }
        eprintln!(
            "coverage: loaded_dom; dataset_complete={:?}; use --out to retain detailed metadata",
            reply.coverage.dataset_complete
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> ExtractResult {
        serde_json::from_value(json!({
            "schema_version": 1, "kind": "table", "tab_id": 7,
            "source": {"page_url":"https://example.com/orders", "frame_url":"https://example.com/orders", "frame_id":"root", "title":"订单", "captured_at":"2026-10-01T00:00:00Z"},
            "columns": [
                {"key":"c1","name":"金额","header_path":["金额"],"name_source":"header"},
                {"key":"c2","name":"金额","header_path":["金额"],"name_source":"header"},
                {"key":"c3","name":"_source_url","header_path":[],"name_source":"header"}
            ],
            "rows":[{"c1":"000123","c2":"中文, \"quoted\"\nline","c3":null},{"c1":"=1+1","c2":"","c3":"-2"}],
            "row_sources":[{"row":0,"source_row":2,"row_kind":"data","locator":"#row1"},{"row":1,"source_row":3,"row_kind":"data","locator":"#row2"}],
            "spans":[], "warnings":[],
            "coverage":{"scope":"loaded_dom","rows_returned":2,"truncated":false,"dataset_complete":"unknown"}
        })).unwrap()
    }
    #[test]
    fn csv_round_trips_text_headers_provenance_and_null_metadata() {
        let (bytes, meta) = csv_export(&sample(), false).unwrap();
        let mut reader = csv::Reader::from_reader(bytes.as_slice());
        assert_eq!(
            reader.headers().unwrap().iter().collect::<Vec<_>>(),
            vec![
                "金额",
                "金额 (2)",
                "_source_url (2)",
                "_source_url",
                "_source_frame_url",
                "_source_row"
            ]
        );
        let rows = reader.records().collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(&rows[0][0], "000123");
        assert_eq!(&rows[0][1], "中文, \"quoted\"\nline");
        assert_eq!(&rows[0][5], "2");
        assert_eq!(meta["null_cells"], json!([{"row":0,"column":"c3"}]));
        assert!(meta["escaped_cells"].as_array().unwrap().is_empty());
    }
    #[test]
    fn spreadsheet_mode_records_each_changed_original() {
        let (bytes, meta) = csv_export(&sample(), true).unwrap();
        let rows = csv::Reader::from_reader(bytes.as_slice())
            .records()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(&rows[1][0], "'=1+1");
        assert_eq!(&rows[1][2], "'-2");
        assert_eq!(meta["escaped_cells"].as_array().unwrap().len(), 2);
        assert_eq!(
            meta["csv_sha256"],
            Sha256::digest(&bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
    }

    #[test]
    fn safe_csv_headers_remain_unique_after_escaping() {
        let mut reply = sample();
        reply.columns[0].name = "=title".into();
        reply.columns[1].name = "'=title".into();
        let (bytes, meta) = csv_export(&reply, true).unwrap();
        let mut reader = csv::Reader::from_reader(bytes.as_slice());
        let headers = reader.headers().unwrap();
        assert_eq!(&headers[0], "'=title");
        assert_eq!(&headers[1], "'=title (2)");
        assert_eq!(
            meta["escaped_cells"][0],
            json!({"header":0,"original":"=title"})
        );
    }
}
