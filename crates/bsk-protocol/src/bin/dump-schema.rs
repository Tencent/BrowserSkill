//! Emit JSON Schema files for handshake + §7 tool params/results (`schema/`).

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use bsk_protocol::catalog;
use serde_json::{Map, Value};

fn references(value: &Value, names: &mut BTreeSet<String>) {
    match value {
        Value::Object(object) => {
            if let Some(name) = object
                .get("$ref")
                .and_then(Value::as_str)
                .and_then(|s| s.strip_prefix("#/definitions/"))
            {
                names.insert(name.to_owned());
            }
            for value in object.values() {
                references(value, names);
            }
        }
        Value::Array(values) => {
            for value in values {
                references(value, names);
            }
        }
        _ => {}
    }
}

fn standalone(catalog: &Value, name: &str) -> Value {
    let definitions = catalog["schema"]["definitions"]
        .as_object()
        .expect("definitions");
    let mut root = definitions.get(name).expect("root definition").clone();
    // Boolean schemas are valid Draft-07 roots, but cannot carry metadata.
    // Wrapping them preserves their meaning while allowing a title and dialect.
    if root.is_boolean() {
        root = serde_json::json!({ "allOf": [root] });
    }
    let mut pending = BTreeSet::new();
    let mut included = Map::new();
    references(&root, &mut pending);
    while let Some(next) = pending.pop_first() {
        if included.contains_key(&next) {
            continue;
        }
        let schema = definitions
            .get(&next)
            .expect("referenced definition")
            .clone();
        references(&schema, &mut pending);
        included.insert(next, schema);
    }
    root["$schema"] = catalog["schema"]["$schema"].clone();
    root["title"] = Value::String(name.to_owned());
    if !included.is_empty() {
        root["definitions"] = Value::Object(included);
    }
    root
}

fn write_schema(dir: &std::path::Path, name: &str, schema: impl serde::Serialize) {
    fs::create_dir_all(dir).expect("create schema dir");
    let path = dir.join(format!("{name}.json"));
    let json = serde_json::to_string_pretty(&schema).expect("serialize schema");
    let mut json = json;
    json.push('\n');
    fs::write(&path, json).unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
}

fn main() {
    let mut args = std::env::args_os().skip(1);
    let dir = match args.next() {
        None => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("schema"),
        Some(flag) if flag == "--out-dir" => {
            let dir = PathBuf::from(args.next().expect("--out-dir requires a directory"));
            assert!(args.next().is_none(), "usage: dump-schema [--out-dir DIR]");
            dir
        }
        Some(_) => panic!("usage: dump-schema [--out-dir DIR]"),
    };
    let catalog = catalog::export();
    for method in catalog["methods"].as_array().expect("method catalog") {
        let wire = method["method"].as_str().expect("wire method");
        let base = if wire == "system.handshake" {
            "handshake".to_owned()
        } else {
            wire.replace('.', "_")
        };
        for part in ["params", "result"] {
            let name = method[part].as_str().expect("contract name");
            // Daemon-private payloads are intentionally not extension contracts.
            if method["owner"] == "daemon"
                && catalog["schema"]["definitions"][name] == Value::Bool(true)
            {
                continue;
            }
            write_schema(&dir, &format!("{base}_{part}"), standalone(&catalog, name));
        }
    }
    // Stable file aliases for reusable CLI/documentation schemas. Their shapes
    // still come from the catalog; this list cannot hide a method from generation.
    for (name, file) in [
        ("PendingJavaScriptDialog", "pending_javascript_dialog"),
        ("RpcErrorReason", "rpc_error_reason"),
        ("DialogHandleParams", "tool_dialog_handle_params"),
        ("OperationParams", "tool_operation_params"),
        ("ActionExpectation", "action_expectation"),
        ("ActionMetadata", "action_metadata"),
        ("VideoRecording", "video_recording"),
        ("VideoGrant", "video_grant"),
        ("VideoReadResult", "tool_video_read_result"),
        ("EmulateOverrides", "tool_emulate_overrides"),
        ("UserAgentMetadata", "tool_emulate_user_agent_metadata"),
        ("ConsoleEntry", "tool_console_entry"),
        ("ConsoleStackFrame", "tool_console_stack_frame"),
        ("NetworkEntry", "tool_network_entry"),
        ("EvaluateError", "tool_evaluate_error"),
        ("TraceV3", "trace_v3"),
        ("TraceV3", "trace"),
        ("StepV3", "trace_step_v3"),
        ("StepV3", "trace_step"),
    ] {
        write_schema(&dir, file, standalone(&catalog, name));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsk_protocol::tools::DragParams;
    use serde_json::{Value, json};

    #[test]
    fn composition_preserves_operation_fields_and_exposes_condition_limits() {
        let original = serde_json::to_value(catalog::schema_for::<DragParams>()).unwrap();
        let value = standalone(&catalog::export(), "DragParams");
        assert_eq!(value["required"], original["required"]);
        for (name, property) in original["properties"].as_object().unwrap() {
            assert_eq!(&value["properties"][name], property, "{name}");
        }
        assert_eq!(value["title"], "DragParams");
        assert_eq!(value["additionalProperties"], false);
        assert_eq!(value["properties"]["expect"]["type"], "array");
        assert_eq!(
            value["properties"]["observation_id"]["type"],
            json!(["string", "null"])
        );
        assert_eq!(value["properties"]["expect"]["maxItems"], 16);
        assert_eq!(
            value["definitions"]["ActionExpectation"]["properties"]["target"]["maxLength"],
            1024
        );
        assert_eq!(
            value["definitions"]["ActionExpectation"]["properties"]["attribute"]["maxLength"],
            256
        );
    }

    #[test]
    fn published_action_schemas_include_shared_metadata() {
        for operation in [
            "window_resize",
            "emulate",
            "tab_close",
            "navigate",
            "navigate_back",
            "navigate_forward",
            "reload",
            "click",
            "hover",
            "drag",
            "wheel",
            "scroll_to",
            "focus",
            "blur",
            "fill",
            "press",
            "select",
            "upload",
            "download",
            "observe",
            "screenshot_full_page",
            "debug",
            "evaluate",
        ] {
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join(format!("schema/tool_{operation}_params.json"));
            let schema: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
            for field in ["context_id", "observation_id", "depends_on", "expect"] {
                assert!(
                    schema["properties"].get(field).is_some(),
                    "{operation}.{field}"
                );
                assert!(
                    !schema["required"]
                        .as_array()
                        .unwrap()
                        .contains(&json!(field))
                );
            }
            assert_eq!(
                schema["properties"]["expect"]["items"]["$ref"],
                "#/definitions/ActionExpectation"
            );
            assert_eq!(
                schema["definitions"]["ActionExpectation"]["additionalProperties"],
                false
            );
        }
    }
}
