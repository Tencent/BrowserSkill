# Visual observation design fixtures

These are synthetic, site-independent inputs for the visual observation architecture in
[the design](../../../../docs/design/visual-observation.md). They contain no original page
data, account identifiers, external fonts or production selectors. They are not a production
discovery implementation.

Use [the acceptance checklist](../../../../docs/design/visual-observation-acceptance.md)
for each PR's steps and success criteria. No separate report is required.
Historical probe success does not certify future production modules.

## Browser contract probe

Requires Node.js with built-in WebSocket support (Node 22+) and an installed Chrome. No extra
packages, user profile, extension, or login are required.

From the repository root:

```sh
node apps/extension/test-fixtures/visual-observation/probe.mjs /tmp/bsk-visual-evidence
```

On platforms other than macOS, set `CHROME_PATH` to the installed Chrome executable. The probe
starts its own headless Chrome with an ephemeral profile and a loopback fixture server. It
removes the profile and stops Chrome/server on completion or failure. `report.json`, raw CDP
replies and PNGs are written to the explicitly supplied directory; do not commit them.

The probe verifies CSS exposure versus visibility, snapshot units, DPR raster dimensions,
CSS zoom, frame content origins, child scrolling, nested same-target geometry, a confirmed
OOPIF target, and navigation/document.open identity behavior. It records page-scale emulation
separately; that is **not** browser UI zoom. It does not certify production VOM behavior, arbitrary
occlusion, exact clip-path geometry, or all browser versions.

## Minimal end-to-end reproduction

```sh
python3 -m http.server 4177 --bind 127.0.0.1 \
  --directory apps/extension/test-fixtures/visual-observation
bsk session start --width 1440 --height 1100
bsk navigate http://127.0.0.1:4177/table.html --session <session>
bsk observe --session <session>
bsk screenshot --session <session> --out /tmp/bsk-table.png
bsk session stop <session>
```

Always stop the session and the local server. Use a foreground Agent Window and confirm the
painted grid is visible before interpreting the observation. `load`, AX toolbar appearance,
and background screenshots alone do not prove a canvas has drawn.

`table.html` embeds `grid.html` through `localhost` from a `127.0.0.1` parent. The grid has DOM
toolbar controls and one unlabeled Canvas with three synthetic columns and six painted rows.

Main baseline: `Page action`, `Insert record`, and `Filter` are referenceable; the painted
`Canvas column A/B/C` and `Canvas row 1..6` have no textual observation representation or visual
ref, despite an untruncated result. This is a **known gap**, not a golden expectation that future
implementations must preserve.

Future acceptance: retain the DOM controls and add a screenshot-only visual ref for the visible
grid, with correct frame projection. Do not invent AX cell text. Validate the corresponding
screenshot, then move/remove/resize and re-observe according to the freshness contract.

## Discovery policy cases

At a 1440×1100 window and without scrolling:

| Canvas ID | Expected candidate in the new design | Reason |
|---|---|---|
| plain | yes | No name required |
| named | yes | Name does not establish complete pixel semantics |
| aria-hidden | yes | Accessibility exclusion is not visual exclusion |
| inert | yes | Inertness is not visual hiding |
| pointer-none | yes | Screenshot observation does not require pointer interaction |
| visibility-override | yes | Child restores computed visibility |
| opacity-parent | no | Ancestor makes subtree transparent |
| display-none | no | No layout box |
| visibility-hidden | no | Computed visibility suppresses this element |
| zero | no | Empty geometry |
| hidden-overridden | yes | CSS display overrides normal hidden presentation |
| partial-clip | yes, 60×30 crop | Supported overflow intersection |
| full-clip | no | Fully outside ancestor clip |
| axis-clip | yes, x clipped only | overflow-x:clip and overflow-y:visible remain independent |
| border-clip | yes, clipped to client box | Ancestor border box is not its scrollport |
| border-canvas | yes, border-box region | Observation and live screenshot resolver must use the same box kind |
| fallback | yes | AX fallback is not full pixel coverage |
| stack-a / stack-b | one output entry after selection | Same document/parent/exact crop; not proof of a logical object |

`checkVisibility()` is used in the probe only for CSS suppression evidence; it does not establish
viewport intersection, ancestor overflow clipping, or absence of occlusion. `frame.html` supplies
known local coordinates, bordered owners, nested frames and scrollable content for independent
geometry verification. The fixture IDs must never enter production discovery code.

## Renderer operation counts

After installing the repository's normal dependencies:

```sh
node apps/extension/test-fixtures/visual-observation/measure-render.mjs /tmp/bsk-render-evidence
```

This instruments a temporary copy of the current renderer, runs the installed Vitest, and writes
the source hash and loop counters to `render-counts.json`. It checks instrumentation sites and
fails explicitly when source structure changes; update the diagnostic deliberately then. It never
modifies production sources and never asserts that today's quadratic costs must persist.

The wide fixture contains N headings followed by N equally named buttons in a common context.
The deep fixture contains 2,000/4,000 transparent wrappers. Counters cover render-stack visits,
ordered DOM context candidates, and same-container sibling visits. They are not a complete CPU
profile or an assertion about the complexity of all VOM stages.

Use these existing-renderer counts only as a before/after regression baseline. Improving the
historical algorithm is not a prerequisite for Canvas work. New Canvas stages need their own
workload models and measurements; do not copy this renderer's algorithms or use these counts
as evidence that visual discovery, clipping, selection, or screenshot execution is efficient.

## Review boundary

Commit only these synthetic fixtures, diagnostic tools, and reviewed design/evidence summaries.
Keep local browser profiles, original internal-site screenshots/HTML/observations, generated
captures, temporary source instrumentation and build outputs outside the changeset.
