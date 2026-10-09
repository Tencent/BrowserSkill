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
Reusable trace and documentation filenames are compatibility aliases, not a second method list.

## Ownership

| Concern | Authoritative location | Enforcement |
| --- | --- | --- |
| Wire names, payload pairs, owner, browser effect | `src/method.rs` | One macro generates the Rust enum, exhaustive methods and export metadata |
| Wire fields and constraints | Rust structs/enums under `src/tools/` and `src/system.rs` | Schemars produces schemas for both deserialization and serialization |
| Debug action owner and effect | `src/tools/debug.rs` | The CLI parser and generated extension metadata consume the same actions |
| Extension implementations | `apps/extension/src/tools/dispatcher.ts` | `ToolHandlerMap` requires every extension method with its own parameter/result types |
| Background targeting, popup tracking, remote support | `apps/extension/src/tools/policy.ts` | Complete `Record<ExtensionToolMethod, ToolPolicy>`; shared effects come from generated metadata |
| Daemon deadlines, grace and cancellation | `crates/bsk-cli/src/daemon/tool_policy.rs` | Exhaustive `Method` match consumed by IPC and the queue |

Adding an extension method requires choosing its Rust payloads and effects, generating the contract,
and implementing its handler and local policies. Missing cases produce compilation errors. Browser
permissions, session ownership, readiness and value-dependent behavior still belong in handlers;
JSON Schema cannot establish those facts about a running browser.

Daemon-local session lifecycle payloads deliberately remain private to the daemon. Their catalog
entries use arbitrary JSON and are not advertised as validated extension contracts. Extension
payloads, handshake metadata, cancellation and error codes are included in the export.

## Receiving and sending are different contracts

Serde may accept an omitted defaulted field while always serializing it. Schemars therefore exports
both input and output contracts. The generated `input.ts` represents normalized tool parameters;
`output.ts` represents tool results. The small `types.ts` facade selects the appropriate direction.
The existing transport module reexports them and retains only transport envelopes and local error
interpretation helpers. Handshake audit fields and session-stop window-release metadata have named
Rust wire envelopes, so they no longer depend on ad hoc JSON insertion.

At the WebSocket boundary, envelope guards reject scalars, arrays and ambiguous frames. Before
dispatch, a static validator checks the raw payload. Generated immutable normalizers convert `null`
on optional typed fields to omission; arbitrary JSON and dictionary values retain their `null`.
A second check verifies the normalized representation. Handshake responses follow the same input
path. Unknown methods fail explicitly. Results are checked against the sender contract before being
sent; invalid results report `protocol_error` with an unknown effect, not a safe-to-retry promise.

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

The wire protocol version remains unchanged. Optional-field normalization accepts the legacy null
forms while preserving arbitrary JSON nulls, and the Rust handshake/session wrapper types preserve
existing Rust callers. Enum additions such as `user_aborted` now reach TypeScript automatically.
An empty console/network result consistently emits an empty `entries` array while readers still
accept omission through Serde defaults.

Generation checks prove source synchronization, not compatibility with every previously released
binary or successful browser effects. Existing Rust and extension suites, targeted contract probes,
and browser tests must verify those separate boundaries. New diagnostics or repro material should
remain outside the source tree.
