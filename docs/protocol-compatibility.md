# Version compatibility

CLI, MCP server (`bsk mcp`), daemon, Agent Skill, and browser extensions can update at
different times. Their application semvers (`CARGO_PKG_VERSION`, extension manifest
version) do not have to match; runtime compatibility is governed by the wire protocol
version (`PROTOCOL_VERSION = "2.0"`, `MIN_COMPATIBLE_PROTOCOL = "2.0"` in
`crates/bsk-protocol/src/catalog.rs`).

## Handshake and version checks

- **Major-version and floor enforcement**: Both CLI↔daemon discovery (`check_daemon_protocol`
  in `crates/bsk-cli/src/cli/business_rpc.rs` and `ensure_daemon.rs`) and daemon↔extension
  WebSocket registration (`system.register` evaluated via `evaluate_handshake_compat` in
  `crates/bsk-protocol/src/system.rs`) require the peer's `(major, minor)` protocol version to
  share the local major (`2`) and meet `MIN_COMPATIBLE_PROTOCOL` (`2.0`). Peers on protocol
  `1.x`, a newer major, or below either side's floor are rejected before business dispatch.
- **Same-major minor skew**: When a connected extension advertises a different `2.x` minor
  version that still satisfies both peers' `min_compatible_protocol`, the handshake succeeds
  with `HandshakeCompat::Skew`. `system.status` surfaces this in
  `browsers[].version_skew`, `browsers[].extension_protocol_version`, and
  `version_skew_browsers`, which `bsk status` and `bsk doctor` display with upgrade guidance.
- **Rolling-upgrade local IPC framing (`ipc_envelope`)**: Within protocol `2.0`, upgraded
  daemons advertise `ipc_envelope: true` in `daemon.json` (`DaemonInfo`) and `system.status`
  (`StatusResult`). Updated CLI and `bsk mcp` processes send out-of-band `IpcEnvelope`
  metadata (`meta` header carrying caller scope, `bind_scope`, and `return_scope_meta`) to
  envelope-capable daemons while transparently falling back to legacy `"2.0"` in-band `_`-prefixed
  scope fields when talking to an older `"2.0"` daemon before restart. Upgraded daemons accept
  both framings simultaneously (`crates/bsk-cli/src/ipc_client.rs`, `crates/bsk-cli/src/daemon/ipc.rs`).

Run `bsk status --json` to inspect `daemon_version`, `protocol_version`, `ipc_envelope`,
`browsers[].extension_protocol_version`, and `version_skew_browsers`. Run `bsk doctor` for
actionable diagnostics.

If the daemon is on an incompatible protocol version, update `bsk` and restart the daemon
after active tasks finish (host-managed foreground daemons must be restarted by their host).
If an extension profile is on an older major protocol, update or reload that browser profile's
extension and wait for reconnection. Each connected browser profile is checked independently.

The Agent Skill (`crates/bsk-cli/skill/`) supplies workflow instructions rather than runtime
capability; reload the skill or start a new conversation after updating `bsk`.

## Where maintainers change the contract

`crates/bsk-protocol` is the single source of truth (SSOT) for wire methods, dispatch
policies, and schemas:

1. **Declare method metadata in `crates/bsk-protocol/src/method.rs`**: Every `Method` variant
   defines a single `MethodSpec` entry specifying `owner` (`Daemon`, `Extension`, or `Shared`),
   `queue_mode` (`Serial`, `Unlocked`, `CooperateDynamic`, or `VideoDynamic`), `deadline`
   (`Standard`, `FullPage`, or `BorrowConfirmation`), `cancel_at_deadline`, `outcome`
   (`Ordinary`, `EffectAwareAction`, or `FileTransfer`), `wal_tracking`, `action_metadata`
   (`None`, `ContextOnly`, or `Full`), and `recipe_step`.
2. **Keep additive changes backward-compatible within a major**: Add optional fields with
   `#[serde(default, skip_serializing_if = ...)]` when preserving compatibility within `2.x`.
   Bump `PROTOCOL_VERSION` (and `MIN_COMPATIBLE_PROTOCOL` when breaking wire invariants) in
   `crates/bsk-protocol/src/catalog.rs` when introducing new protocol revisions.
3. **Regenerate and verify artifacts**: Run `pnpm protocol:generate`, then `pnpm protocol:check`.
   `crates/bsk-protocol/src/catalog.rs` exports both the checked-in JSON Schemas under
   `crates/bsk-protocol/schema/` and the TypeScript wire contracts under
   `apps/extension/src/transport/generated/`. Never hand-edit generated files.
