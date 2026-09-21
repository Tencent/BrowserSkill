# Interaction details

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
