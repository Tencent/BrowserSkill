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

### Dragging

Use `bsk drag <source-ref-or-selector> --to <target-ref-or-selector> --session <id>`,
or replace `--to` with `--dx <pixels> --dy <pixels>` for sliders, resize handles,
and panning. Prefer refs from the latest VOM observation. Selectors must match
exactly one element in the main document; frame/shadow targets require refs.

`--hold 500ms` waits after pressing, before moving; `--duration 800ms` controls
travel pacing. Both are bounded at 5s each. `--button` and `--modifiers` work as
for click. `--from-offset-x/y` and `--to-offset-x/y` adjust the endpoints from
their visible action points in top-level viewport CSS pixels. Offsets inside
out-of-process frames are unsupported. Use the actual thumb/handle when present.

Observation JSON includes `observation_id`; supplying `--observation-id <id>`
rejects a superseded ref map before input. New observe/snapshot/continuation
replaces refs. Keep the matching token and refs together; the token does not
replace `--context` when shared-control coordination requires it.

Both endpoints must be visible after preparation. Drag does not auto-scroll
while held, cross tabs, or synthesize touch gestures. Canvas screenshot-bound
visual refs are not DOM targets; canvas selectors can receive mouse drags.
VOM `[draggable]`, `[drag-handle]` and `[drop-target]` are evidence-based hints,
not promises that an application will accept a gesture. Some custom targets
have no detectable hint and need a known selector.

Success means the input sequence was delivered, not that a drop was accepted.
Observe afterwards and verify the value, order or destination. Cancellation
releases owned input at its last position; it cannot roll back page handlers.
After `effect_state=unknown`, observe before deciding whether to retry.

### Click–move–click selection

Some calendars and range grids select by clicking and releasing the start,
then moving **with no button held**, then clicking the end. A held drag is a
separate interaction; it can deliver input successfully without selecting cells.
Use page instructions, observed behavior or known handlers to identify the mode.
Do not automatically retry a failed held drag as two clicks.

For a known click–move–click control with both endpoints identified, use one
bounded action (daemon and extension protocol 1.7 or newer):

```sh
bsk drag @e3 --to @e8 --mode click-move-click --session <id> --context ID
bsk cooperate sync --session <id>
```

This clicks/releases the start, moves with `buttons=0`, rechecks the destination,
and clicks/releases the end. `--duration` controls movement (default 500ms).
It requires `--to` and zero `--hold`; `--mode press-move-release` is the default
held drag. Both clicks share one context and operation; interruption stops the
remaining sequence. The first click may remain applied after an error. Sync and
inspect before another action; never assume rollback or start the gesture again
from an already active selection.

When learning an unfamiliar grid, use `click start → sync → hover end → sync →
click end → sync`, with a fresh context/ref for each action. The first click may
only mark a start cell; a growing highlight after moving is progress, even if
no dialog opens yet. Do not request human help just because the first click
has not opened a form.

VOM reports `[selected]`/`[unselected]` for explicit accessibility selection.
`[selected:class]` and `[selected:data]` report exact styling/data hints on
controls, not proof of a committed reservation or a particular gesture type.
Compare the highlighted cells before/after movement. Unnamed clickable items
with numeric `data-index` may appear as `"item 14"`; the index is raw DOM evidence,
not a time or an endpoint label. Identify its row and time headers before acting.
Do not infer the first-selected cell or range direction from a static highlight.
Verify the final displayed range/form and, when requested, the eventual business
success message separately.

### Filling text

`fill` supports enabled, editable text inputs, textareas, and contenteditable
editor roots. Target the whole editing host, not an internal paragraph or span,
even if that child has `tabindex` or repeats `contenteditable`. Unsupported
targets are rejected without focusing or changing them; the tool never promotes
a child target to its parent editor.

By default, fill replaces all text in the target. `--no-clear` appends at its end.
An empty value clears the target unless `--no-clear` is set. Use the editor root's
ref from a fresh observation. After a mid-operation failure or cancellation,
observe before retrying: earlier input events or edits may already have occurred.
Rich-text framework state and undo behavior require application-specific checks.

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
