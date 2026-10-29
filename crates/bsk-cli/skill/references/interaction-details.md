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
# Replace session, context and selectors with values from the latest sync.
session=abcd
context=current-context-id
bsk click '#run-search' --session "$session" --context "$context" || exit 1
result=$(bsk wait-for-element '#search-results' --state visible \
  --timeout 20s --session "$session" --json) || exit 1
if ! jq -e '.satisfied == true' <<<"$result" >/dev/null; then
  printf 'Results not ready: %s\n' "$result" >&2
  exit 1
fi
bsk cooperate sync --session "$session"
```

Use `--state hidden` for an already visible loading mask, whether it will be hidden
in place (`v-loading`) or removed (`Loading.service`). Use `detached` when actual
removal is required. Observe after success before using new refs. End the session
on success and error as required by the task workflow. This API reduces caller
round trips and standardizes state checks; it promises neither lower latency nor
an escape from browser background throttling.

### Efficient observation workflow

For one decided action and its resulting state, use [step and cached views](step-and-cache.md).

The expensive part of a multi-step task can be caller round trips and repeated
page interpretation, even when individual CLI calls are fast. After deciding
one action from current evidence, run that action and its following sync in one
tool invocation. Check action failure before proceeding; do not pre-plan several
mutations or reuse one context across them. A known readiness selector can be
waited on between that action and sync; check `satisfied`, without fixed sleeps
or repeatedly returning a loading page to the model.

On pages with repeated numbered fallback buttons, fold controls outside a known
target's surrounding lines in the **CLI presentation**. Use literal text from a
previous observation and retain enough surrounding lines for the decision:

```sh
bsk cooperate sync --session <id> --match-text 'known row label' \
  --context-lines 40 --save-full /absolute/new-observation.json
```

`--match-text` is repeatable, literal and case-sensitive. This is a conservative
presentation fold, not general text filtering, search or a row selector. Only
plain stateless numbered fallback controls (`button "item N"`) outside the
matching windows may be omitted.
All business text, named controls, state/value/context hints, ancestors and the
view/layer outline stay visible. Complete forms, dialogs, alerts and statuses
are retained, including their numbered controls. This avoids guessing which
language-specific wording expresses a restriction, fee or warning.

Every query must match; otherwise the full returned view is shown with
`fallback_reason: no_match`. Duplicate matches remain visible and are counted in
`matches_per_query`; do not pick the first by assumption. Unknown formats and
views that would grow also fall back to the original text. This may produce less
compression on some pages, including flight results with meaningful named controls.

For general literal text search, inspect the saved observation locally:

```sh
bsk view /absolute/new-observation.json --find 'known row label' --line-count 80
```

When any lines are omitted, `observation.truncated` is true for legacy readers.
`observation.capture_truncated` reports the original capture truncation, while
`presentation.filtered` identifies local omissions. `presentation.complete` is
true only when neither occurred. A backend `next_cursor` belongs to capture
pagination, not presentation filtering. Inspect the saved full reply or sync
without `--match-text` for omitted controls; never infer absence, availability,
a time range or a business value from an omitted numbered item. The original
refs, observation/context IDs, activity and whole-page guard are unchanged.
The guard detects page changes, not errors caused by overlooking existing rules.
Use a full view for final business decisions and verification.

`--save-full` stages the complete returned reply before filtering, then publishes
it atomically to a new local JSON file (Unix permissions 0600). Failed calls leave
no destination file; existing files, including concurrent writers, are never
overwritten. `--max-tokens` still limits the original capture, so a saved reply
can be capture-truncated. Read another section locally instead of taking a new
snapshot just to change the display. Saved refs are historical: use them only
while their context is current; sync after an action, intervention or page change.

For an action followed by a transient synchronization refusal, use
`bsk cooperate sync --settle --session <id>`. It performs at most three read-only
sync attempts, each retry preceded by `cooperate wait` (default 1s per wait;
`--timeout-ms` overrides it). It retries only `cooperation_sync_required` with
`effect_state: none`. Unknown effects, cancellation, user stop and other errors
are returned without retries. A wait that is not ready returns `settle.outcome:
not_ready` and no action context; continue the cooperation hand-back workflow.
Inspect `settle`, ownership and context, not just exit code. This does not prove
application readiness: use an observed loading-complete signal where available.
Never replay the preceding click, drag or submission because sync was refused.

Use the ordinary full view for discovery when you do not yet know a useful
label. Keep enough evidence to choose the next action; do not dump all markup
when a targeted observation suffices. Stop at verified success. When measuring
speed, report both end-to-end wall time and CLI execution time; a smaller
observation alone does not establish an end-to-end speedup.

### Paginated observations

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
