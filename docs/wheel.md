# Native wheel input

`wheel` sends a native Chromium mouse-wheel event. Use it for directional
scrolling or controls that respond to wheel input. Use [scroll-to](scroll-to.md)
when the goal is simply to bring an existing element into view.

| Entry point | Name |
| --- | --- |
| CLI | `bsk wheel` |
| Wire protocol | `tool.wheel` |
| DeepSeek Harness | `browser_interact` with `action: "wheel"` |

## Usage

Use a session you own and fresh refs from an observation. The ids below are examples.

```sh
bsk wheel --delta-y 600 --session abcd
bsk wheel --delta-y -120 --session abcd
bsk wheel '#panel' --delta-x -200 --session abcd --tab-id 42 --timeout 5s --json
bsk wheel @e3 --delta-y 120 --modifiers ctrl,shift --session abcd
```

Both deltas default to zero. Values must be finite numbers, and at least one
must be nonzero. Positive X means right and positive Y means down. Negative
values work with either `--delta-y -120` or `--delta-y=-120`.

Supply at most one target: a positional ref/selector, `--ref`, or `--selector`.
An explicitly empty target is an error. Refs accept `@e3` and `e3` and belong to
one session and tab. CSS selectors search the main document; use refs for
iframe or shadow-root elements. Unknown, stale and cross-tab refs fail instead
of falling back to the viewport.

`--session` is required. `--tab-id` defaults to the Agent Window's active tab;
user tabs must first be borrowed into that window. `--timeout` defaults to
`30s` and must be positive. Modifiers are comma-separated `alt,ctrl,meta,shift`.

## Input and result contract

Without a target, the mouse moves to the viewport centre before the wheel event.
The browser hit-tests that point: an inner scroller under the centre may receive
the input instead of the document.

With a target, the tool first scrolls the element and its frame owners into view.
It then picks a point within the element's visible content, accounting for
ancestor clipping and iframe projection, and moves the mouse there before
sending the wheel event. Hidden or fully clipped targets fail. Other overlapping
page elements can still receive the input; visibility is not an occlusion test.
Moving the pointer can itself trigger hover UI and change the page.

Deltas are passed unchanged to CDP's `Input.dispatchMouseEvent`, whose input
units are CSS pixels. Chromium applies native page-zoom and modifier behavior;
DOM `WheelEvent.deltaX/deltaY` and actual scroll distance can differ from the
requested values. For example, Chromium at 125% page zoom delivers a 120-unit
input as a 96-unit DOM wheel delta. A page can also prevent the default scroll
or use the event to zoom a control. Browser behavior is preserved.

Example result:

```json
{
  "tab_id": 42,
  "used_selector": "#panel",
  "x": 320,
  "y": 240,
  "delta_x": -200,
  "delta_y": 0
}
```

`x/y` are the dispatch point in top-level viewport CSS pixels, not screenshot
pixels. `delta_x/delta_y` echo the requested input, not a measured displacement.
Success means input dispatch completed; it does not wait for scrolling,
animations or application work to finish. Observe the page afterwards to check
the result. The optional `dialogs` array reports dialogs handled during the call.

## Protocol and plugin

```json
{
  "id": "wheel-1",
  "method": "tool.wheel",
  "params": {
    "session_id": "abcd",
    "ref": "@e3",
    "delta_y": -120,
    "timeout_ms": 5000
  }
}
```

Both axes are optional and default to zero; the handler enforces nonzero input,
finite deltas and at most one nonempty `ref` or `selector`. See the generated
[parameter schema](../crates/bsk-protocol/schema/tool_wheel_params.json) and
[result schema](../crates/bsk-protocol/schema/tool_wheel_result.json).

The plugin exposes the same operation through a plugin-owned session:

```json
{
  "action": "wheel",
  "session": "abcd",
  "target": "@e3",
  "deltaY": -120,
  "tabId": 42,
  "timeoutMs": 5000
}
```

Omitted `session` uses the current plugin session. The result contains `session`,
`tabId`, `x`, `y`, `deltaX` and `deltaY`, with the same input semantics above.
The action uses the existing ownership, cancellation, queue and observation path.

## Errors and interruption

Invalid input returns `invalid_params`; missing refs/selectors return `not_found`.
An out-of-scope tab or invisible target returns `permission_denied`. Geometry,
visibility, overlay bypass and input failures return `cdp_failed`.

Wheel is a browser mutation and uses the session queue and user-interruption
gate. On timeout, the daemon sends cancellation to the extension and keeps the
session busy while waiting for cleanup (bounded to two seconds). This also covers
requests delayed in transit. Cancellation and deadline checks surround browser steps, including tab
resolution, selector lookup, frame scrolling, measurement and input. Once
observed, cancellation or timeout prevents further input and is reported as
`cancelled` or `timeout`. Overlay restoration and remote-object cleanup still run.
Already performed scrolling or dispatched input cannot be recalled; inspect the
current page before retrying an interrupted call.

## Browser regression tests

The opt-in suite creates an isolated headless Chromium profile and local fixture
servers. It tests the handler through real CDP, including trusted events,
scrolling, nested clips, same-process and out-of-process iframes, zoom, modifiers,
`preventDefault` and cancellation. It does not attach to a user's browser.

```sh
BSK_WHEEL_CHROME=/path/to/chrome pnpm --filter @browser-skill/extension exec vitest run src/tools/__tests__/wheel.browser.test.ts
```
