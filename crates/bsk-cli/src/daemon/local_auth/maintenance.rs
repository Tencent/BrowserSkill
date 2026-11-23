//! IPC and offline maintenance share exactly the same operations.

use super::LocalAuth;
use anyhow::{Result, ensure};
use bsk_protocol::local_auth::{
    LocalAuthDevicesParams, LocalAuthPairParams, LocalAuthPairResult, LocalAuthRevokeParams,
    LocalAuthRevokeResult, LocalAuthRotateParams, LocalAuthRotateResult, LocalAuthSetModeParams,
    LocalAuthSetModeResult,
};
use bsk_protocol::{ErrorCode, Method, ResponseBody, RpcError};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc};

fn params<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value)
        .map_err(|_| anyhow::anyhow!("invalid pairing maintenance parameters"))
}

fn empty_params(value: Value) -> Result<()> {
    if !value.is_null() {
        let _: LocalAuthDevicesParams = params(value)?;
    }
    Ok(())
}

/// Pre-local-pairing daemons used the file-locked remote store directly.
/// This compatibility path never changes the live local pairings.
pub fn execute_legacy_remote(home: &Path, method: Method, value: Value) -> Result<Value> {
    let remote = super::super::remote::authorization::AuthorizationStore::at_home(home);
    ensure!(
        remote.is_configured()?,
        "local pairing maintenance requires a newer daemon"
    );
    match method {
        Method::LocalAuthPair => {
            let args: LocalAuthPairParams = params(value)?;
            ensure!(
                args.replace.is_none(),
                "--replace requires a newer local daemon"
            );
            Ok(serde_json::to_value(LocalAuthPairResult {
                link: remote.pair()?,
            })?)
        }
        Method::LocalAuthDevices => {
            empty_params(value)?;
            Ok(Value::Array(remote_devices(&remote)?))
        }
        Method::LocalAuthRevoke => {
            let args: LocalAuthRevokeParams = params(value)?;
            ensure!(
                args.all != args.device_id.is_some(),
                "specify a device or --all"
            );
            if args.all {
                ensure!(
                    !super::store::PairingStore::has_valid_records_at(home)?,
                    "local pairings also exist; restart with a newer daemon to revoke all devices"
                );
                remote.revoke_all()?;
            } else {
                ensure!(
                    remote.revoke(&args.device_id.unwrap())?,
                    "device grant not found"
                );
            }
            Ok(serde_json::to_value(LocalAuthRevokeResult {
                revoked: true,
            })?)
        }
        _ => anyhow::bail!("local pairing maintenance requires a newer daemon"),
    }
}

fn remote_devices(
    remote: &super::super::remote::authorization::AuthorizationStore,
) -> Result<Vec<Value>> {
    remote
        .devices()?
        .into_iter()
        .map(|device| {
            let mut device = serde_json::to_value(device)?;
            device["kind"] = json!("remote");
            Ok(device)
        })
        .collect()
}

pub fn execute(
    local: &LocalAuth,
    home: &Path,
    port: u16,
    server: bool,
    method: Method,
    value: Value,
) -> Result<Value> {
    let remote = super::super::remote::authorization::AuthorizationStore::at_home(home);
    match method {
        Method::LocalAuthPair => {
            let args: LocalAuthPairParams = params(value)?;
            let link = if server {
                ensure!(
                    args.replace.is_none(),
                    "--replace is only available for local pairing"
                );
                remote.pair()?
            } else {
                local.store.pair(port, args.replace.as_deref())?
            };
            Ok(serde_json::to_value(LocalAuthPairResult { link })?)
        }
        Method::LocalAuthDevices => {
            empty_params(value)?;
            let mut devices = serde_json::to_value(local.store.devices())?
                .as_array()
                .unwrap()
                .clone();
            devices.extend(remote_devices(&remote)?);
            Ok(Value::Array(devices))
        }
        Method::LocalAuthRevoke => {
            let args: LocalAuthRevokeParams = params(value)?;
            ensure!(
                args.all != args.device_id.is_some(),
                "specify a device or --all"
            );
            if args.all {
                local.store.revoke(None)?;
                remote.revoke_all()?;
            } else {
                let id = args.device_id.as_deref().unwrap();
                if local.store.resolve(id).is_ok() {
                    local.store.revoke(Some(id))?;
                } else {
                    ensure!(remote.revoke(id)?, "device grant not found");
                }
            }
            Ok(serde_json::to_value(LocalAuthRevokeResult {
                revoked: true,
            })?)
        }
        Method::LocalAuthRotate => {
            let args: LocalAuthRotateParams = params(value)?;
            local.store.request_rotation(&args.device_id)?;
            Ok(serde_json::to_value(LocalAuthRotateResult {
                rotate_on_next_connection: true,
            })?)
        }
        Method::LocalAuthSetMode => {
            let args: LocalAuthSetModeParams = params(value)?;
            local.set_mode(home, args.mode)?;
            Ok(serde_json::to_value(LocalAuthSetModeResult {
                local_auth: args.mode,
            })?)
        }
        _ => anyhow::bail!("unsupported pairing maintenance operation"),
    }
}

pub async fn handle(
    state: Arc<super::super::state::DaemonState>,
    port: u16,
    method: Method,
    params: Value,
) -> ResponseBody {
    if method == Method::LocalAuthRevoke {
        return match super::lifecycle::revoke_command(state, params).await {
            Ok(value) => ResponseBody::Ok(value),
            Err(error) => ResponseBody::Err(RpcError {
                code: ErrorCode::InvalidParams,
                message: error.to_string(),
                data: None,
            }),
        };
    }
    // A rotation request cannot be lost behind an in-flight activation commit.
    let _rotation_guard = if method == Method::LocalAuthRotate {
        match serde_json::from_value::<LocalAuthRotateParams>(params.clone())
            .ok()
            .and_then(|args| state.local_auth.store.resolve(&args.device_id).ok())
        {
            Some(id) => Some(state.local_auth.device_gate(&id).lock_owned().await),
            None => None, // The shared executor returns the validation error.
        }
    } else {
        None
    };
    let result = tokio::task::spawn_blocking(move || {
        execute(
            &state.local_auth,
            &super::super::paths::ensure_bsk_home()?,
            port,
            state.config.server.is_some(),
            method,
            params,
        )
    })
    .await;
    match result {
        Ok(Ok(value)) => ResponseBody::Ok(value),
        Ok(Err(error)) => ResponseBody::Err(RpcError {
            code: ErrorCode::InvalidParams,
            message: error.to_string(),
            data: None,
        }),
        Err(_) => ResponseBody::Err(RpcError {
            code: ErrorCode::ProtocolError,
            message: "pairing maintenance failed".into(),
            data: None,
        }),
    }
}
