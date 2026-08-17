---

## DSH routing reminder

The CLI-oriented reference above describes behavior, not the execution mechanism in
DeepSeek Harness. For every browser operation, call the injected `browser_*` model
tool. Do not translate these examples into `bash` commands and do not execute `bsk`
directly; the plugin invokes `bsk` internally. In particular, always begin with
`browser_session_start`, pass its returned session id to subsequent `browser_*`
tools, and finish with `browser_session_stop`.
