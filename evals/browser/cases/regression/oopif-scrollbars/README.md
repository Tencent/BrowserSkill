# OOPIF occupied-scrollbar regression

An iframe's content quad includes its child viewport's scrollbar space, while
`Page.getLayoutMetrics().cssLayoutViewport` excludes that space. Mapping the latter
onto the whole quad stretches positions and sizes. The full target-local viewport
must determine scale; the visible viewport must still clip content at every OOPIF
boundary and constrain target-local action points.

This fixture alternates loopback hostnames across two nested OOPIFs. It includes
scrolling, borders, padding, scaled iframe owners, a partially clipped button and
a fully clipped button. Custom scrollbars occupy different widths and heights.
The `scrollbars` query parameter accepts `both` (default), `vertical`, `horizontal`
or `none`.

Run the numerical regression with Node 22+ and a local Chrome executable:

```sh
BSK_GEOMETRY_CHROME=/path/to/chrome pnpm --filter @browser-skill/extension exec vitest run \
  src/tools/__tests__/snapshot-coordinates.browser.test.ts
```

The existing browser runner is shared with the snapshot-unit regression. The test:

- Verifies actual OOPIF targets and occupied scrollbar dimensions.
- Compares snapshot and live geometry with independent DOM rectangles and clipping.
- Dispatches real root-target clicks and verifies the intended frame/button received them.
- Rejects fully clipped controls and checks snapshot measurement reuse per target.
- Covers five device-scale/browser-zoom combinations plus single-axis and no-scrollbar cases.

The runner creates and removes isolated browser profiles. It is opt-in and skipped
in normal unit runs when `BSK_GEOMETRY_CHROME` is unset.

Run the CLI fixture smoke with a connected test extension:

```sh
BSK_AUTO_UPDATE=off pnpm eval:browser smoke --case oopif-scrollbars --bsk ./target/debug/bsk
```

The smoke assertions verify both nested frames have occupied scrollbars, that the
marker is observed and that the session is closed. Numeric geometry and actual
click assertions are exercised by the browser test above, not by smoke alone.
