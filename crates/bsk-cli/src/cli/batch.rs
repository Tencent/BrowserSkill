//! One bounded request for a known sequence. Never retry or silently replay a
//! partial batch: its receipt is also available through `batch-status`.

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context;
use bsk_protocol::tools::{
    BATCH_DEFAULT_TIMEOUT_MS, BATCH_MAX_BYTES, BATCH_MAX_TIMEOUT_MS, BatchParams, BatchPlan,
    BatchResult, BatchStatus, BatchStatusParams,
};
use bsk_protocol::{ErrorCode, Method, RpcError};
use clap::Args;
use serde_json::json;

use super::ensure_daemon::ensure_daemon;
use super::error::{CliError, Format};
use super::navigate::parse_timeout_ms;

#[derive(Debug, Clone, Args)]
pub struct BatchArgs {
    /// JSON plan containing observation_id and steps. Input is never evaluated as code.
    #[arg(long)]
    pub file: PathBuf,
    #[arg(long)]
    pub session: String,
    #[arg(long)]
    pub tab_id: Option<i64>,
    /// Stable receipt id. Reusing it retrieves the existing result without replaying.
    #[arg(long)]
    pub request_id: Option<String>,
    /// Total execution and final-observation budget, at most 120s.
    #[arg(long, default_value = "30s", value_parser = parse_timeout_ms)]
    pub timeout: u32,
}

#[derive(Debug, Clone, Args)]
pub struct BatchStatusArgs {
    #[arg(long)]
    pub session: String,
    #[arg(long)]
    pub request_id: String,
}

fn read_plan(path: &std::path::Path) -> Result<BatchPlan, CliError> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .context("open batch plan")?
        .take((BATCH_MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .context("read batch plan")?;
    if bytes.len() > BATCH_MAX_BYTES {
        return Err(anyhow::anyhow!("batch plan exceeds 64 KiB").into());
    }
    let plan: BatchPlan = serde_json::from_slice(&bytes).context("invalid batch plan")?;
    plan.validate().map_err(anyhow::Error::msg)?;
    Ok(plan)
}

pub fn dispatch(args: BatchArgs, format: Format) -> Result<(), CliError> {
    let plan = read_plan(&args.file)?;
    if !(1..=BATCH_MAX_TIMEOUT_MS).contains(&args.timeout) {
        return Err(
            anyhow::anyhow!("batch timeout must be in 1..={BATCH_MAX_TIMEOUT_MS}ms").into(),
        );
    }
    let request_id = args
        .request_id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if request_id.is_empty()
        || request_id.len() > 64
        || !request_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(anyhow::anyhow!("invalid batch request id").into());
    }
    let info = ensure_daemon().context("ensure daemon is running")?;
    // Available even if the IPC connection is lost before a result arrives.
    eprintln!("batch request_id={request_id}");
    let params = BatchParams {
        session_id: args.session,
        request_id: request_id.clone(),
        observation_id: plan.observation_id,
        steps: plan.steps,
        tab_id: args.tab_id,
        timeout_ms: Some(args.timeout),
    };
    let reply = super::business_rpc::call::<_, BatchResult>(
        info.sock_path,
        "batch",
        Method::ToolBatch,
        Some(params),
        Duration::from_millis(u64::from(args.timeout)).saturating_add(Duration::from_secs(15)),
    )
    .map_err(|error| with_receipt_hint(error, &request_id))?;
    render_result(reply, format, false)
}

pub fn dispatch_status(args: BatchStatusArgs, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    let reply = super::business_rpc::call::<_, BatchResult>(
        info.sock_path,
        "batch-status",
        Method::ToolBatchStatus,
        Some(BatchStatusParams {
            session_id: args.session,
            request_id: args.request_id,
        }),
        Duration::from_millis(u64::from(BATCH_DEFAULT_TIMEOUT_MS) + 5000),
    )?;
    render_result(reply, format, true)
}

fn with_receipt_hint(error: CliError, request_id: &str) -> CliError {
    let unsupported = matches!(
        error.code(),
        Some(ErrorCode::UnknownMethod | ErrorCode::Unsupported | ErrorCode::VersionTooOld)
    );
    let mut data = error
        .data()
        .filter(|data| data.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    data["request_id"] = json!(request_id);
    if data.get("effect_state").is_none() {
        data["effect_state"] = json!(if unsupported { "none" } else { "unknown" });
    }
    let message = if data.get("batch").is_some() {
        "Batch interrupted. Inspect its partial receipt; do not repeat completed or uncertain actions. If the user cancelled, stop until they resume."
    } else if unsupported {
        "Batch is unavailable; continue with existing single actions. No batch steps were dispatched."
    } else {
        "Batch did not return a confirmed receipt. Query batch-status with this request_id, then inspect the page before continuing. Do not replay the plan."
    };
    CliError::from_rpc(RpcError {
        code: error.code().unwrap_or(ErrorCode::ProtocolError),
        message: format!("{message} {error}"),
        data: Some(data),
    })
}

fn render_result(reply: BatchResult, format: Format, query: bool) -> Result<(), CliError> {
    let failed =
        !query && (reply.status != BatchStatus::Completed || reply.observation_error.is_some());
    let error_code = reply
        .error
        .as_ref()
        .or(reply.observation_error.as_ref())
        .map_or(ErrorCode::ProtocolError, |error| error.code);
    if matches!(format, Format::Json) {
        if failed {
            return Err(CliError::from_rpc(RpcError {
                code: error_code,
                message: "Batch needs attention. Keep completed actions; inspect the observation and continue with single actions. Do not replay completed or uncertain steps.".into(),
                data: Some(json!({"request_id":reply.request_id,"batch":reply})),
            }));
        }
        println!(
            "{}",
            serde_json::to_string_pretty(&reply).context("encode batch result")?
        );
    } else {
        println!("batch {} status={:?}", reply.request_id, reply.status);
        for step in &reply.steps {
            println!(
                "  {}. {}: {:?} (effect={:?})",
                step.index + 1,
                step.action,
                step.status,
                step.effect_state
            );
        }
        for error in [reply.error.as_ref(), reply.observation_error.as_ref()]
            .into_iter()
            .flatten()
        {
            eprintln!("{}", error.message);
        }
        if let Some(observation) = &reply.observation {
            if let Some(id) = &observation.observation_id {
                println!("observation_id={id}");
            }
            println!("{}", observation.text);
        }
        if failed {
            eprintln!(
                "Inspect the page and continue with single actions; completed actions were not rolled back."
            );
            return Err(CliError::Rendered {
                code: error_code,
                message: "batch incomplete".into(),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn parses_batch_without_changing_single_action_commands() {
        let cli = crate::cli::Cli::try_parse_from([
            "bsk",
            "batch",
            "--session",
            "s",
            "--file",
            "plan.json",
            "--request-id",
            "r1",
        ])
        .unwrap();
        let crate::cli::Command::Batch(args) = cli.command else {
            panic!("expected batch")
        };
        assert_eq!(args.request_id.as_deref(), Some("r1"));
        assert_eq!(args.timeout, BATCH_DEFAULT_TIMEOUT_MS);
        assert!(
            crate::cli::Cli::try_parse_from([
                "bsk",
                "fill",
                "@e1",
                "--value",
                "text",
                "--session",
                "s"
            ])
            .is_ok()
        );
    }

    #[test]
    fn transport_failure_never_claims_the_plan_was_not_executed() {
        let error = with_receipt_hint(anyhow::anyhow!("connection lost").into(), "r1");
        assert_eq!(error.data().unwrap()["effect_state"], "unknown");
        assert_eq!(error.data().unwrap()["request_id"], "r1");
    }

    #[test]
    fn cancellation_preserves_the_partial_receipt() {
        let receipt = json!({"status":"stopped", "steps":[{"status":"completed"}]});
        let error = with_receipt_hint(
            CliError::from_rpc(RpcError {
                code: ErrorCode::UserAborted,
                message: "cancelled".into(),
                data: Some(json!({"batch": receipt})),
            }),
            "r1",
        );
        assert_eq!(error.code(), Some(ErrorCode::UserAborted));
        assert_eq!(error.data().unwrap()["batch"], receipt);
    }

    #[test]
    fn partial_execution_returns_an_error_with_the_full_receipt() {
        let receipt = json!({
            "request_id":"r1", "status":"stopped", "elapsed_ms":10,
            "steps":[
                {"index":0,"action":"fill","status":"completed","effect_state":"committed"},
                {"index":1,"action":"click","status":"not_run","effect_state":"none"}
            ],
            "error":{"code":"not_found","message":"target replaced"}
        });
        let error = render_result(
            serde_json::from_value(receipt.clone()).unwrap(),
            Format::Json,
            false,
        )
        .unwrap_err();
        assert_eq!(error.code(), Some(ErrorCode::NotFound));
        assert_eq!(error.data().unwrap()["batch"], receipt);
    }
}
