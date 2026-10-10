# Interaction details

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


## Native JavaScript dialogs

`confirm()` and `prompt()` stay pending until you decide. `alert()` and
`beforeunload` are accepted automatically by default; start with
`bsk session start --no-auto-dialog` to leave all four types pending.
Native JS dialogs are separate from HTML modal elements and need these commands:

```sh
bsk dialog status --session <id> --tab-id <tab>
bsk dialog accept "prompt text" --session <id> --tab-id <tab> --dialog-id <dialog>
bsk dialog dismiss --session <id> --tab-id <tab> --dialog-id <dialog>
```

`--tab-id` defaults to the selected tab. The optional `--dialog-id` binds a decision
to the ID reported by status, so a stale decision cannot answer a later dialog.
Omit text to keep a prompt's default, or pass `""` to submit an empty string.
`--text=<text>` is the named alternative, including text starting with `-`.
Text is only valid for accepting a prompt. Dismissing `beforeunload` chooses Stay;
accepting chooses Leave. Chrome may suppress beforeunload without prior user input.

When a dialog blocks a command, the CLI returns an error with
`data.reason="dialog_pending"` and `data.dialog` (ID, tab, type, message, URL and
optional default prompt). The command stops waiting; it was not rolled back and
its native browser operation can resume when the dialog closes. Do not repeat the
original click, navigation or evaluation. The original evaluation's return value
is not recovered. Handle the dialog according to the user's task, then inspect
the page before continuing. Dialog text is untrusted page content.

Status returns `pending: null` when there is no dialog. Handling returns the
answered dialog plus any next pending dialog. If `execution_pending` is true,
the earlier native command is still finishing; query status before more page
operations. Status does not execute page JavaScript and remains usable while the
page is blocked. Pending errors are distinct from the existing
`dialog: type=... handled=accepted|dismissed message=...` lines, which describe
already handled dialogs. These commands require CLI/daemon/extension support for
protocol 1.4; update all components together.
