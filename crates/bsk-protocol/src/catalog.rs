//! Export the protocol from the same catalog used by Rust dispatch.
//!
//! Daemon-local payloads deliberately remain outside the extension contract.
//! Shared and extension methods, plus handshake/error roots, are exported in full.

use schemars::{JsonSchema, Schema, SchemaGenerator, generate::SchemaSettings};
use serde::Serialize;
use serde_json::{Value, json};

use crate::{ErrorCode, Method, RpcError, method::MethodEffect};

pub const PROTOCOL_VERSION: &str = "1.3";
pub const MIN_COMPATIBLE_PROTOCOL: &str = "1.0";

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
    pub owner: MethodOwner,
    pub effect: MethodEffect,
    pub params: String,
    pub result: String,
}

impl MethodDescriptor {
    pub fn new<P: JsonSchema, R: JsonSchema>(
        method: &'static str,
        owner: MethodOwner,
        effect: MethodEffect,
        generator: &mut SchemaGenerator,
    ) -> Self {
        Self {
            method,
            owner,
            effect,
            params: register::<P>(generator),
            result: register::<R>(generator),
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
    let methods = Method::ALL
        .iter()
        .map(|method| method.describe(&mut generator))
        .collect();
    register::<ErrorCode>(&mut generator);
    register::<RpcError>(&mut generator);
    register::<crate::tools::TraceV2>(&mut generator);
    register::<crate::tools::TraceV3>(&mut generator);
    register::<crate::tools::StepV2>(&mut generator);
    register::<crate::tools::StepV3>(&mut generator);
    register::<crate::tools::RecordedStep>(&mut generator);
    (
        methods,
        json!({
            "$schema": "http://json-schema.org/draft-07/schema#",
            "definitions": generator.take_definitions(false),
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
        "constants": {
            "TRACE_VERSION_V2": crate::tools::TRACE_VERSION_V2,
            "TRACE_VERSION_V3": crate::tools::TRACE_VERSION_V3,
            "VOM_FORMAT_VERSION": crate::tools::VOM_FORMAT_VERSION,
        },
        "debug_actions": crate::tools::DebugAction::ALL.iter().map(|action| json!({
            "action": action,
            "effect": action.effect(),
            "owner": action.owner(),
        })).collect::<Vec<_>>(),
        "schema": input,
        "output_schema": output,
    })
}
