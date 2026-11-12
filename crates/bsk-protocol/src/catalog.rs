//! Export the protocol from the same catalog used by Rust dispatch.
//!
//! Daemon-local payloads deliberately remain outside the extension contract.
//! Shared and extension methods, plus handshake/error/event roots, are exported in full.

use schemars::{JsonSchema, Schema, SchemaGenerator, generate::SchemaSettings};
use serde::Serialize;
use serde_json::{Value, json};

use crate::{ErrorCode, EventKind, Method, RpcError, RpcErrorReason, method::MethodEffect};

pub const PROTOCOL_VERSION: &str = "1.10";
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
    pub action_metadata: bool,
    pub features: &'static [crate::compatibility::Feature],
    pub params: String,
    pub result: String,
}

impl MethodDescriptor {
    pub fn new<P: JsonSchema, R: JsonSchema>(
        method: &'static str,
        owner: MethodOwner,
        effect: MethodEffect,
        action_metadata: bool,
        features: &'static [crate::compatibility::Feature],
        generator: &mut SchemaGenerator,
    ) -> Self {
        Self {
            method,
            owner,
            effect,
            action_metadata,
            features,
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
    register::<crate::tools::TraceV2>(&mut generator);
    register::<crate::tools::TraceV3>(&mut generator);
    register::<crate::tools::StepV2>(&mut generator);
    register::<crate::tools::StepV3>(&mut generator);
    register::<crate::tools::RecordedStep>(&mut generator);
    let mut definitions = generator.take_definitions(false);
    let metadata_properties = definitions
        .get("ActionMetadata")
        .and_then(|schema| schema.get("properties"))
        .and_then(Value::as_object)
        .expect("ActionMetadata properties")
        .clone();
    for descriptor in &methods {
        if !descriptor.action_metadata {
            continue;
        }
        let properties = definitions
            .get_mut(&descriptor.params)
            .and_then(Value::as_object_mut)
            .and_then(|schema| schema.get_mut("properties"))
            .and_then(Value::as_object_mut)
            .unwrap_or_else(|| panic!("{} properties must be an object", descriptor.params));
        properties.extend(metadata_properties.clone());
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
        "feature_requirements": crate::compatibility::Feature::ALL.iter().map(|f| f.requirement()).collect::<Vec<_>>(),
        "constants": {
            "TRACE_VERSION_V2": crate::tools::TRACE_VERSION_V2,
            "TRACE_VERSION_V3": crate::tools::TRACE_VERSION_V3,
            "VOM_FORMAT_VERSION": crate::tools::VOM_FORMAT_VERSION,
        },
        "debug_actions": crate::tools::DebugAction::ALL.iter().map(|action| json!({
            "action": action,
            "effect": action.effect(),
            "owner": action.owner(),
            "cooperation_guarded": action.cooperation_guarded(),
        })).collect::<Vec<_>>(),
        "schema": input,
        "output_schema": output,
    })
}
