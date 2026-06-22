//! Human-mode stderr summaries for in-band JavaScript dialog payloads.

use bsk_protocol::tools::JavaScriptDialogInfo;
use std::io::{self, Write};

/// Print a one-line summary per dialog to stderr (human mode only).
pub fn print_dialog_summaries(dialogs: &[JavaScriptDialogInfo]) {
    let mut stderr = io::stderr().lock();
    let _ = write_dialog_summaries(&mut stderr, dialogs);
}

pub(crate) fn write_dialog_summaries<W: Write>(
    out: &mut W,
    dialogs: &[JavaScriptDialogInfo],
) -> io::Result<()> {
    for dialog in dialogs {
        writeln!(
            out,
            "dialog: type={} handled={} message={}",
            dialog.dialog_type.as_str(),
            dialog.handled.as_str(),
            dialog.message
        )?;
        if let Some(url) = &dialog.url {
            writeln!(out, "  url={url}")?;
        }
        if let Some(prompt) = &dialog.default_prompt {
            writeln!(out, "  default_prompt={prompt}")?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsk_protocol::tools::{
        JavaScriptDialogHandledAction, JavaScriptDialogInfo, JavaScriptDialogType,
    };

    #[test]
    fn write_dialog_summaries_writes_nothing_for_empty() {
        let mut out = Vec::new();
        write_dialog_summaries(&mut out, &[]).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn write_dialog_summaries_writes_entry() {
        let mut out = Vec::new();
        write_dialog_summaries(
            &mut out,
            &[JavaScriptDialogInfo {
                tab_id: 4,
                dialog_type: JavaScriptDialogType::Alert,
                message: "hello".into(),
                url: Some("https://example.com/".into()),
                default_prompt: None,
                has_browser_handler: Some(false),
                handled: JavaScriptDialogHandledAction::Accepted,
                sequence: 1,
            }],
        )
        .unwrap();
        let rendered = String::from_utf8(out).unwrap();
        assert!(rendered.contains("dialog: type=alert handled=accepted message=hello"));
        assert!(rendered.contains("url=https://example.com/"));
    }
}
