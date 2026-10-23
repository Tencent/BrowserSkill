# Version compatibility

CLI, daemon, Agent Skill and browser extensions can update at different times.
Their application versions do not have to match. The connection handshake checks
the base protocol, while optional features check the version of each component
that must understand them.

## What users see

- Ordinary requests keep their existing defaults. For example, omitting
  `--incognito` does not require incognito support, and omitting the borrow
  confirmation timeout keeps the older behavior.
- An explicitly requested feature is checked before dispatch. The CLI checks the
  running daemon over the same connection used for the action. The daemon checks
  the actual target browser connection before sending it a request.
- Unsupported features return `unsupported` with `data.reason =
  "unsupported_feature"`, `component`, `required_protocol`, `actual_protocol`,
  `feature`, `effect_state: "none"` and `recovery`. They are never silently dropped
  or converted into an operation with different behavior.

Run `bsk status --json` to see `compatibility.daemon` and
`compatibility.browsers[].features`. Each feature reports `available` and its
`blocked_by` components. Existing status fields and the daemon's status wire
format are unchanged. `bsk doctor` gives a readable explanation. Availability is
a version check, not a guarantee of permissions, settings or a live session.

If the daemon is too old, update bsk and restart that daemon after active tasks
finish. A host-managed foreground daemon must be restarted by its host. If an
extension is too old, update that browser profile and wait for reconnection.
Updating the CLI cannot update an extension awaiting store approval or rollout;
supported features remain usable in the meantime. Each connected profile is
checked separately, and reconnection replaces its reported version.

The Agent Skill supplies instructions, not runtime capability. Reload it or start
a new conversation after a skill update. Even a stale conversation receives the
same structured runtime rejection. Do not remove an explicitly requested option
just to make an unsupported operation run.

## Where maintainers change the contract

1. Define a feature and its daemon/extension protocol requirements in
   `crates/bsk-protocol/src/compatibility.rs`. Bump the protocol when adding a new
   requirement; keep old defaults for omitted optional parameters.
2. Attach the feature to every relevant CLI/daemon/extension method in
   `crates/bsk-protocol/src/method.rs`. Every method explicitly declares its
   feature list, including `[]` for base operations. Include any daemon method
   that translates into an extension request.
3. Run `pnpm protocol:generate`, then `pnpm protocol:check`. The same catalog
   generates extension contracts, feature metadata and the checked-in schemas.
   Popup guidance reads these generated requirements too.

The initial feature table covers incognito sessions (1.4), explicit borrow
confirmation timeouts (1.2), and request-help interaction policy (daemon 1.3;
existing extension support starts at 1.0). It does not
claim to reconstruct introduction versions for every historical method.

Base compatibility also does not remove a feature's workflow requirements. In
particular, shared-browser cooperation requires `cooperate sync` and a fresh
context before page mutations. An older CLI without that command can still
start a session, navigate its initial page and read it, but must be updated for
the new mutation workflow. This feature table does not certify that older
clients support every workflow in a newer extension.

Generated-file checks prove consistency within this checkout. Before release,
also exercise the new CLI with older daemons/extensions and an older CLI with the
new daemon/extension: ordinary operations must still work, requested unsupported
features must fail before browser effects, and the error must name the right
component. Keep the new extension compatible with existing daemon requests while
its store release is pending; enable new operations only when the target peers
meet their declared requirements.
