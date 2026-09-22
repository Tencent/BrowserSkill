# Screenshots and Canvas

`@eN canvas [visual:screenshot]` is text, not an image. Screenshot the ref when needed; never infer
Canvas names/controls from nearby labels. If images cannot be understood, ask for
an image-capable model and continue with available semantics.

```text
browser_inspect({ action: "screenshot", session: "<id>", ref: "@e3" })
browser_interact({ action: "click", session: "<id>", target: "@e3", captureId: "<capture-id>", imageX: 100, imageY: 50 })
```

Use the returned captureId with observed ORIGINAL PNG pixels, not resized
or viewport coordinates. Captures are single-use, last 2m, and expire on ref replacement
or a newer screenshot of that ref. `captureUnavailable` is view-only: observe and
screenshot again before clicking. Counts 1/2, buttons/modifiers work; Canvas
fill/IME/drag/hover/HTML do not. Repainting is allowed. Verify results; use DOM refs
for revealed controls. Inspect `effect_state=unknown` before retrying with a new capture.
