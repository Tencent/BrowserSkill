# Interaction details

## Batch known actions

When targets and values are already known, use one `browser_interact` call:

```text
browser_interact({
  action: "batch", session: "<id>", tabId: 7,
  steps: [
    { action: "fill", target: "@e1", value: "Acme" },
    { action: "fill", target: "@e2", value: "Example contact" },
    { action: "select", target: "@e3", values: ["software"] },
    { action: "click", target: "@e4" }
  ]
})
```

Use the actual `tabId` and fresh DOM refs from the latest observation. Batch
accepts 1..20 steps, at most 64 KiB: fill, select, click, press, focus, blur,
hover and scroll-to. Options match the single actions; selectors, Canvas,
page scripts, uploads and nested batches are not batch targets.

`timeoutMs` is the total execution and final-observation budget after the
sequence enters the session queue (default 30000, maximum 120000), with time
allowed for cancellation to settle. Steps execute serially through the existing
single-action path. The plugin keeps other work on that session queued until
the sequence finishes. Do not operate the same session from another client.

The first failure stops the sequence and returns partial results: completed,
failed, or not_run, with effect_state. No automatic replay, rollback or retained
receipt. On success an immediate final observation is included; this does not
wait for readiness or prove the business goal succeeded. Observe/wait again
when the result is still loading. An observation failure does not undo actions.

Stop a plan before a new decision or page change. On failure, observe afresh and
use single actions for the remaining work. Never repeat completed actions or
assume an uncertain action had no effect. User cancellation also stops the final
observation: wait for the user to resume. Missing or invalid batch arguments are
errors before dispatch. Older backends work through their existing single
actions; if batch itself is unavailable, use those actions directly.


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
Wait only for expected navigation. `browser_assist` resizes windows or emulates
a device for one tab.
