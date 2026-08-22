---
name: browser-skill
description: |
  Use the injected browser_* tools to automate the user's logged-in Chromium
  browser in a managed Agent Window.
---

# browser-skill for DeepSeek Harness

Drive the user's real Chromium browser through the structured `browser_*` tools provided by this
plugin. The browser keeps the user's existing logins and cookies while isolating automation in an
Agent Window. Use the tool schemas exactly as exposed by DeepSeek Harness; arguments are structured
fields, not command-line flags.

## Tool availability

Loading this skill reveals the browser tools for the rest of the conversation. If the tools were
hidden before this skill was loaded, start browser work only after the skill invocation succeeds.

All browser operations must use the injected tools directly. Do not translate the examples in this
document into terminal commands or invoke another process to control the browser. Direct tool calls
preserve session ownership, the live observation window, tool cards, cancellation, and cleanup.

## When to use

- Visit and read pages that require the user's existing browser session.
- Fill forms, select options, click through bounded flows, or smoke-test a web UI.
- Inspect tabs, page structure, screenshots, console messages, or network metadata.
- Work with a user tab after explicitly borrowing it into the Agent Window.

Do not use browser automation for tasks that need only local files, a purpose-built API, or an
explanation. Never extract credentials, cookies, tokens, or other secrets. Do not keep control of a
personal tab longer than the immediate task requires.

## Mandatory workflow

Every browser task follows this lifecycle:

1. Call `browser_session_start` and retain its returned `sessionId`.
2. Use that session for every browser operation. Pass `session` explicitly when more than one
   session exists.
3. Call `browser_session_stop` when the bounded goal is reached or an error ends the task. Treat
   cleanup like a `finally` path unless the user explicitly asks to keep the session open.

Conceptual tool-call sequence:

```text
browser_session_start({ url: "https://example.com" })
browser_observe({ session: sessionId })
browser_click({ session: sessionId, target: "@e4" })
browser_observe({ session: sessionId })
browser_session_stop({ session: sessionId })
```

The plugin owns only sessions created by `browser_session_start`. `browser_session_list` reports
only those owned sessions. Never guess or reuse a session id from another program. When `session`
is omitted, most tools use the most recently started or used owned session; explicit ids are safer
for multi-session work.

## Stop when the goal is met

Browser work is a bounded task, not open-ended browsing.

1. Define one observable success condition from the user's request.
2. Take the shortest path: observe, act, then perform at most one relevant check.
3. Stop immediately when success is visible. Do not refresh, navigate, click, or perform extra
   verification after success.
4. If a human-only step appears, use `browser_request_help`. If an action fails twice without
   progress, pause instead of brute-forcing.
5. When uncertain, make at most one fresh observation. If the state is still ambiguous, ask the
   user rather than continuing to click.

## Core interaction loop

Use `browser_navigate` to open a destination in the active Agent Window tab, then inspect the page
before interacting:

1. `browser_observe` is the primary semantic view. It returns roles, states, text, and `@eN` refs,
   including hints about conditional hover or focus surfaces.
2. `browser_snapshot` is the static accessibility-tree fallback when the semantic view is
   insufficient or a stricter tree is useful.
3. Prefer a fresh `@eN` ref over a raw CSS selector for `browser_click`, `browser_hover`,
   `browser_fill`, `browser_select`, and targeted `browser_press` calls.
4. Observe again after navigation or a meaningful DOM change before using another ref.

Refs invalidate after navigation and may also become stale after large DOM changes. Never carry a
ref to a new page. If an observation marks a control as hover-triggered, call `browser_hover` on the
trigger, observe again, and then act on the newly visible ref.

Use interaction tools according to their schemas:

- `browser_click`: click a ref or selector; optionally choose mouse button and click count.
- `browser_hover`: move to a ref or selector and allow hover UI to settle; then observe again.
- `browser_fill`: clear and fill a text-capable element; set `noClear` only when appending is
  intentional.
- `browser_select`: pass `values` as an array, including for a single option.
- `browser_press`: send a key or combo, optionally focusing `target` first.

Actions may trigger a navigation after the action itself returns. Use
`browser_wait_for_navigation` only when that lifecycle wait is actually needed, then observe the
new page.

## Observation and page reading priority

Escalate page reading only as needed:

1. `browser_observe` for normal semantic understanding and interaction refs.
2. `browser_snapshot` for a stricter static accessibility tree.
3. `browser_get_html` for hidden DOM, metadata, or exact markup that the semantic views cannot
   provide. A `ref` must come from a fresh observation; keep `maxBytes` bounded.
4. `browser_screenshot` for layout, styling, canvas, image content, or another genuinely visual
   question. Pass a fresh `ref` to crop to one element, or omit it for the visible tab.

Do not start with raw HTML or a screenshot merely to discover ordinary controls. Screenshots may
return an inline image or a saved path depending on the deployment.

## Tabs and the Agent Window boundary

Write actions normally affect only Agent Window tabs.

- `browser_tab_list` lists `agent`, `user`, or `all` tabs visible to the owned session. Use
  `scope: "user"` to locate a user tab before borrowing it.
- `browser_tab_create` creates an Agent Window tab. It is active by default; set `active: false`
  for a background tab.
- `browser_tab_select` focuses an Agent Window tab.
- `browser_tab_close` closes an Agent Window tab.
- `browser_tab_borrow` moves a chosen user tab into the Agent Window before any write action.
- `browser_tab_return` returns a borrowed tab to its original window and position. Return it as
  soon as the immediate task is finished; stopping the session is only the fallback cleanup.

Use only a `tabId` returned by `browser_tab_list` or `browser_tab_create`. Do not assume a tab id
from page position or title.

## Navigation and lifecycle

- `browser_navigate` opens a URL and can wait for a requested lifecycle phase.
- `browser_navigate_back` and `browser_navigate_forward` move one history entry.
- `browser_reload` reloads the current tab; use `hard: true` only when bypassing cache is necessary.
- `browser_wait_for_navigation` waits for a lifecycle event after an action that did not already
  wait. Avoid speculative waits when no navigation is expected.

After navigation, history traversal, or reload, discard old refs and call `browser_observe` or
`browser_snapshot` again.

## Ask the user for browser help

Call `browser_request_help` for login, captcha, OTP, payment confirmation, consent, or another step
that requires the user. Give a clear `prompt`; when the prompt refers to a concrete control, pass
its fresh ref or selector in `targets` so the overlay can highlight it. Use `title` only when it
adds clarity.

Optional `completionCriteria` can finish the pause automatically when the page has an explicit,
stable success signal. It supports `any` or `all` conditions using `urlContains`, `urlMatches`,
`selectorExists`, `selectorMissing`, `textExists`, or `textMissing`, plus `stableForMs`.

```text
browser_request_help({
  session: sessionId,
  title: "Sign in required",
  prompt: "Complete sign-in, then return control after the account page appears.",
  targets: ["@e7"],
  timeoutMs: 300000,
  completionCriteria: {
    any: [{ urlContains: "/account" }, { selectorExists: "[data-testid='account-menu']" }],
    stableForMs: 1000
  }
})
```

Interpret outcomes deliberately:

- `continued` or `completed`: the user returned control or the explicit detector matched. Observe
  again before reasoning about the new state or using refs.
- `cancelled`: stop the requested flow.
- `timed_out`: report the timeout; do not repeatedly reopen the prompt.
- `disabled`: unattended mode does not allow help; proceed only if safe or stop gracefully.
- `navigated`: legacy outcome; do not treat navigation alone as proof of success.

## Debugging without page scripting

Use the read-only debugging tools only when relevant to the user's task:

- `browser_console` reads buffered console messages, browser logs, and JavaScript exceptions.
  Set `includeStack: true` when stack frames are useful.
- `browser_network` reads buffered response and failure metadata. It does not return request or
  response headers or bodies and does not modify traffic.

Both tools accept `tabId`, `since`, `limit`, and `maxTextChars`. Their result returns `nextSince`;
pass that value as the next `since` cursor instead of repeatedly requesting the same entries.

Arbitrary page script evaluation and interaction recording are intentionally unsupported in this
DeepSeek Harness plugin. Do not invent tool names or route around this limitation. If the task
strictly requires either capability, explain that it is not available in this phase.

## Window and device controls

- `browser_window_resize` changes the Agent Window's outer `width` and `height`; each dimension
  must be from 100 through 7680 CSS pixels.
- `browser_emulate` applies a built-in device preset or explicit viewport settings to the active
  tab. Explicit `width` and `height` must be supplied together. `mobile: true` also requires both
  dimensions. Use `off: true` alone to clear emulation. Emulation is per-tab and new tabs do not
  inherit it.

## Tool reference

### Sessions

| Tool | Purpose |
| --- | --- |
| `browser_session_start` | Start an owned Agent Window session, optionally with URL, size, browser instance, focus behavior, or device preset. |
| `browser_session_stop` | Stop an owned session and close its Agent Window. |
| `browser_session_list` | List owned sessions and identify the current one. |

### Navigation and reading

| Tool | Purpose |
| --- | --- |
| `browser_navigate` | Navigate the active tab to a URL. |
| `browser_navigate_back` | Go back one history entry. |
| `browser_navigate_forward` | Go forward one history entry. |
| `browser_reload` | Reload the active tab, optionally bypassing cache. |
| `browser_wait_for_navigation` | Wait for an expected page lifecycle event. |
| `browser_observe` | Read the primary semantic page representation with refs. |
| `browser_snapshot` | Read the static accessibility-tree fallback with refs. |
| `browser_get_html` | Read raw document or ref-scoped HTML as a last resort. |
| `browser_screenshot` | Capture the visible tab or a ref-cropped element. |

### Interaction

| Tool | Purpose |
| --- | --- |
| `browser_click` | Click a ref or CSS selector. |
| `browser_hover` | Hover a ref or selector to reveal conditional UI. |
| `browser_fill` | Fill a text-capable element. |
| `browser_select` | Select one or more option values. |
| `browser_press` | Send a keyboard key or combo. |

### Tabs

| Tool | Purpose |
| --- | --- |
| `browser_tab_list` | List visible user and Agent Window tabs. |
| `browser_tab_create` | Create an Agent Window tab. |
| `browser_tab_select` | Focus an Agent Window tab. |
| `browser_tab_close` | Close an Agent Window tab. |
| `browser_tab_borrow` | Move a user tab into the Agent Window. |
| `browser_tab_return` | Return a borrowed tab to its original window. |

### Assistance, diagnostics, and display

| Tool | Purpose |
| --- | --- |
| `browser_request_help` | Pause for an explicit user browser step. |
| `browser_console` | Read buffered console and exception entries. |
| `browser_network` | Read buffered response and failure metadata. |
| `browser_window_resize` | Resize the Agent Window. |
| `browser_emulate` | Apply or clear per-tab device emulation. |

## Error handling and final checklist

On a stale ref, observe again and retry once with a fresh ref. On a closed or unknown tab, list
tabs instead of guessing. On an unknown session, list owned sessions or start a new one; never try
foreign ids. On timeout, decide whether one longer, purposeful wait is justified. Avoid repeated
actions with unchanged state.

Before finishing a browser task, verify that:

- The user's observable goal is met, or the blocker is clearly reported.
- Any borrowed tab has been returned when practical.
- The owned session has been stopped unless the user explicitly asked to keep it open.
- No further page action is taken after success.
