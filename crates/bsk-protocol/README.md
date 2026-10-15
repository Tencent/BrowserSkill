# bsk-protocol

Rust types and JSON Schemas for the browser-skill wire protocol (CLI ↔ daemon ↔ extension).

Generated JSON Schemas live in `schema/`.

```bash
cargo run -p bsk-protocol --bin dump-schema --locked
```


## JavaScript dialogs (protocol 1.4)

`tool.dialog` takes `session_id`, optional `tab_id`, and an `action` of `status`,
`accept`, or `dismiss`. Accept optionally takes `prompt_text`; omitted and empty
text are distinct. Decisions optionally take `dialog_id` to reject stale state.
The result includes `tab_id`, nullable `pending`, `execution_pending`, and an
optional `handled` history entry. See the generated `tool_dialog_*.json` schemas.

`tool.session_start.no_auto_dialog` disables automatic alert/beforeunload
acceptance. Confirm/prompt always wait for a decision. A blocked tool returns
`cdp_failed` with `data.reason=dialog_pending` and `data.dialog`; the underlying
native command may resume after the dialog closes, so callers must not replay it.
`dialog_execution_pending` fences page operations while that native call finishes.
Dialog status/decisions bypass the daemon's session busy lock, but decisions still
respect user interruption and all actions enforce session/tab ownership.
