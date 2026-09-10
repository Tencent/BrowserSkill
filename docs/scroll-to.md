# Scroll-to primitive

`scroll-to` brings an existing element and its containing frames into view, then
returns the visible portion's bounds. Use it to reveal a target before inspecting
the page or taking a screenshot. It accepts an element target rather than a pixel
distance or scroll direction. Use [wheel](wheel.md) for native directional wheel input.

| Entry point | Name |
| --- | --- |
| CLI | `bsk scroll-to` |
| Wire protocol | `tool.scroll_to` |
| DeepSeek Harness | `browser_interact` with `action: "scroll-to"` |

## CLI

Use a session you started and a fresh ref from an observation. The ids below are
examples; substitute the session, tab and ref returned by your own calls.

```sh
bsk scroll-to @e3 --session abcd --tab-id 42 --timeout 5s --json
bsk scroll-to --selector '#details' --session abcd
```

Supply exactly one target: a positional ref or selector, `--ref`, or `--selector`.
Refs accept `@e3` and `e3`. CSS selectors search only the main document; use refs
for elements in iframes (including out-of-process iframes) or shadow roots.
Refs belong to one session and tab and may become stale after page changes.

`--session` is required. `--tab-id` defaults to the Agent Window's active tab.
`--timeout` defaults to `30s` and must be positive; durations such as `5000ms` and
`5s` are accepted. The command operates on Agent Window tabs, including user tabs
explicitly borrowed into that window.

Example JSON output:

```json
{
  "tab_id": 42,
  "used_ref": "e3",
  "x": 10,
  "y": 20,
  "width": 100,
  "height": 80
}
```

`used_ref` or `used_selector` identifies the resolved target. The optional
`dialogs` array reports JavaScript dialogs handled during the call.

## Result contract

`x` and `y` are the upper-left corner, and `width` and `height` are the size of
the visible border-box portion's bounding rectangle. All four values use
**top-level viewport CSS pixels**, after scrolling and clipping by ancestor
containers and frame viewports. They are not document or screenshot pixel
coordinates.

Partial visibility is sufficient: a 400px-high element clipped by an 80px-high
scroll container can succeed with `height: 80`. Hidden or fully clipped targets
fail. The rectangle is not an occlusion or hit test: another element can cover
the target, and the rectangle's center is not a guaranteed click point. Layout
can change after the result; use fresh refs for subsequent interactions.

## Protocol and plugin

The CLI sends a normal request through the daemon to the extension:

```json
{
  "id": "scroll-1",
  "method": "tool.scroll_to",
  "params": {
    "session_id": "abcd",
    "ref": "@e3",
    "tab_id": 42,
    "timeout_ms": 5000
  }
}
```

Protocol callers must supply exactly one nonempty `ref` or `selector`.
`tab_id` is optional; `timeout_ms` is a positive integer and defaults to 30000.
These target constraints are enforced by the handler. See the generated
[parameter schema](../crates/bsk-protocol/schema/tool_scroll_to_params.json) and
[result schema](../crates/bsk-protocol/schema/tool_scroll_to_result.json) for field
types. The wire response wraps the result above in `{ "id": "scroll-1", "result": ... }`.

The plugin exposes the same action with its usual camelCase parameters:

```json
{
  "action": "scroll-to",
  "session": "abcd",
  "target": "@e3",
  "tabId": 42,
  "timeoutMs": 5000
}
```

Call this through `browser_interact` using a plugin-owned session. Its result
contains `session`, `tabId`, `x`, `y`, `width` and `height` with the same bounds
semantics. Omitted `session` uses the plugin's current session.

## Errors and interruption

The wire response uses the normal `error.code`, `error.message` and optional
`error.data.reason` fields. Common cases are:

| Code | `data.reason` | Meaning |
| --- | --- | --- |
| `invalid_params` | — | Missing/conflicting target or invalid timeout/tab id |
| `not_found` | `ref_not_found` | Ref is unknown, expired or belongs to another tab |
| `not_found` | `selector_not_found` | Main-document selector matched no element |
| `permission_denied` | `agent_window_scope` | Target tab has not been borrowed into the Agent Window |
| `permission_denied` | `element_not_visible` | No visible area remains after scrolling |
| `cancelled` | — | The call was cancelled |
| `timeout` | — | The action deadline expired |
| `cdp_failed` | varies | Browser command, frame geometry or visibility measurement failed |

The protocol classifies scroll-to as a browser mutation, so it uses the existing
per-session queue and user-interruption gate. The extension releases any retained
hover state before dispatch. Cancellation and deadline checks surround each CDP
step, including frame lookup, scrolling and measurement. Once detected, they
prevent further scrolling and a successful response; remote-object cleanup still
runs. Already performed scrolling is not rolled back, so inspect the current
page before retrying an interrupted call.

The implementation is scoped to scroll-to: it reuses frame scrolling and
coordinate projection, with a separate visibility measurement that accounts for
ancestor clipping and hidden frame owners. Shared click, hover and screenshot
geometry is unchanged.
