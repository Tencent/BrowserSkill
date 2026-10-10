# Interaction details

## Known actions in one call

When all targets and values are known from the current observation, combine
single commands with `&&` in one shell tool call. Each command keeps its normal
validation, cancellation and audit trail; the first failure stops the chain.
Use the actual session, observed tab ID and refs (these are only examples):

```sh
bsk fill @e1 --session "$BSK_SESSION" --tab-id "$BSK_TAB" --value "Acme" &&
bsk fill @e2 --session "$BSK_SESSION" --tab-id "$BSK_TAB" --value "Example contact" &&
bsk select @e3 --session "$BSK_SESSION" --tab-id "$BSK_TAB" --value "software" &&
bsk click @e4 --session "$BSK_SESSION" --tab-id "$BSK_TAB" &&
bsk observe --session "$BSK_SESSION" --tab-id "$BSK_TAB" --json
```

Quote shell arguments correctly. No plan file or operation history is required.
End the chain at a navigation, a new decision, or anything that needs another
observation. Never parallelize commands against the same session. `observe`
is an immediate read, not a readiness wait: if submission is still loading,
observe again or use the existing wait tools for the expected transition.

On failure, keep completed work, observe the page and continue with individual
commands. A timeout or lost connection may have had an effect; do not replay
completed or uncertain operations. After user cancellation, stop until resumed.
There is no rollback, deduplication or whole-chain transaction.


- Hover markers such as `[hover first: Shoes | Bags]`, `[has-submenu]`, or
  `[expanded]` identify triggers. Hover the trigger, observe, then use the revealed
  item's ref. Listed labels are not refs; do not click the trigger unless its own
  action is wanted. If an expected control is missing and no marker identifies a
  trigger, try `observe --probe-hover` once. It touches the live page and costs
  seconds; use targeted hover once the trigger is known.
- `scroll-to` returns ancestor-clipped bounds in top-level viewport CSS pixels.
  Partial visibility suffices; hidden/fully clipped targets fail. It does not test
  occlusion. `wheel` sends signed deltas (at least one nonzero), not a guaranteed
  scroll distance. An optional target is scrolled into view first; without one,
  input lands at the viewport centre. Observe to check the page's response.

## Element waits

`wait-for-element` polls one selector/ref inside the extension. `hidden` means
absent or not visible; `detached` requires absence. Both include initial absence.
`visible` does not imply enabled, unobstructed or application-ready. Choose an
actual post-action readiness signal; an absent or hidden mask may not have started
loading yet. Selectors check only the first match in the main document: scope a
mask selector to its component, for example `#orders-panel .el-loading-mask`.
Use fresh refs for frame/shadow-root targets. Unknown/invalidated/cross-tab refs
and CDP failures remain errors for every state. Full-document navigation invalidates
old refs: use `wait-for-navigation`, then `observe`. A removed out-of-process iframe
can invalidate its CDP session; to wait for the frame's removal, target the parent
document's `<iframe>` element rather than a ref inside it.

Timeout returns `satisfied: false`, still with CLI exit code 0. Never rely on `&&`
alone. `attached`/`visible` reflect the last completed probe, or `null` when there
was no completed probe. Waiting does not create fresh refs.

In an existing session, after observing and identifying the trigger and readiness
selector, this Bash example triggers, waits, checks the result, then observes:

```bash
# Replace the session and selectors with values from the task's page.
session=abcd
bsk click '#run-search' --session "$session" || exit 1
result=$(bsk wait-for-element '#search-results' --state visible \
  --timeout 20s --session "$session" --json) || exit 1
if ! jq -e '.satisfied == true' <<<"$result" >/dev/null; then
  printf 'Results not ready: %s\n' "$result" >&2
  exit 1
fi
bsk observe --session "$session"
```

Use `--state hidden` for an already visible loading mask, whether it will be hidden
in place (`v-loading`) or removed (`Loading.service`). Use `detached` when actual
removal is required. Observe after success before using new refs. End the session
on success and error as required by the task workflow. This API reduces caller
round trips and standardizes state checks; it promises neither lower latency nor
an escape from browser background throttling.

### Large observations

There is no default token cap. With `observe --max-tokens <n>`, follow a returned
`next_cursor`/`@more` when relevant content remains:

```sh
bsk observe --cursor <token> --session <id>
```

Each page replaces the ref map: use its refs before continuing and never reuse
refs from earlier pages. Continuation reads the same capture, without refreshing
or hovering; do not combine it with depth changes or hover probing. New observe/
snapshot or changed page identity invalidates continuation; then observe afresh.

## Diagnostics and other tools

Use `console` / `network` for bounded read-only diagnostics; follow returned
sequence cursors. `emulate --device iphone-14` affects one tab; `--off` restores it.
`evaluate` is a last resort: inspect JSON `.ok`, since a script exception can have
CLI exit code 0. Never evaluate secrets. `record start` captures user actions;
read its help first and never record banking, SSO or password-manager pages.
Use `bsk --help` to find navigation/history, tab, wait and window commands.
