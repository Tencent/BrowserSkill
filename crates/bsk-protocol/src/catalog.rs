//! Export the protocol from the same catalog used by Rust dispatch.
//!
//! Daemon-local payloads deliberately remain outside the extension contract.
//! Shared and extension methods, plus handshake/error/event roots, are exported in full.

use schemars::{JsonSchema, Schema, SchemaGenerator, generate::SchemaSettings};
use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    ActionMetadataPolicy, ErrorCode, EventKind, Method, RpcError, RpcErrorReason,
    method::MethodSpec,
};

pub const PROTOCOL_VERSION: &str = "2.0";
pub const MIN_COMPATIBLE_PROTOCOL: &str = "2.0";
pub const DEFAULT_DAEMON_PORT: u16 = 52800;
pub const DEFAULT_DAEMON_WS_URL: &str = "ws://127.0.0.1:52800";
pub const EXTENSION_CLIENT_ID: &str = "browser-skill-extension";
pub const LOCAL_PAIRING_FRAGMENT_PREFIX: &str = "bsk-local.v1.";
pub const REMOTE_AUTH_SUBPROTOCOL_PREFIX: &str = "bsk-auth.";
pub const INSTANCE_ID_HEX_LENGTH: usize = 8;

/// Returns whether `peer_protocol` satisfies the local protocol compatibility gate.
pub fn is_protocol_compatible(peer_protocol: &str) -> bool {
    !matches!(
        crate::evaluate_handshake_compat(
            peer_protocol,
            None,
            PROTOCOL_VERSION,
            MIN_COMPATIBLE_PROTOCOL,
        ),
        crate::HandshakeCompat::Reject { .. }
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MethodOwner {
    Daemon,
    Extension,
    Shared,
}

#[derive(Debug, Serialize)]
pub struct MethodDescriptor {
    pub method: &'static str,
    pub params: String,
    pub result: String,
    #[serde(flatten)]
    pub spec: &'static MethodSpec,
}

impl MethodDescriptor {
    pub fn new<P: JsonSchema, R: JsonSchema>(
        method: &'static str,
        spec: &'static MethodSpec,
        generator: &mut SchemaGenerator,
    ) -> Self {
        Self {
            method,
            params: register::<P>(generator),
            result: register::<R>(generator),
            spec,
        }
    }
}

fn register<T: JsonSchema>(generator: &mut SchemaGenerator) -> String {
    let name = T::schema_name().into_owned();
    let schema = generator.subschema_for::<T>();
    if let Some(reference) = schema
        .get("$ref")
        .and_then(Value::as_str)
        .and_then(|value| value.strip_prefix("#/definitions/"))
    {
        return reference.to_owned();
    }
    generator
        .definitions_mut()
        .entry(name.clone())
        .or_insert_with(|| schema.to_value());
    name
}

/// Draft-07 remains the on-disk schema format for CLI consumers.
pub fn schema_for<T: JsonSchema>() -> Schema {
    SchemaSettings::draft07()
        .for_deserialize()
        .into_generator()
        .into_root_schema_for::<T>()
}

fn describe(settings: SchemaSettings) -> (Vec<MethodDescriptor>, Value) {
    let mut generator = settings.into_generator();
    let methods: Vec<MethodDescriptor> = Method::ALL
        .iter()
        .map(|method| method.describe(&mut generator))
        .collect();
    register::<ErrorCode>(&mut generator);
    register::<RpcErrorReason>(&mut generator);
    register::<RpcError>(&mut generator);
    register::<EventKind>(&mut generator);
    register::<crate::tools::ActionExpectation>(&mut generator);
    register::<crate::tools::ActionMetadata>(&mut generator);
    register::<crate::tools::PendingJavaScriptDialog>(&mut generator);
    register::<crate::tools::DialogHandleParams>(&mut generator);
    register::<crate::tools::OperationParams>(&mut generator);
    register::<crate::tools::TraceV3>(&mut generator);
    register::<crate::tools::StepV3>(&mut generator);
    register::<crate::tools::VideoAction>(&mut generator);
    let mut definitions = generator.take_definitions(false);
    let metadata_properties = definitions
        .get("ActionMetadata")
        .and_then(|schema| schema.get("properties"))
        .and_then(Value::as_object)
        .expect("ActionMetadata properties")
        .clone();
    let context_only_property = json!({
        "description": "Optional cooperation context validated by the extension without renewing control.",
        "type": ["string", "null"],
    });
    for descriptor in &methods {
        match descriptor.spec.action_metadata {
            ActionMetadataPolicy::None => continue,
            ActionMetadataPolicy::ContextOnly => {
                let schema_obj = definitions
                    .get_mut(&descriptor.params)
                    .and_then(Value::as_object_mut)
                    .unwrap_or_else(|| panic!("{} schema must be an object", descriptor.params));
                let properties = schema_obj
                    .get_mut("properties")
                    .and_then(Value::as_object_mut)
                    .unwrap_or_else(|| {
                        panic!("{} properties must be an object", descriptor.params)
                    });
                properties
                    .entry("context_id")
                    .or_insert_with(|| context_only_property.clone());
                schema_obj.insert("additionalProperties".into(), json!(false));
            }
            ActionMetadataPolicy::Full => {
                let schema_obj = definitions
                    .get_mut(&descriptor.params)
                    .and_then(Value::as_object_mut)
                    .unwrap_or_else(|| panic!("{} schema must be an object", descriptor.params));
                let properties = schema_obj
                    .get_mut("properties")
                    .and_then(Value::as_object_mut)
                    .unwrap_or_else(|| {
                        panic!("{} properties must be an object", descriptor.params)
                    });
                properties.extend(metadata_properties.clone());
                schema_obj.insert("additionalProperties".into(), json!(false));
            }
        }
    }
    (
        methods,
        json!({
            "$schema": "http://json-schema.org/draft-07/schema#",
            "definitions": definitions,
        }),
    )
}

/// A single shared generator also prevents unrelated schemas from silently
/// assigning different shapes to the same definition name.
pub fn export() -> Value {
    let (methods, input) = describe(SchemaSettings::draft07().for_deserialize());
    let (_, output) = describe(SchemaSettings::draft07().for_serialize());
    json!({
        "format_version": 1,
        "protocol_version": PROTOCOL_VERSION,
        "min_compatible_protocol": MIN_COMPATIBLE_PROTOCOL,
        "methods": methods,
        "events": EventKind::ALL,
        "constants": {
            "TRACE_VERSION_V3": crate::tools::TRACE_VERSION_V3,
            "VOM_FORMAT_VERSION": crate::tools::VOM_FORMAT_VERSION,
            "DEFAULT_DAEMON_PORT": DEFAULT_DAEMON_PORT,
            "DEFAULT_DAEMON_WS_URL": DEFAULT_DAEMON_WS_URL,
            "EXTENSION_CLIENT_ID": EXTENSION_CLIENT_ID,
            "LOCAL_PAIRING_FRAGMENT_PREFIX": LOCAL_PAIRING_FRAGMENT_PREFIX,
            "REMOTE_AUTH_SUBPROTOCOL_PREFIX": REMOTE_AUTH_SUBPROTOCOL_PREFIX,
            "LOCAL_AUTH_KDF_DOMAIN": crate::local_auth::LOCAL_AUTH_KDF_DOMAIN,
            "INSTANCE_ID_HEX_LENGTH": INSTANCE_ID_HEX_LENGTH,
        },
        "debug_actions": crate::tools::DebugAction::ALL.iter().map(|action| json!({
            "action": action,
            "effect": action.effect(),
            "owner": action.owner(),
            "cooperation_guarded": action.cooperation_guarded(),
            "wal_tracked": action.wal_tracked(),
            "dialog_gated": action.dialog_gated(),
        })).collect::<Vec<_>>(),
        "video_actions": crate::tools::VideoAction::ALL.iter().map(|action| json!({
            "action": action,
            "resumes_control": action.resumes_control(),
            "interrupt_gated": action.interrupt_gated(),
            "dialog_gated": action.dialog_gated(),
            "uses_session_queue": action.uses_session_queue(),
        })).collect::<Vec<_>>(),
        "rpc_error_reasons": RpcErrorReason::ALL,
        "schema": input,
        "output_schema": output,
    })
}
