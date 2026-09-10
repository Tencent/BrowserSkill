# DOMSnapshot layout-unit regression (#195)

Source: https://github.com/Tencent/BrowserSkill/pull/195

DOMSnapshot bounds and document scroll offsets retain Blink layout units. Treating them as CSS
pixels changes both positions and sizes under device scaling/browser zoom, before iframe
projection or viewport clipping even starts.

The fixture contains a scrolled root, a scrolled same-process iframe, an OOPIF served from the
other loopback hostname, and a nested iframe in each. Owners have borders, padding and CSS
transforms. The geometry test compares the production capture's local and top-level rectangles
against independent DOM border boxes, with at most 2 CSS pixels of layout rounding. It also
checks that each target reads layout metrics only once. No credentials or personal tabs are used.

Run the geometric assertions with Node 22+ and a local Chrome executable:

```sh
BSK_GEOMETRY_CHROME=/path/to/chrome pnpm --filter @browser-skill/extension exec vitest run \
  src/tools/__tests__/snapshot-coordinates.browser.test.ts
```

The test launches and cleans up its own headless Chrome profiles. It explicitly verifies the
requested browser zoom and OOPIF topology, so unsupported setups fail rather than silently
testing a different configuration. It is skipped in ordinary unit runs unless the executable
is specified. No browser download or new package dependency is required.

The corpus smoke case checks fixture readiness and observable semantics through the real CLI:

```sh
BSK_AUTO_UPDATE=off pnpm eval:browser smoke --case snapshot-coordinates --bsk ./target/debug/bsk
```

Smoke alone does **not** certify coordinate accuracy; CLI observations do not expose raw boxes.
Use the geometric test above for the regression's numeric assertions.

## Related scrollbar regression

The unit-conversion fixture keeps non-occupying OOPIF scrollbars by default. The same
browser test also runs the dedicated [OOPIF scrollbar fixture](../oopif-scrollbars/README.md),
which covers occupied scrollbars, two OOPIF boundaries, clipping and real clicks.
Append `&classic-scrollbars` to this fixture's URL to enable its normal OOPIF scrollbars.
