//! Sanitize JSON and free text at the ZIP boundary.

use std::{collections::HashMap, sync::LazyLock};

use regex::Regex;
use serde_json::Value;

const MASK: &str = "[redacted]";

// A credential header includes all of its parameters and folded lines. In
// free text, other credential fields can be followed by diagnostic context.
static HEADER_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?ix)^(?:(?<full>(?:proxy[-_]?)?authorization|(?:set[-_]?)?cookie)|",
        r"api[-_]?key|private[-_]token|x[-_](?:api[-_]key|(?:auth|access|csrf|xsrf|vault)[-_]token|csrftoken)|",
        r"x[-_](?:goog[-_]api[-_]key|amz[-_]security[-_]token|shopify[-_]access[-_]token|hasura[-_]admin[-_]secret)|ocp[-_]apim[-_]subscription[-_]key)$"
    )).unwrap()
});
static CAMEL_BOUNDARY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([a-z0-9])([A-Z])").unwrap());
static SECRET_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?ix)(?:^|[-_])(?:",
        r"(?:(?:new|old|current|confirm|db)[-_]?)?(?:password|passwd|pwd)(?:confirmation)?(?:[-_]|$)|",
        r"(?:(?:client[-_]?)?secret|credentials?|(?:(?:access|refresh|next|id|auth|csrf|xsrf)[-_]?)?token|api[-_]?key|session[-_]?(?:id|key))$)"
    )).unwrap()
});
// next_token is a BrowserSkill remote credential. Only explicit page cursor
// names from the extension's redaction policy are exempt.
static PAGE_CURSOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:(?:next|x)[-_]?)?page[-_]?token$").unwrap());

#[derive(Clone, Copy, PartialEq, Eq)]
enum Field {
    Header,
    Credential,
    Session,
}

fn field(name: &str, colon: bool) -> Option<Field> {
    if ["session", "session_id", "sessionId", "session-id"]
        .iter()
        .any(|s| name.eq_ignore_ascii_case(s))
    {
        return Some(Field::Session);
    }
    for part in name.split(['.', '[', ']']) {
        if let Some(header) = HEADER_NAME.captures(part) {
            return Some(if colon || header.name("full").is_some() {
                Field::Header
            } else {
                Field::Credential
            });
        }
        let normalized = CAMEL_BOUNDARY.replace_all(part, "${1}_${2}");
        if !PAGE_CURSOR.is_match(&normalized) && SECRET_NAME.is_match(&normalized) {
            return Some(Field::Credential);
        }
    }
    None
}

// Tokenize the complete ASCII key before classifying it. This works for
// environment prefixes and for headers that follow non-Latin prose.
static TEXT_ITEM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?P<key>[a-zA-Z0-9_][a-zA-Z0-9_.-]*(?:\[[a-zA-Z0-9_.-]+\])*)(?:\\?["'])?[ \t]*(?<separator>[:=])[ \t]*|[\[{]"#).unwrap()
});
static AUTH_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:Bearer|Basic)[ \t]+").unwrap());
static AUTH_SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?-u:\b)(Bearer|Basic)[ \t]+[a-z0-9._~+/=-]+").unwrap());
static URL_USERINFO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)([a-z][a-z0-9+.-]*://)[^/?#@\s"'<>]+@"#).unwrap());
static PAIRING_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)(?-u:\b)(wss?://[^#\s"'<>]*)#[^\s"'<>]+"#).unwrap());

/// Aliases are allocated afresh for each bundle. Never persist the lookup.
#[derive(Default)]
pub(super) struct Redactor {
    sessions: HashMap<String, usize>,
}

impl Redactor {
    fn session(&mut self, id: &str) -> String {
        if id.is_empty() {
            return String::new();
        }
        let next = self.sessions.len() + 1;
        format!("session-{}", self.sessions.entry(id.into()).or_insert(next))
    }

    pub(super) fn json(&mut self, value: &mut Value) {
        match value {
            Value::Object(fields) => {
                let credential_header = fields.iter().any(|(key, value)| {
                    (key.eq_ignore_ascii_case("name") || key.eq_ignore_ascii_case("key"))
                        && value
                            .as_str()
                            .is_some_and(|name| field(name, true).is_some())
                });
                for (key, mut child) in std::mem::take(fields) {
                    match (field(&key, false), &mut child) {
                        (Some(Field::Session), Value::String(id)) => *id = self.session(id),
                        (Some(Field::Session), Value::Null) => {}
                        (Some(_), child) => *child = Value::String(MASK.into()),
                        (None, child) if credential_header && key.eq_ignore_ascii_case("value") => {
                            *child = Value::String(MASK.into())
                        }
                        (None, child) => self.json(child),
                    }
                    fields.insert(self.text(&key), child);
                }
            }
            Value::Array(items) => {
                // Header lists may contain pairs or a flat sequence of names and values.
                for [name, value] in items.as_chunks_mut::<2>().0 {
                    if name
                        .as_str()
                        .is_some_and(|name| field(name, true).is_some())
                    {
                        *value = Value::String(MASK.into());
                    }
                }
                items.iter_mut().for_each(|child| self.json(child));
            }
            Value::String(s) => *s = self.text(s),
            _ => {}
        }
    }

    /// An embedded JSON value and an assignment each own their complete
    /// value. In particular, JSON in a folded Cookie header is never copied
    /// independently, and a header object inside a log message stays structured.
    pub(super) fn text(&mut self, mut input: &str) -> String {
        let mut output = String::new();
        let mut plain = String::new();
        while let Some(item) = TEXT_ITEM.captures(input) {
            let matched = item.get(0).unwrap();
            plain.push_str(&input[..matched.start()]);
            let rest = &input[matched.end()..];
            if let Some(key) = item.name("key") {
                plain.push_str(matched.as_str());
                input = rest;
                if let Some(kind) = field(key.as_str(), &item["separator"] == ":") {
                    let end = if kind == Field::Header {
                        header_len(rest)
                    } else {
                        value_len(rest)
                    };
                    if kind == Field::Session {
                        plain.push_str(&self.session(rest[..end].trim_matches(['"', '\''])));
                    } else {
                        plain.push_str(MASK);
                    }
                    input = &rest[end..];
                }
                continue;
            }
            let candidate = &input[matched.start()..];
            if !looks_like_json(candidate) {
                plain.push_str(matched.as_str());
                input = rest;
                continue;
            }
            flush_plain(&mut plain, &mut output);
            let mut stream = serde_json::Deserializer::from_str(candidate).into_iter::<Value>();
            match stream.next() {
                Some(Ok(mut value)) => {
                    self.json(&mut value);
                    output.push_str(&value.to_string());
                    input = &candidate[stream.byte_offset()..];
                }
                Some(Err(err)) => {
                    output.push_str(MASK);
                    input = if err.is_eof() {
                        ""
                    } else {
                        &candidate[header_len(candidate)..]
                    };
                }
                None => break,
            }
        }
        plain.push_str(input);
        flush_plain(&mut plain, &mut output);
        output
    }
}

fn looks_like_json(input: &str) -> bool {
    let body = input[1..].trim_start();
    if input.starts_with('{') {
        return body.is_empty() || body.starts_with(['"', '}']);
    }
    if body.is_empty() || body.starts_with(['{', '[', '"', ']']) {
        return true;
    }
    // Let [INFO] and [2026-09-24] through as ordinary log prefixes.
    let end = body
        .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '+' | '.')))
        .unwrap_or(body.len());
    let item = &body[..end];
    body[end..].trim_start().starts_with([',', ']'])
        && (matches!(item, "true" | "false" | "null") || item.parse::<serde_json::Number>().is_ok())
}

fn flush_plain(plain: &mut String, output: &mut String) {
    if plain.is_empty() {
        return;
    }
    let clean = AUTH_SCHEME.replace_all(plain, "$1 [redacted]");
    let clean = URL_USERINFO.replace_all(&clean, "${1}[redacted]@");
    output.push_str(&PAIRING_LINK.replace_all(&clean, "${1}#[redacted]"));
    plain.clear();
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
    // A credential assignment can include both an authentication scheme and
    // its token. Consume them together before looking for the next field.
    let prefix = AUTH_PREFIX.find(value).map_or(0, |m| m.end());
    let body = &value[prefix..];
    let mut chars = body.char_indices();
    let len = match chars.next() {
        Some((_, quote @ ('"' | '\''))) => {
            while let Some((offset, ch)) = chars.next() {
                if ch == '\\' {
                    chars.next();
                } else if ch == quote {
                    return prefix + offset + ch.len_utf8();
                }
            }
            body.len()
        }
        Some((_, '{' | '[')) => {
            let mut stream =
                serde_json::Deserializer::from_str(body).into_iter::<serde::de::IgnoredAny>();
            match stream.next() {
                Some(Ok(_)) => stream.byte_offset(),
                _ => body.len(),
            }
        }
        Some((_, '\\')) => header_len(body),
        _ => body
            .find(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | '&' | '}' | ']'))
            .unwrap_or(body.len()),
    };
    prefix + len
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
                "refresh token: expired; retrying in 5s",
                "refresh token: [redacted]; retrying in 5s",
            ),
            ("[0] browser connected", "[0] browser connected"),
            (
                "user[0][newPassword]=DEMO_PW&nextPageToken=2",
                "user[0][newPassword]=[redacted]&nextPageToken=2",
            ),
            (
                "token={\n\"key\": \"DEMO_TOKEN\"\n}\nstatus=healthy",
                "token=[redacted]\nstatus=healthy",
            ),
            (
                r#"headers: {"name":"Cookie","value":"DEMO"#,
                "headers: [redacted]",
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
            assert_eq!(Redactor::default().text(input), expected, "{input}");
        }
    }

    #[test]
    fn json_masks_nested_credentials_and_sanitizes_dynamic_keys_and_strings() {
        let mut value = json!({
            "headers": [{"name": "Set-Cookie", "value": "k=DEMO_A; other=DEMO_B"}],
            "rawHeaders": ["Accept", "text/plain", "Cookie", "k=DEMO_COOKIE"],
            "credentials": [{"opaque": 42}],
            "error": r#"{"nested":[{"X-Goog-Api-Key":"DEMO_C"}],"error":"token='DEMO_D' retry"}"#,
            "token=DEMO_E": "ok",
            "pageToken": "keep"
        });
        Redactor::default().json(&mut value);
        assert_eq!(
            value,
            json!({
                "headers": [{"name":"Set-Cookie","value":MASK}],
                "rawHeaders": ["Accept", "text/plain", "Cookie", MASK],
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
        let clean = Redactor::default().text(raw);
        assert_eq!(
            clean,
            "Cookie: [redacted]\r\nready\n{\"headers\":[[\"Authorization\",\"[redacted]\"]],\"ok\":true}\n{\"nested\":{\"password\":\"[redacted]\"}}\n[1,{\"credentials\":\"[redacted]\"}]\n[2026-09-24] daemon ready\n[redacted]"
        );
    }
}
