//! IPC and offline maintenance share exactly the same operations.

use super::{LocalAuth, LocalAuthMode};
use anyhow::{Result, ensure};
use bsk_protocol::{ErrorCode, Method, ResponseBody, RpcError};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::Path, sync::Arc};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PairParams {
    replace: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RevokeParams {
    device_id: Option<String>,
    #[serde(default)]
    all: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RotateParams {
    device_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ModeParams {
    mode: LocalAuthMode,
}
fn params<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value)
        .map_err(|_| anyhow::anyhow!("invalid pairing maintenance parameters"))
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
            let args: PairParams = params(value)?;
            let link = if server {
                ensure!(
                    args.replace.is_none(),
                    "--replace is only available for local pairing"
                );
                remote.pair()?
            } else {
                local.store.pair(port, args.replace.as_deref())?
            };
            Ok(json!({"link": link}))
        }
        Method::LocalAuthDevices => {
            let mut devices = serde_json::to_value(local.store.devices())?
                .as_array()
                .unwrap()
                .clone();
            for device in remote.devices()? {
                let mut device = serde_json::to_value(device)?;
                device["kind"] = json!("remote");
                devices.push(device);
            }
            Ok(Value::Array(devices))
        }
        Method::LocalAuthRevoke => {
            let args: RevokeParams = params(value)?;
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
            Ok(json!({"revoked":true}))
        }
        Method::LocalAuthRotate => {
            let args: RotateParams = params(value)?;
            local.store.request_rotation(&args.device_id)?;
            Ok(json!({"rotate_on_next_connection":true}))
        }
        Method::LocalAuthSetMode => {
            let args: ModeParams = params(value)?;
            local.set_mode(home, args.mode)?;
            Ok(json!({"local_auth":args.mode}))
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
