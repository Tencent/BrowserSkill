# Interaction details

## Element waits

`bsk_page` supports `action: "wait-for-element"` for an explicit element
condition. For example, if
`@e2` is an observed loading indicator after the triggering action, use
`bsk_page({ action: "wait-for-element", target: "@e2", state: "hidden" })`,
then check `satisfied` and observe the result. Replace the example ref with the
actual one. Skip waiting when the page is already ready.

Prefer a fresh ref for an existing node, including frame/shadow-root targets; do
not fetch HTML just to replace a usable ref with a selector. A known
CSS selector can find a node that will appear or be replaced; it checks only the
first match in the main document, so scope it to the intended component. Do not
invent selectors: inspect bounded HTML if the current observation lacks one.
Only CSS selectors are supported, not `text=...`, XPath, or Playwright locators.

States are `visible` (default), `hidden` (absent or not visible), `attached`, and
`detached` (absent). Visibility does not guarantee enabled state or actionability.
An already absent loading mask satisfies `hidden` immediately, possibly before
loading starts; prefer a result marker when that race is possible. Invalid refs
remain errors, even for `hidden`/`detached`. Navigation invalidates refs.

The default timeout is 10000 ms (range 1..300000); `pollMs` is optional, defaults
to 100, and accepts 16..2000. The wait stops as soon as the condition matches.
Always check `satisfied`: false means timeout, not success. `attached`/`visible`
describe the last completed probe and are unknown if no probe completed.
Waiting does not refresh refs: observe before choosing a new action. For a
timeout, stale ref, or an older installation without this command, observe the
current page and continue with supported single actions when possible. Do not
repeat the triggering action without checking its effects or keep retrying an
unsupported wait. If blocked, follow [help and recovery](help-and-recovery.md).

## Interactions

- Hover markers like `[hover first: Shoes | Bags]` list labels, not refs. Hover the
  trigger, observe, then use the item's ref. Click the trigger only if its action is wanted.
- `scroll-to` returns ancestor-clipped bounds in top-level viewport CSS pixels.
  Partial visibility suffices; hidden/fully clipped targets fail. It does not test occlusion.
- `wheel` uses signed `deltaX`/`deltaY`, at least one nonzero. Optional `target` is
  scrolled into view first; otherwise it uses the viewport centre. It reports input,
  not scrolling success: observe afterwards. Focus/blur change focus states.
- `drag` uses `target` as the source and either `to` or nonzero `deltaX`/`deltaY`.
  Default mode holds the mouse button while moving. `dragMode: "click-move-click"`
  requires `to` and zero `holdMs`; it clicks, moves with the button released, then
  clicks the destination. Pass the observed `contextId` and verify the resulting
  state. Input delivery does not prove application success.

## Steps and saved observations

`bsk_interact` with `action: "step"` executes one already-decided action, optionally
waits for `untilVisible`, then synchronizes. Pass `stepAction` and a `params` JSON
string using protocol fields, for example `params: "{\"ref\":\"e3\"}"` for a click.
Session, tab, context, `observationId` and `expect` use the outer tool fields;
`dependsOn` is for strict policy only. Use only observed
refs/selectors; the example ref is a placeholder. `waitTimeoutMs` is 1..25000.

Read `ok`, `action`, `readiness` and `post` separately. A later wait, sync or save
failure does not undo input. Never blindly replay a partial or cancelled step.
Read `post.context_id` with its observation before planning the next action. It is reusable
for target-policy DOM actions; `post.observation_id` identifies the strict baseline. If
absent, wait-user or sync as indicated, then replan.

Use `saveFull` on `bsk_session action: "sync"` or `step` to save a complete reply to
a new local JSON path. `baseline` may reuse an exact unchanged predecessor.
Optional `matchText` only folds plain stateless numbered `button "item N"` lines;
business text, named/stateful controls and complete forms/dialogs remain visible.
It may not shorten ordinary pages. Use `bsk_inspect action: "view"` with `file` and
`find` for case-sensitive literal search, or `startLine`/`lineCount` for a bounded
window. `view` is offline and accepts no session/tab/context/dependencies. Its
historical refs and context never refresh or authorize a live action.

## Observation continuation

No default token cap. With `maxTokens`, pass `nextCursor` as observe's `cursor` to
continue. Target policy preserves earlier DOM refs; visual refs expire on each page.
Strict policy replaces all refs, so use those refs before continuing.
Continuation uses the same capture without refresh/depth changes. New
observe/snapshot or changed page identity invalidates it.

Console/network are bounded read-only diagnostics; follow sequence cursors.
Wait only for expected navigation. `bsk_assist` resizes windows or emulates
a device for one tab.
