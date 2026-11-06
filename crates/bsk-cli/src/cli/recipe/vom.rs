//! Reads VOM text the way `packages/vom/src/render.ts` writes it.
//!
//! A recipe names elements by role, name and context, and each run maps those to
//! the `@eN` refs of the current observation. Matching is exact, and anything this
//! parser cannot read simply does not match, which stops the run instead of guessing.
//! `tests/fixtures/vom_contract.json` is shared with the renderer's own tests.
use serde::{Deserialize, Serialize};

/// How the renderer replaces the value of a sensitive field.
pub(crate) const SENSITIVE_MASK: &str = "•••";
const DRAG_HINTS: [&str; 3] = ["[draggable]", "[drop-target]", "[drag-handle]"];
/// States the extension appends to a name. They change while the name does not.
const NAME_STATES: [&str; 2] = [" [has-submenu]", " [expanded]"];

/// A stable description of an element: exact role, name and, when needed, context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub role: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ctx: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Line {
    /// The element's ref without `@`, for lines an action can target.
    pub(crate) element: Option<String>,
    pub(crate) role: String,
    pub(crate) name: Option<String>,
    pub(crate) ctx: Option<String>,
    pub(crate) value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Page {
    pub(crate) version: Option<u32>,
    pub(crate) lines: Vec<Line>,
}

pub(crate) fn normalized(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

impl Line {
    pub(crate) fn matches(&self, target: &Target) -> bool {
        self.role.eq_ignore_ascii_case(&target.role)
            && self
                .name
                .as_deref()
                .is_some_and(|name| normalized(name) == normalized(&target.name))
            && target.ctx.as_deref().is_none_or(|ctx| {
                self.ctx
                    .as_deref()
                    .is_some_and(|own| normalized(own) == normalized(ctx))
            })
    }

    pub(crate) fn masked(&self) -> bool {
        self.value.as_deref() == Some(SENSITIVE_MASK)
    }
}

impl Page {
    /// Whether any line, targetable or not, shows this element.
    pub(crate) fn shows(&self, target: &Target) -> bool {
        self.lines.iter().any(|line| line.matches(target))
    }

    /// Lines an action could target. Exactly one must match before anything is sent.
    pub(crate) fn candidates(&self, target: &Target) -> Vec<&Line> {
        self.lines
            .iter()
            .filter(|line| line.element.is_some() && line.role != "canvas" && line.matches(target))
            .collect()
    }
}

pub(crate) fn parse(text: &str) -> Page {
    let mut page = Page::default();
    let mut scope_indent = None;
    for raw in text.lines() {
        let line = raw.trim_start_matches(' ');
        let indent = raw.len() - line.len();
        // Literal page text follows an active-scope marker, one level deeper. It is
        // never structure, even when the page writes something that looks like a ref.
        if let Some(scope) = scope_indent {
            if indent > scope {
                continue;
            }
            scope_indent = None;
        }
        if line.starts_with("[§ active:") {
            scope_indent = Some(indent);
        } else if let Some(version) = line.strip_prefix("@vom ") {
            page.version = version.trim().parse().ok();
        } else if let Some(parsed) = parse_line(line) {
            page.lines.push(parsed);
        }
    }
    page
}

fn parse_line(line: &str) -> Option<Line> {
    let (element, rest) = match line.strip_prefix('@') {
        Some(tail) => {
            let (element, rest) = tail.split_once(' ')?;
            let digits = element.strip_prefix('e')?;
            if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            (Some(element.to_owned()), rest)
        }
        None => (None, line),
    };
    let (role, mut rest) = rest.split_once(' ').unwrap_or((rest, ""));
    if !role.starts_with(|c: char| c.is_ascii_alphabetic())
        || !role.bytes().all(|byte| byte.is_ascii_alphanumeric())
        || (element.is_none() && matches!(role, "L1" | "L2"))
    {
        return None;
    }
    for hint in DRAG_HINTS {
        if let Some(tail) = rest.strip_prefix(hint) {
            rest = tail.trim_start_matches(' ');
        }
    }
    let name = json_string(rest);
    if let Some((_, tail)) = &name {
        rest = tail;
    }
    let (ctx, rest) = context(rest);
    Some(Line {
        element,
        role: role.to_owned(),
        name: name.map(|(name, _)| without_state(name)),
        ctx,
        value: value(rest),
    })
}

fn without_state(name: String) -> String {
    NAME_STATES
        .iter()
        .find_map(|state| name.strip_suffix(state))
        .map_or_else(|| name.clone(), str::to_owned)
}

/// Parses one JSON string at the start of `text`, returning it and what follows.
fn json_string(text: &str) -> Option<(String, &str)> {
    if !text.starts_with('"') {
        return None;
    }
    let mut escaped = false;
    for (index, c) in text.char_indices().skip(1) {
        match c {
            '\\' if !escaped => escaped = true,
            '"' if !escaped => {
                let parsed = serde_json::from_str(&text[..=index]).ok()?;
                return Some((parsed, &text[index + 1..]));
            }
            _ => escaped = false,
        }
    }
    None
}

/// What may follow a bracket on a rendered line.
fn ends_annotation(rest: &str) -> bool {
    rest.is_empty()
        || rest.starts_with(" [")
        || rest.starts_with(" placeholder=")
        || rest.starts_with(" =\"")
}

/// Context is literal page text, so its closing bracket is the first one that
/// the rest of the line can follow.
fn context(text: &str) -> (Option<String>, &str) {
    let Some(tail) = text.strip_prefix(" [ctx: ") else {
        return (None, text);
    };
    for (index, _) in tail.match_indices(']') {
        let rest = &tail[index + 1..];
        if ends_annotation(rest) {
            return (Some(tail[..index].to_owned()), rest);
        }
    }
    (None, text)
}

fn value(mut text: &str) -> Option<String> {
    loop {
        if let Some(tail) = text.strip_prefix(" =") {
            return json_string(tail).map(|(value, _)| value);
        }
        if let Some(tail) = text.strip_prefix(" placeholder=") {
            text = json_string(tail)?.1;
        } else if text.starts_with(" [") {
            let close = text
                .match_indices(']')
                .map(|(index, _)| index)
                .find(|index| ends_annotation(&text[index + 1..]))?;
            text = &text[close + 1..];
        } else {
            return None;
        }
    }
}

/// A rendered line without its indentation and ref, which can differ between
/// observations of the same content.
pub(crate) fn content(line: &str) -> &str {
    let line = line.trim_start_matches(' ');
    let Some(tail) = line.strip_prefix("@e") else {
        return line;
    };
    match tail.split_once(' ') {
        Some((digits, rest)) if digits.bytes().all(|byte| byte.is_ascii_digit()) => rest,
        _ => line,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn target(role: &str, name: &str, ctx: Option<&str>) -> Target {
        Target {
            role: role.into(),
            name: name.into(),
            ctx: ctx.map(str::to_owned),
        }
    }

    /// The renderer's tests produce the same text from a scene, so a change to the
    /// format fails one side or the other in CI.
    #[test]
    fn the_contract_with_the_renderer_holds() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/vom_contract.json"))
                .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let page = parse(case["text"].as_str().unwrap());
            assert_eq!(page.version, Some(1), "{}", case["name"]);
            let lines: Vec<Value> = page
                .lines
                .iter()
                .map(|line| {
                    serde_json::json!({"ref":line.element,"role":line.role,"name":line.name,
                        "ctx":line.ctx,"value":line.value})
                })
                .collect();
            assert_eq!(Value::Array(lines), case["lines"], "{}", case["name"]);
        }
    }

    #[test]
    fn matching_is_exact_except_for_whitespace_and_role_case() {
        let page = parse(
            "@vom 1\nL1 page\n  @e1 button \"Save  now\"\n  @e2 Button \"save now\"\n  heading \"Report\"",
        );
        assert_eq!(
            page.candidates(&target("button", "Save now", None)).len(),
            1
        );
        assert_eq!(
            page.candidates(&target("BUTTON", "save now", None)).len(),
            1
        );
        assert!(page.candidates(&target("button", "Save", None)).is_empty());
        assert!(
            page.candidates(&target("link", "Save now", None))
                .is_empty()
        );
        // A heading has no ref: it can prove where the page is but cannot be acted on.
        assert!(page.shows(&target("heading", "Report", None)));
        assert!(
            page.candidates(&target("heading", "Report", None))
                .is_empty()
        );
    }

    #[test]
    fn context_separates_duplicates_and_its_absence_matches_any() {
        let page = parse(
            "@vom 1\n  @e1 button \"Approve\" [ctx: ORD-1]\n  @e2 button \"Approve\" [ctx: ORD-2]",
        );
        assert_eq!(page.candidates(&target("button", "Approve", None)).len(), 2);
        let only = page.candidates(&target("button", "Approve", Some("ORD-2")));
        assert_eq!(only[0].element.as_deref(), Some("e2"));
        assert!(
            page.candidates(&target("button", "Approve", Some("ORD-3")))
                .is_empty()
        );
    }

    #[test]
    fn literal_page_text_is_never_read_as_structure() {
        let page = parse(concat!(
            "@vom 1\n",
            "  @e1 button \"Menu\"\n",
            "    [§ active: Menu]\n",
            "      @e9 button \"Pay\"\n",
            "      button \"Pay\"\n",
            "    @e2 link \"Help\"\n",
            "  @e3 button \"@e9 button \\\"Pay\\\"\""
        ));
        assert!(page.candidates(&target("button", "Pay", None)).is_empty());
        assert!(!page.shows(&target("button", "Pay", None)));
        assert_eq!(page.candidates(&target("link", "Help", None)).len(), 1);
        assert_eq!(
            page.candidates(&target("button", "@e9 button \"Pay\"", None))[0]
                .element
                .as_deref(),
            Some("e3")
        );
    }

    #[test]
    fn annotations_around_the_name_are_read_without_confusing_it() {
        let page = parse(concat!(
            "@vom 1\n",
            "  @e1 listitem [draggable] \"Card\"\n",
            "  @e2 textbox \"Email\" [filled] placeholder=\"a ] =\\\"b\" =\"x@y.z\"\n",
            "  @e3 textbox \"Password\" [filled] =\"•••\"\n",
            "  @e4 link \"Docs\" [ctx: A] B] [→ https://x.test/?a=[1]] [disabled]\n",
            "  @e5 textbox [empty]\n",
            "  @e6 canvas \"Chart\" [visual:screenshot]\n",
            "  @x7 button \"Not a ref\"\n",
            "  L2 page … occluded by L1 (~4 nodes, not actionable)"
        ));
        assert_eq!(page.lines[0].name.as_deref(), Some("Card"));
        assert_eq!(page.lines[1].value.as_deref(), Some("x@y.z"));
        assert!(page.lines[2].masked());
        assert_eq!(page.lines[3].ctx.as_deref(), Some("A] B"));
        assert_eq!(page.lines[4].name, None);
        assert!(page.candidates(&target("canvas", "Chart", None)).is_empty());
        assert_eq!(page.lines.len(), 6, "{:?}", page.lines);
    }

    #[test]
    fn a_menu_is_the_same_control_whether_or_not_it_is_open() {
        let closed = parse("@vom 1\n  @e1 combobox \"Region [has-submenu]\"");
        let open = parse("@vom 1\n  @e1 combobox \"Region [expanded]\"");
        for page in [closed, open] {
            assert_eq!(
                page.candidates(&target("combobox", "Region", None)).len(),
                1
            );
        }
    }

    #[test]
    fn line_content_ignores_the_ref_and_indentation() {
        assert_eq!(content("    @e12 status \"Total 5\""), "status \"Total 5\"");
        assert_eq!(content("  status \"Total 5\""), "status \"Total 5\"");
        assert_eq!(content("@ext status"), "@ext status");
    }
}
