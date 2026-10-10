# Interaction details

## Element waits

Wait only when the latest observation shows a pending update. For example, if
`@e2` is an observed loading indicator after the triggering action, use
`browser_page({ action: "wait-for-element", target: "@e2", state: "hidden" })`,
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

## Observation continuation

No default token cap. With `maxTokens`, pass `nextCursor` as observe's `cursor` to
continue. Each page replaces refs; use them before continuing, never reuse old ones.
Continuation uses the same capture without refresh/depth changes. New
observe/snapshot or changed page identity invalidates it.

Console/network are bounded read-only diagnostics; follow sequence cursors.
Use lifecycle `wait` only for expected navigation, not dynamic content.
`browser_assist` resizes windows or emulates a device for one tab.
