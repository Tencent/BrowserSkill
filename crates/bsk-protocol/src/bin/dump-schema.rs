//! Emit JSON Schema files for handshake + §7 tool params/results (`schema/`).

use std::fs;
use std::path::PathBuf;

use bsk_protocol::catalog;
use serde_json::{Map, Value};
use std::collections::BTreeSet;

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
    let mut root = definitions[name].clone();
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
            if name == "Value" {
                continue;
            }
            write_schema(&dir, &format!("{base}_{part}"), standalone(&catalog, name));
        }
    }
    // Stable file aliases for reusable CLI/documentation schemas. Their shapes
    // still come from the catalog; this list cannot hide a method from generation.
    for (name, file) in [
        ("EmulateOverrides", "tool_emulate_overrides"),
        ("UserAgentMetadata", "tool_emulate_user_agent_metadata"),
        ("ConsoleEntry", "tool_console_entry"),
        ("ConsoleStackFrame", "tool_console_stack_frame"),
        ("NetworkEntry", "tool_network_entry"),
        ("EvaluateError", "tool_evaluate_error"),
        ("TraceV2", "trace_v2"),
        ("TraceV3", "trace_v3"),
        ("RecordedTrace", "trace"),
        ("StepV2", "trace_step_v2"),
        ("StepV3", "trace_step_v3"),
        ("RecordedStep", "trace_step"),
    ] {
        write_schema(&dir, file, standalone(&catalog, name));
    }
}
