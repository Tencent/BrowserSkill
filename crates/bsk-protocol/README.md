# bsk-protocol

Rust types and JSON Schemas for the browser-skill wire protocol (CLI ↔ daemon ↔ extension).

Generated JSON Schemas live in `schema/`. Guarded action parameter schemas include the
shared `ActionMetadata` fields (`context_id`, `observation_id`, `depends_on`, `expect`).
Rust operation structs describe the operation itself; merge serialized `ActionMetadata`
into the same params object when issuing a guarded request. Do not deserialize the combined
object into an operation struct and reserialize it without preserving its metadata.

`expect` supports up to 16 exact conditions. Selectors search the main document; use observed
refs for iframe/shadow-root targets. `text` compares raw `textContent`, including whitespace.
Target and attribute limits count Unicode code points. Runtime validation additionally checks
field-dependent value types and whether `attribute` is present only for attribute checks.

```bash
cargo run -p bsk-protocol --bin dump-schema --locked
```

## Local RPC admission and cancellation

An updated daemon advertises `rpc_admission: true` in `system.status`. Before a
business RPC, the CLI and MCP client then call `rpc.prepare` with
`{"method":"tool.click"}`. Its result contains an opaque `rpc_id` beginning with
`bsk-rpc/` and `admission_ms: 30000`. Send the actual operation with that wire ID;
use the same ID in `cancel.params.rpc_id`. These are local IPC methods, not new
extension operations. No browser work occurs during preparation.

Each ticket belongs to the issuing daemon, is bound to one method, and may be
admitted only once. The daemon uses its own monotonic clock. The 30-second window
limits admission, not how long an admitted operation may queue or run.
Cancelled tickets reject late operations even after the caller has exited.
Unknown, expired, used and previous-daemon tickets never fall back to ordinary
RPCs. Do not retry an uncertain operation with a fresh ticket without checking
its effects.

Rejected duplicate or missing tickets report `effect_state: unknown`, because
the original operation may already have run. A known ticket cancelled or expired
before admission reports `effect_state: none`. These tickets coordinate execution;
they are not a replacement for local IPC access control.

Cancellation is remembered before execution registries are consulted; a later
registration checks that remembered state before dispatch. Once a request has
been forwarded, the existing request-before-cancel ordering and extension cleanup
apply. A cancellation acknowledgement does not undo already-dispatched effects.
The CLI still waits at most two seconds after observing cancellation, and reports
an uncertain outcome if the original operation cannot settle within that budget.

Admission storage is bounded to 4,096 tickets. Expired non-active tickets are
collected on preparation, completed tickets are removed immediately, and active
tickets survive the admission deadline until completion. A full registry refuses
new preparation instead of evicting live cancellation state. Retention stores
only opaque IDs, method names, deadlines and lifecycle flags, not page content.

Old clients keep their existing behavior. When a daemon omits the capability,
new clients use the previous bounded cancellation-retry path. Once support is
advertised, preparation failure is an error; it never triggers an unprotected
fallback. Durable pre-admission cancellation requires both an updated client and
daemon. An abruptly killed caller that never delivers cancellation cannot be
assumed to have cancelled an already-admitted request.

Normal clients reuse the capability from daemon discovery, adding one local
`rpc.prepare` round trip per operation. An embedding without a discovery snapshot
queries capabilities before preparing. Cancellation and transfer cleanup do not
require new admission tickets.
