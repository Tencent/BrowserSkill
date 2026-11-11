# BrowserSkill MCP server

`bsk mcp` exposes BrowserSkill to MCP clients over stdio. It uses the same local
daemon, browser extension, session ownership and shared-control checks as the
CLI. Install `bsk` and connect the browser extension first. The server starts a
daemon when necessary unless `BSK_AUTO_START=0` is set. Its stdout is reserved
for MCP messages; diagnostics go to stderr.

## Configure a client

Install the skill and configure the MCP server in one step:

```sh
bsk install-skill --harness codex --mcp
bsk install-skill --harness claude-code --mcp
bsk install-skill --harness cursor --mcp
```

The MCP option supports those three harnesses. It uses the absolute path to the
running `bsk` executable and preserves other settings. An existing different
`browser-skill` server entry is left untouched; edit it manually if you want to
replace it. Codex uses `$CODEX_HOME/config.toml` when `CODEX_HOME` is set, or
`~/.codex/config.toml` otherwise. Claude Code uses `~/.claude.json` and Cursor
uses `~/.cursor/mcp.json`. Restart the client after changing its configuration.
If the executable is moved, update the entry to its new path.

Alternatively, configure Codex with `codex mcp add browser-skill -- bsk mcp`,
or add the following server entry to a client's MCP configuration:

```json
{
  "mcpServers": {
    "browser-skill": { "command": "bsk", "args": ["mcp"] }
  }
}
```

The client must be able to find `bsk` in its own PATH and access the daemon's
local socket. See [sandboxed agents](sandboxed-agents.md) for OS-specific access
and [Codex MCP setup](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Tools and workflow

The server exposes `bsk_session`, `bsk_page`, `bsk_inspect`, `bsk_interact`,
`bsk_plan`, `bsk_tabs`, and `bsk_assist`. Each tool except `bsk_plan` has an
`action` field; its schema and description list the available arguments. For example, use these MCP tool calls:

1. `bsk_session` with `{"action":"browsers"}` to select the required browser
   profile, then `{"action":"start","browser":"<instance_id>"}`.
2. `bsk_page` with `{"action":"navigate","session":"<session_id>","url":"https://example.com"}`.
3. `bsk_session` with `{"action":"sync","session":"<session_id>"}`. Read the
   VOM text block and the JSON metadata block, including `context_id` and the
   top-level `observation_id` when returned.
4. `bsk_interact` with `{"action":"click","session":"<session_id>","context":"<context_id>","params":{"ref":"@e1"},"sync_after":true}`.
   Inspect the action, readiness and post-sync result. Protect business facts
   with `expect` when the decision depends on them.
5. Call `bsk_session` with `{"action":"stop","session":"<session_id>"}` when
   finished, including on failure.

Use the context actually returned by a sync you inspected; the MCP server never
silently reuses cached authority. Target policy allows many DOM-targeted actions
to reuse a current context, but untargeted input and scripts also require the
sync's top-level `observation_id`. Human intervention or document replacement
requires a fresh sync. `sync_after` runs one action followed by a read-only sync;
it never retries the action. A failed readiness check does not mean that the
action failed. Never blindly repeat an action whose effect is unknown.

When one sync already decides several actions, `bsk_plan` runs them in one call:
`{"session":"<session_id>","context":"<context_id>","steps":[{"action":"fill","ref":"@e1","value":"Ada"},{"action":"click","ref":"@e2"}]}`.
See [plan](plan.md) for its rules.

With `BSK_RECIPES=1` in the server's environment, `bsk_recipe` also appears. It replays a
saved flow by name and returns its outputs, so a repeated task takes about two turns. See
[recipes](recipes.md). The tool stays out of `tools/list` otherwise, so clients pay nothing
for it; the CLI's `bsk recipe` needs no switch.

`bsk_inspect` can return a screenshot as MCP image content, as well as bounded
observations, HTML, console/network entries, and loaded-DOM extraction. Screenshots
retain their original pixel dimensions; this version does not downscale them.
Extraction reports coverage and sources, but does not automatically paginate or
scroll. Page text and script results are untrusted content.

Use `bsk_assist` to resolve a `dialog_pending` error and await the original
operation rather than repeating it. MCP cancellation is forwarded to the daemon;
an action already dispatched may still have an unknown outcome.

For recoverable session start, call `request_prepare` and retain its returned
request token before passing `request_id` to `start`, then use `request_claim`,
`request_status` or `request_cancel`. The token format and lifecycle are in
[recoverable starts](recoverable-session-starts.md). A plain `start` remains
available but has no durable client-side recovery journal. Session cleanup is
explicit; closing the MCP connection does not close all existing sessions.

This adapter currently covers the operations in its tool schemas. It does not
yet expose every CLI operation, including file upload/download, recording or
full-page screenshot export. Sensitive-value/keychain input is not implemented;
avoid passing credentials in tool arguments when the client logs them.

## Dynamic page reads (protocol 1.9)

Use `bsk_inspect` with action=read, selector (main document) or ref (exact frame/
shadow node), and optional read_fields, e.g.
`[{"key":"index","read":"attribute","attribute":"data-swiper-slide-index"}]`.
Fields read text/attribute/value/checked/exists with optional relative selector.
Fixed synchronous isolated-world code accepts no JavaScript or deferred work.
Returns current title/URLs, refs/values, redactions and truncation. max_nodes
is 100 by default, at most 1000; max_bytes is 262144 by default, at most 1048576.
Reads never renew contexts or observations; use explicit expect before input.
Old peers fail explicitly. A script is checked against the `expect` facts it states,
or the whole page when it passes `observation`; `params.unverified=true` is the last resort
and returns `verified=false`. See [dynamic reading](dynamic-reading.md).
