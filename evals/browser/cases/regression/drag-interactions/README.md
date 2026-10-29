# Drag interactions

This synthetic corpus tests complete mouse gestures through `tool.drag` and the
`bsk drag` CLI. The shared page contains mouse listeners, pointer capture, a
long-press threshold, native HTML drag with DataTransfer, a range input, a resize
handle, sortable cards, Canvas drawing and SVG movement. Browser assertions read
actual DOM order/values, pixels and trusted events rather than command receipts.

The browser suite also exercises real SortableJS in native and fallback modes,
real dnd-kit with a distance activation threshold, VOM duplicate-name refs,
observation expiry, shadow roots, iframe coordinates, background focus,
modifiers, invalid/covered/hidden/detached targets, cancellation during hold,
movement and native dragging, delayed replies, and recovery after interruption.
Dependencies for third-party fixtures are test-only and version-locked.

Run with an installed Chrome executable (no browser download required):

```sh
BSK_DRAG_CHROME=/path/to/chrome pnpm --filter @browser-skill/extension exec vitest run \
  src/tools/__tests__/drag.browser.test.ts src/tools/__tests__/drag.test.ts
pnpm eval:browser:check
```

The suite owns an isolated browser/profile and closes each page. CI enables the
browser tests explicitly; without the environment variable they are skipped.

For the full CLI/IPC/WS/installed-extension path, use current stable Chrome or
Chrome for Testing with `Extensions.loadUnpacked` support:

```sh
cargo build -p bsk --locked
BSK_DAEMON_WS_URL=ws://127.0.0.1:52839 pnpm --filter @browser-skill/extension build
BSK_DRAG_CHROME=/path/to/chrome node evals/browser/cases/regression/drag-interactions/run.mjs
```

This runner owns its daemon home, browser/profile and session; it stops the
session even on failure. Results go to ignored `evals/browser/results/drag-interactions`.
It validates shared-control checks, timeout recovery and cross-origin iframe refs
as well as page outcomes. It also checks precise source/destination offsets through
the production pointer validator, preserves fill/click behavior on draggable cards,
and rejects drops covered by the top page or an intermediate iframe before pressing.
To use another
port, match the extension build URL with `BSK_DRAG_PORT`.

The corpus also supports the existing smoke runner against a connected test
extension: `pnpm eval:browser smoke --case drag-interactions --bsk ./target/debug/bsk`.

Scope: desktop mouse input, same-tab visible endpoints, element references or
strict main-document selectors. No automatic scrolling during a held gesture,
touch gestures or screenshot-bound Canvas endpoints. A cancelled gesture may
already have changed application state; input cleanup is not rollback.

## Click–move–click ranges

`range-selection.fixture.mjs` reduces a calendar grid to three empty indexed cells.
Click/release starts the selection; a move with no buttons previews it; a second
click/release commits it. It contains synthetic DOM and state only, with no
production site code, account data, or booking endpoints.

The real-browser drag suite covers forward/reverse/single-cell selection, trusted
released movement, VOM markers after separate steps, changed/disabled destinations,
cancellation and timeouts. Held drag still delivers input without selecting this
widget. Protocol 1.7 is required for the new mode so older peers cannot silently
interpret it as a held drag.

Run the real browser regression with an isolated Chrome profile:

```sh
BSK_DRAG_CHROME=/path/to/chrome pnpm --filter @browser-skill/extension exec vitest run src/tools/__tests__/drag.browser.test.ts
```

To measure actual CLI/daemon/extension round trips (including initial and final
`cooperate sync`, excluding setup, navigation and model latency):

```sh
cargo build -p bsk --locked
BSK_DAEMON_WS_URL=ws://127.0.0.1:52943 pnpm ext:build
BSK_DRAG_CHROME=/path/to/chrome BSK_RANGE_REPORT=/tmp/range-benchmark.json \
  node evals/browser/cases/regression/drag-interactions/range-selection.bench.mjs
```

The script owns and cleans up its daemon/profile/session and alternates five trials
of each method. Separate uses the existing click/hover/click defaults; combined
uses the default 500ms movement. It checks actual selected cells and final VOM
output for every trial; command success alone is insufficient. It never accesses
a user's logged-in browser. These small-fixture timings are not predictions for
an entire production reservation workflow.
