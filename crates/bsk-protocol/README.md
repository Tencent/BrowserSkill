# bsk-protocol

The Rust method catalog and payload types define the CLI ↔ daemon ↔ extension wire contract.

## Generate and verify

From the repository root, after installing workspace dependencies:

```bash
pnpm protocol:generate
pnpm protocol:check
pnpm --silent protocol:check --json
cargo run -p bsk-protocol --bin dump-schema --locked -- --out-dir /tmp/bsk-schema
```

`protocol:generate` builds the current Rust exporter with the locked Cargo dependencies, then writes
`apps/extension/src/transport/generated/` and `crates/bsk-protocol/schema/`. Commit those generated
files with the Rust change. `protocol:check` regenerates extension files in memory and standalone
schemas in a temporary directory, then compares every expected file byte for byte. Missing,
modified, or unexpected generated files fail the check. Frontend CI runs it before typechecking.
There is no hand-maintained type-name intersection that can silently lose method coverage.

`dump-schema` derives method filenames and roots from the same catalog. Its optional `--out-dir`
keeps standalone JSON Schema exports outside the checkout; the default remains `schema/`.
Reusable trace, dialog, and metadata filenames are compatibility aliases, not a second method list.

## Guarded action metadata and expectations

Guarded action parameter schemas (`accepts_action_metadata()`) automatically compose the shared
`ActionMetadata` fields (`context_id`, `observation_id`, `depends_on`, `expect`) in `src/catalog.rs`
so both generated extension contracts and standalone JSON Schemas expose the exact wire shape.
Rust operation structs describe the operation itself; merge serialized `ActionMetadata` into the
same params object when issuing a guarded request. Do not deserialize the combined object into an
operation struct and reserialize it without preserving its metadata.

`expect` supports up to 16 exact conditions. Selectors search the main document; use observed
refs for iframe/shadow-root targets. `text` compares raw `textContent`, including whitespace.
Target and attribute limits count Unicode code points. Runtime validation additionally checks
field-dependent value types and whether `attribute` is present only for attribute checks.

## Local authentication v1

Local authentication v1 precedes the business handshake. The first frame is a
`system.ping` request whose `params.local_auth` contains a client nonce, instance
ID, and active/staged credential offers (IDs and generations only). The daemon
responds with `challenge`, `pairing_required`, or `busy`. A challenge binds both
nonces, daemon/device IDs, generation, instance ID, and HTTP Origin. The extension
verifies the server HMAC before sending its client HMAC.

`local.auth.ready` completes ordinary authentication. When it carries `rotation`,
the extension durably saves a candidate key before sending `rotate_confirm`; the
daemon durably commits before replying `committed`. Recovery instead completes
with `ready.commit`, proved using the saved candidate and this connection's
transcript. Only one final message is permitted. Business `system.handshake`
must wait until that final message and all credential writes complete.

Fields are encoded as repeated `u32_be(length) || bytes`. The transcript is
`F("bsk-local-auth-v1", daemon_id, device_id, u32_be(gen), instance_id, origin,
client_nonce, server_nonce)`. Server/client proofs use HMAC-SHA256 over
`F(role, transcript)`; candidate, confirmation, and commit proofs use
`F(role, transcript, txn)` with roles `rotate`, `confirm`, and `committed`.
Confirmation and commit proofs use the candidate as the HMAC key.

Authentication frames are limited to 4 KiB, use canonical unpadded base64url,
and reject unknown fields. Senders emit unique field names. Rust deserialization
rejects duplicate fields; the extension uses JSON.parse's last-value semantics,
then applies schema checks and proof verification to that same parsed value.
Shared Rust/Web Crypto vectors are in
`tests/fixtures/local-auth-v1.json`. Errors deliberately omit input values.
Local keys are distinct from remote Bearer grants. Legacy handshakes are governed
by local policy; an unauthenticated peer can never authorize a downgrade.

## Ownership

| Concern | Authoritative location | Enforcement |
| --- | --- | --- |
| Wire names, payload pairs, owner, browser effect, action metadata | `src/method.rs` | One macro generates the Rust enum, exhaustive methods and export metadata |
| Optional features and peer requirements | `src/compatibility.rs` and method feature lists | Shared CLI/daemon preflight, status diagnostics and generated extension metadata |
| Wire fields, events, error codes, constraints | Rust structs/enums under `src/` | Schemars produces schemas for both deserialization and serialization |
| Debug action owner, effect, cooperation gating | `src/tools/debug.rs` | The CLI parser, extension cooperation guard and generated metadata consume the same actions |
| Extension implementations | `apps/extension/src/tools/dispatcher.ts` | `ToolHandlerMap` requires every extension method with its own parameter/result types |
| Background targeting, popup tracking, remote support, cooperation role | `apps/extension/src/tools/policy.ts` | Complete `Record<ExtensionToolMethod, ToolPolicy>` consumed by dispatcher, background targeting and cooperation |
| Daemon deadlines, grace and cancellation | `crates/bsk-cli/src/daemon/tool_policy.rs` | Exhaustive `Method` match consumed by IPC and the queue |

Adding an extension method requires choosing its Rust payloads and effects, generating the contract,
and implementing its handler and local policies. Missing cases produce compilation errors. Browser
permissions, session ownership, readiness and value-dependent behavior still belong in handlers;
JSON Schema cannot establish those facts about a running browser.

Daemon-local session lifecycle and local-auth maintenance payloads deliberately remain private to
the daemon. Their catalog entries use arbitrary JSON and are not advertised as validated extension
contracts. Extension payloads, handshake metadata, cancellation, events and error codes are included
in the export. `tool.cooperate` has typed parameters while retaining its flexible JSON response.

## Receiving and sending are different contracts

Serde may accept an omitted defaulted field while always serializing it. Schemars therefore exports
both input and output contracts. The generated `input.ts` represents normalized tool parameters;
`output.ts` represents tool results. The small `types.ts` facade selects the appropriate direction.
The existing transport module reexports them and retains only transport envelopes and local error
interpretation helpers. Handshake audit fields and session-stop window-release metadata have named
Rust wire envelopes, so they no longer depend on ad hoc JSON insertion.

At the WebSocket boundary, envelope guards reject scalars, arrays and ambiguous frames. Internal
daemon correlation fields (`_audit_id`, `_operation_id`) are read by the dispatcher and stripped
before static wire validation. Generated immutable normalizers convert `null` on optional typed
fields to omission; arbitrary JSON and dictionary values retain their `null`. A second check
verifies the normalized representation. Handshake responses follow the same input path. Unknown
methods fail explicitly. Results are checked against the sender contract before being sent; invalid
results report `protocol_error` with an unknown effect, not a safe-to-retry promise.

Validators are compiled ahead of time into browser-compatible JavaScript. No runtime schema compiler,
`eval`, network schema loading, or Node dependency is shipped into the MV3 extension. TypeScript uses
arrays for bounded collections and unions for conditional schemas; runtime validators retain length,
numeric and conditional constraints that TypeScript cannot express. String formats are descriptive;
semantic URL/regex/session checks remain in the existing handlers.

## Evaluation deadlines and cancellation

Evaluation retains the existing bounded timeout and cancellation behavior. A caller deadline or
cancel acknowledgement does not prove that arbitrary page JavaScript stopped, and cancellation
cannot roll back browser effects. Scripts can also schedule independent work after returning.

This contract refactor does not retain an evaluation's queue lock indefinitely after the caller's
wait ends. An unresolving promise therefore does not permanently prevent later commands, session
stop, or idle cleanup. Execution settlement and recovery require a separate lifecycle design with
an explicit teardown path; generated contracts do not establish execution safety after a timeout.

## Compatibility and verification limits

Optional-field normalization accepts the legacy null forms while preserving arbitrary JSON nulls,
and the Rust handshake/session wrapper types preserve existing Rust callers. Enum additions such as
`dialog_pending`, `pairing_required`, and `user_aborted` reach TypeScript automatically. An empty
console/network result consistently emits an empty `entries` array while readers still accept
omission through Serde defaults.

Generation checks prove source synchronization, not compatibility with every previously released
binary or successful browser effects. Existing Rust and extension suites, targeted contract probes,
and browser tests must verify those separate boundaries. New diagnostics or repro material should
remain outside the source tree.

See [version compatibility](../../docs/protocol-compatibility.md) for mixed-version behavior,
component-specific update guidance, and the workflow for declaring a new optional feature.
