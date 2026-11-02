# Screenshots and Canvas

`@eN canvas [visual:screenshot]` is text, not an image. Screenshot the ref when needed; never infer
Canvas names/controls from nearby labels. If images cannot be understood, ask for
an image-capable model and continue with available semantics.

```text
bsk_inspect({ action: "screenshot", session: "<id>", ref: "@e3" })
bsk_interact({ action: "click", session: "<id>", target: "@e3", contextId: "<sync-context>", observationId: "<sync-observation>", captureId: "<capture-id>", imageX: 100, imageY: 50 })
```

Under target policy, sync first and retain its context/observation receipts, then observe
and screenshot the visual ref. The strict baseline is the sync's `observation_id`, not
the newer observe response's token. Supplementary reads do not replace that baseline.
Use the returned captureId with observed ORIGINAL PNG pixels, not resized
or viewport coordinates. Captures are single-use, last 2m, and expire on another
observe/snapshot/continuation or a newer screenshot of that ref, even when DOM refs stay stable.
`captureUnavailable` is view-only: observe and
screenshot again before clicking. Counts 1/2, buttons/modifiers work; Canvas
fill/IME/drag/hover/HTML do not. Repainting is allowed. Verify results; use DOM refs
for revealed controls. Inspect `effect_state=unknown` before retrying with a new capture.
