# Rendered Surface browser fixtures

These pages exercise Canvas discovery through a real browser DOMSnapshot and AX tree. They are deliberately framework- and site-independent.

## Serve

From the repository root:

```bash
python3 -m http.server 4173 --bind 127.0.0.1 \
  --directory apps/extension/test-fixtures/rendered-surfaces
```

Use an Agent Window large enough to keep the primary matrix visible:

```bash
bsk session start --width 1440 --height 1100
bsk navigate http://127.0.0.1:4173/index.html --session <id>
bsk observe --session <id>
```

Always stop the session after the run.

## Pages

### `index.html`

Expected individual Surface labels:

- `fixture-basic-large`
- `fixture-tiny-8px`
- `fixture-pointer-events-none`
- `fixture-partial-ax`
- `fixture-contained-outer`
- `fixture-contained-inner`
- `fixture-different-parent-a`
- `fixture-different-parent-b`

Expected one grouped Surface:

- `fixture-layered-group`, with `layers=2`

Expected absent:

- `fixture-display-none`
- `fixture-visibility-hidden`
- `fixture-opacity-zero`
- `fixture-parent-opacity-zero`
- `fixture-hidden-attribute`
- `fixture-inert-parent`
- `fixture-aria-hidden-parent`
- `fixture-zero-size`
- `fixture-offscreen-right`
- `fixture-fully-overflow-clipped`

`fixture-partially-overflow-clipped` must remain present because part of it is visible. Its screenshot must contain only the browser's final composited view.

### `unlabeled.html`

This page contains eight Canvas elements but must render seven generic Surface markers because
the two coincident layers form one group.

- Every marker uses the stable fallback label `canvas visual surface`.
- Exactly one marker has `layers=2`.
- The two contained canvases remain separate markers.
- `id`, `class`, `data-testid`, nearby prose, and fallback AX content never become a Surface label.
- Blank `aria-label` and `title` values behave as no label.
- Fallback AX content does not suppress the corresponding Surface.

### `frames.html`

Expected Surface labels:

- `fixture-same-origin-frame`
- `fixture-cross-origin-frame`
- `fixture-nested-frame`

The cross-origin frame uses `http://localhost:4173` while the parent uses `http://127.0.0.1:4173`. With Chromium site isolation this exercises the OOPIF path without an external service.

Each frame Canvas also exposes a `pointer status` live region. A successful
screenshot-bound point click must report
`down button=0 buttons=1 hoverReady=true; click received` and turn the Canvas
yellow. The hover flag is set on the animation frame after `pointermove`, so the
fixture verifies both child-document delivery and the scheduling boundary
required before `pointerdown`, rather than merely validating projected
coordinates or a successful CDP response.

### `viewport.html`

Run with a `900x700` Agent Window.

- `fixture-partial-viewport` is partly visible and must be represented.
- `fixture-below-fold` is absent initially.
- After scrolling it into view and observing again, `fixture-below-fold` must be represented with a fresh ref.

### `input-frames.html`

This page exercises generic frame-aware input routing. It contains a top-level
input plus same-origin, cross-origin (OOPIF), and nested frame inputs. Each
frame includes an input, textarea, contenteditable editor, and a controlled
input that resets its value on the next animation frame.

- `fill` must route focus, text insertion, DOM events, and readback through the
  ref's owning CDP target.
- `press --ref` must focus and dispatch every key event through that same target.
- Untargeted `press` must follow the actual focused target or refuse when focus
  ownership cannot be determined uniquely.
- The rejecting input must return `input_not_applied`, never a successful
  requested-value length.

### `canvas-input.html`

This is the PR3 end-to-end fixture. Its cross-origin frame contains a
visual-only three-row Canvas. A screenshot-bound click on row 3 exposes and
focuses a standard textbox; ordinary `fill` must then write and read back its
real value through the textbox's owning target. The fixture deliberately does
not provide a Canvas-specific fill action.

### `dynamic.html`

Use the normal DOM buttons and re-observe after each action:

- Initial state: `fixture-dynamic` absent.
- After **Insert canvas**: present.
- After **Resize to zero**: absent.
- After **Restore size**: present with a fresh ref.
- After **Remove canvas**: absent.

## Invariants

- `snapshot` must not emit any of these Surface markers.
- `observe` must emit only currently visible Canvas surfaces.
- Existing DOM/AX controls remain readable alongside Surface markers.
- Missing labels never prevent discovery; naming and discovery are independent.
- A Surface ref allows `screenshot --ref` and rejects ordinary click/fill/hover/select.
- No fixture URL, id, label, or layout constant may appear in production discovery code.
