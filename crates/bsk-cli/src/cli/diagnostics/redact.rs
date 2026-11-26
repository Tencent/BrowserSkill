//! Sanitize JSON before serialization and free text before it enters the ZIP.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

const MASK: &str = "[redacted]";
// Keep these names consistent with apps/extension/src/debug/redact.ts.
// Listing token names individually preserves non-secret pagination cursors.
const HEADER: &str = r"(?:proxy[-_]?)?authorization|(?:set[-_]?)?cookie";
const FIELD: &str = concat!(
    r"(?:(?:new|old|current|confirm|db)[-_]?)?(?:password|passwd|pwd)(?:[-_]?confirmation)?|",
    r"secret|client[-_]?secret|credentials?|(?:(?:access|refresh|next|id|auth|csrf|xsrf)[-_]?)?token|",
    r"api[-_]?key|session[-_]?(?:id|key)|private[-_]token|x[-_](?:api[-_]key|(?:auth|access|csrf|xsrf|vault)[-_]token|csrftoken)|",
    r"x[-_](?:goog[-_]api[-_]key|amz[-_]security[-_]token|shopify[-_]access[-_]token|hasura[-_]admin[-_]secret)|ocp[-_]apim[-_]subscription[-_]key"
);
static SECRET_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?i)^(?:{HEADER}|{FIELD})$")).unwrap());
static ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?i)\b(?:(?<header>{HEADER})|{FIELD})\]?(?:\\?["'])?[ \t]*(?<separator>[:=])[ \t]*"#
    ))
    .unwrap()
});
static AUTH_SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(Bearer|Basic)[ \t]+[a-z0-9._~+/=-]+").unwrap());
static URL_USERINFO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)([a-z][a-z0-9+.-]*://)[^/?#@\s]+@").unwrap());
// Local and remote pairing links carry a credential in the WebSocket URL fragment.
static PAIRING_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)\b(wss?://[^#\s"'<>]*)#[^\s"'<>]+"#).unwrap());

fn secret_name(key: &str) -> bool {
    key.split(['.', '[', ']'])
        .any(|part| SECRET_NAME.is_match(part))
}

pub(super) fn json(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            // Also recognize the name/value representation of HTTP headers.
            let secret_header = fields
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(secret_name);
            for (key, mut child) in std::mem::take(fields) {
                if secret_name(&key) || (secret_header && key == "value") {
                    child = Value::String(MASK.into());
                } else {
                    json(&mut child);
                }
                fields.insert(plain(&key), child);
            }
        }
        Value::Array(items) => {
            if let [name, value] = items.as_mut_slice()
                && name.as_str().is_some_and(secret_name)
            {
                *value = Value::String(MASK.into());
            } else {
                items.iter_mut().for_each(json);
            }
        }
        Value::String(s) => *s = text(s),
        _ => {}
    }
}

fn looks_like_json(input: &str) -> bool {
    let input = input.trim_start();
    let Some(array) = input.strip_prefix('[') else {
        return input.starts_with('{');
    };
    let first = array.trim_start();
    // A plain log prefix such as [INFO] or [2026-09-24] is not a JSON array.
    first.is_empty()
        || first.starts_with(['{', '[', '"', ']'])
        || first.split_once([',', ']']).is_some_and(|(item, _)| {
            let item = item.trim();
            matches!(item, "true" | "false" | "null") || item.parse::<serde_json::Number>().is_ok()
        })
}

pub(super) fn text(input: &str) -> String {
    if looks_like_json(input) {
        return match serde_json::from_str(input) {
            Ok(mut value) => {
                json(&mut value);
                value.to_string()
            }
            Err(_) => MASK.into(),
        };
    }
    plain(input)
}

/// Daemon tracing emits JSON records. Parse each entire value, including
/// embedded newlines. Keep plaintext together for folded HTTP headers.
pub(super) fn log(input: &str) -> String {
    let mut output = String::new();
    let mut plain_start = 0;
    let mut start = 0;
    while start < input.len() {
        let mut end = super::after_newline(input.as_bytes(), start);
        let line = &input[start..end];
        if !looks_like_json(line) || (start > plain_start && line.starts_with([' ', '\t'])) {
            start = end;
            continue;
        }
        output.push_str(&plain(&input[plain_start..start]));
        let mut records = serde_json::Deserializer::from_str(&input[start..]).into_iter::<Value>();
        match records.next() {
            Some(Ok(mut value)) => {
                let value_end = start + records.byte_offset();
                end = super::after_newline(input.as_bytes(), value_end);
                if input[value_end..end].trim().is_empty() {
                    json(&mut value);
                    output.push_str(&value.to_string());
                } else {
                    output.push_str(MASK);
                }
            }
            Some(Err(error)) if error.is_eof() => {
                output.push_str(MASK);
                end = input.len();
            }
            _ => output.push_str(MASK),
        }
        if input[..end].ends_with('\n') {
            output.push('\n');
        }
        start = end;
        plain_start = end;
    }
    output.push_str(&plain(&input[plain_start..]));
    output
}

fn plain(input: &str) -> String {
    let mut clean = String::new();
    let mut remaining = input;
    while let Some(found) = ASSIGNMENT.captures(remaining) {
        let start = found.get(0).unwrap().end();
        clean.push_str(&remaining[..start]);
        clean.push_str(MASK);
        let value = &remaining[start..];
        let len = if found.name("header").is_some() || &found["separator"] == ":" {
            // Cookies and authorization schemes can contain spaces, commas,
            // semicolons and quoted parameters. Consume the entire header.
            header_len(value)
        } else {
            value_len(value)
        };
        remaining = &value[len..];
    }
    clean.push_str(remaining);
    let clean = AUTH_SCHEME.replace_all(&clean, "$1 [redacted]");
    let clean = URL_USERINFO.replace_all(&clean, "${1}[redacted]@");
    PAIRING_LINK
        .replace_all(&clean, "${1}#[redacted]")
        .into_owned()
}

fn header_len(value: &str) -> usize {
    for (offset, _) in value.match_indices('\n') {
        if !value[offset + 1..].starts_with([' ', '\t']) {
            return offset - usize::from(value[..offset].ends_with('\r'));
        }
    }
    value.len()
}

fn value_len(value: &str) -> usize {
    let mut chars = value.char_indices();
    match chars.next() {
        Some((_, quote @ ('"' | '\''))) => {
            while let Some((offset, ch)) = chars.next() {
                if ch == '\\' {
                    chars.next();
                } else if ch == quote {
                    return offset + ch.len_utf8();
                }
            }
            value.len()
        }
        // A compound value or an extra layer of quoting in unstructured
        // text has no reliable field delimiter. Omit the rest of the line.
        Some((_, '{' | '[' | '\\')) => header_len(value),
        _ => value
            .find(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | '&' | '}' | ']'))
            .unwrap_or(value.len()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn text_masks_values_and_preserves_unrelated_diagnostics() {
        for (input, expected) in [
            (r#"{"token": "DEMO_SECRET"}"#, r#"{"token":"[redacted]"}"#),
            (
                r#"{"authorization": "Bearer DEMO_SECRET"}"#,
                r#"{"authorization":"[redacted]"}"#,
            ),
            (
                "token='DEMO_SECRET' status=unhealthy",
                "token=[redacted] status=unhealthy",
            ),
            (
                r#"failed: token="DEMO_\"SECRET" retry"#,
                "failed: token=[redacted] retry",
            ),
            (
                r"failed: token='DEMO_\'SECRET' retry",
                "failed: token=[redacted] retry",
            ),
            ("Cookie: a=DEMO_A; b=DEMO_B", "Cookie: [redacted]"),
            ("X-Api-Key: DEMO_A, DEMO_B", "X-Api-Key: [redacted]"),
            (
                "Authorization: Digest a=\"DEMO_A\", b=\"DEMO_B\"\r\n\tDEMO_C\r\nnext",
                "Authorization: [redacted]\r\nnext",
            ),
            (
                "no token supplied; status=unhealthy",
                "no token supplied; status=unhealthy",
            ),
            (
                "https://user:DEMO_SECRET@host/?api_key=DEMO_B&pageToken=2",
                "https://[redacted]@host/?api_key=[redacted]&pageToken=2",
            ),
            (
                "failed with Bearer DEMO_SECRET",
                "failed with Bearer [redacted]",
            ),
            (
                "pair ws://127.0.0.1:52800/#bsk-local.v1.DEMO_SECRET",
                "pair ws://127.0.0.1:52800/#[redacted]",
            ),
            (
                "pair wss://remote.example/bsk#DEMO_REMOTE",
                "pair wss://remote.example/bsk#[redacted]",
            ),
        ] {
            assert_eq!(text(input), expected, "{input}");
        }
    }

    #[test]
    fn json_masks_nested_credentials_and_sanitizes_dynamic_keys_and_strings() {
        let mut value = json!({
            "headers": [{"name": "Set-Cookie", "value": "k=DEMO_A; other=DEMO_B"}],
            "credentials": [{"opaque": 42}],
            "error": r#"{"nested":[{"X-Goog-Api-Key":"DEMO_C"}],"error":"token='DEMO_D' retry"}"#,
            "token=DEMO_E": "ok",
            "pageToken": "keep"
        });
        json(&mut value);
        assert_eq!(
            value,
            json!({
                "headers": [{"name":"Set-Cookie","value":MASK}],
                "credentials": MASK,
                "error": r#"{"error":"token=[redacted] retry","nested":[{"X-Goog-Api-Key":"[redacted]"}]}"#,
                "token=[redacted]": "ok",
                "pageToken":"keep"
            })
        );
    }

    #[test]
    fn log_keeps_json_records_and_folded_headers_intact_during_redaction() {
        let raw = concat!(
            "Cookie: first=DEMO_A\r\n",
            "  {\"continued\":\"DEMO_B\"}\r\n",
            "ready\n",
            "{\n  \"headers\": [[\"Authorization\", \"DEMO_C\"]],\n  \"ok\": true\n}\n",
            "{\"nested\":{\"pass\\u0077ord\":\"DEMO_D\"}}\n",
            "[1,{\"creden\\u0074ials\":[\"DEMO_F\"]}]\n",
            "[2026-09-24] daemon ready\n",
            "{\"credentials\": [\"DEMO_E\""
        );
        let clean = log(raw);
        assert_eq!(
            clean,
            "Cookie: [redacted]\r\nready\n{\"headers\":[[\"Authorization\",\"[redacted]\"]],\"ok\":true}\n{\"nested\":{\"password\":\"[redacted]\"}}\n[1,{\"credentials\":\"[redacted]\"}]\n[2026-09-24] daemon ready\n[redacted]"
        );
    }
}
