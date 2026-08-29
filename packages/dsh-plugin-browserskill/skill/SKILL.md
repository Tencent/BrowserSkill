---
name: browser-skill
description: Browser automation through six injected domain tools.
---

# browser-skill for DeepSeek Harness

Drive the user's real Chromium browser through the six structured domain tools provided by this
plugin. The browser keeps the user's existing logins and cookies while isolating automation in an
Agent Window. Every call must include the tool's `action` field; other fields depend on that action.

## Tool availability

Loading this skill reveals the browser tools for the rest of the conversation. All browser work
must use the injected tools directly. Do not invoke another process to control the browser. Direct
tool calls preserve session ownership, the live observation window, cancellation, attachments, and
cleanup.

The six tools are:

- `browser_session`: start, stop, or list plugin-owned sessions.
- `browser_page`: navigate, back, forward, reload, or wait for navigation.
- `browser_inspect`: observe, snapshot, html, screenshot, console, or network.
- `browser_interact`: click, hover, fill, select, or press.
- `browser_tabs`: list, create, select, close, borrow, or return tabs.
- `browser_assist`: resize the Agent Window, emulate a device, or request help from the user.

## Mandatory workflow

Every browser task follows this lifecycle:

1. Call `browser_session` with `action: "start"` and retain its returned `sessionId`.
2. Use that session for every later call. Pass `session` explicitly when more than one exists.
3. Call `browser_session` with `action: "stop"` when the goal is reached or an error ends the task.
   Treat cleanup like a finally path unless the user explicitly asks to keep the session open.

Conceptual sequence:

```text
browser_session({ action: "start", url: "https://example.com" })
browser_inspect({ action: "observe", session: sessionId })
browser_interact({ action: "click", session: sessionId, target: "@e4" })
browser_inspect({ action: "observe", session: sessionId })
browser_session({ action: "stop", session: sessionId })
```

The plugin owns only sessions it starts. Never guess or reuse a session id from another program.
When `session` is omitted, most actions use the current owned session, but explicit ids are safer.

## Stop when the goal is met

Browser work is bounded. Define an observable success condition, take the shortest path, and stop
as soon as success is visible. Do not refresh or click after success. If an action fails twice
without progress, pause instead of brute-forcing. If state is ambiguous, make at most one fresh
observation and then ask the user.

## Observe and interact

Use `browser_inspect` with `action: "observe"` as the primary semantic page view. It returns roles,
states, text, and `@eN` refs. Use `action: "snapshot"` when a static accessibility tree is more useful.
Prefer a fresh ref over a raw CSS selector for interactions.

Refs invalidate after navigation and may become stale after large DOM changes. Observe again after
navigation or a meaningful DOM update before using another ref. If an observation identifies a
hover-triggered surface, hover the trigger, observe again, then interact with the revealed control.

Use `browser_interact` as follows:

- `action: "click"`: requires `target`; optionally accepts `button` and `clickCount`.
- `action: "hover"`: requires `target`; optionally accepts `modifiers`, `settleMs`, and `timeoutMs`.
- `action: "fill"`: requires `target` and `value`; `noClear` appends instead of replacing.
- `action: "select"`: requires `target` and a non-empty `values` array. Values are option value
  attributes, not necessarily the visible labels.
- `action: "press"`: requires `key`; optionally focus `target` first and set `holdMs`.

## Navigate and wait

Use `browser_page` with these actions:

- `navigate` requires `url` and optionally accepts `waitUntil` and `timeoutMs`.
- `back` and `forward` move one history entry and optionally accept lifecycle wait fields.
- `reload` refreshes the current tab; set `hard: true` only when bypassing cache is necessary.
- `wait` waits for an expected navigation after an interaction that did not already wait.

Avoid speculative waits when no navigation is expected. After any page change, discard old refs and
observe again.

## Reading priority

Escalate page reading only as needed:

1. `browser_inspect` with `action: "observe"` for normal understanding and refs.
2. The same tool with `action: "snapshot"` for a stricter static tree.
3. `action: "html"` for exact markup that semantic views cannot provide; keep `maxBytes` bounded and
   use only a fresh ref when scoping a subtree.
4. `action: "screenshot"` for layout, styling, canvas, or genuinely visual evidence. A fresh `ref`
   crops to an element; omit it for the visible tab.

Do not start with raw HTML or a screenshot merely to discover ordinary controls.

## Tabs and the Agent Window boundary

Use `browser_tabs` with these actions:

- `list` returns visible tabs; `scope: "user"` finds a user tab before borrowing.
- `create` makes an Agent Window tab and optionally accepts `url`, `active`, and `index`.
- `select` focuses an Agent Window tab and requires a returned `tabId`.
- `close` closes an Agent Window tab and requires a returned `tabId`.
- `borrow` moves a user tab into the Agent Window and requires a listed user `tabId`.
- `return` restores a borrowed tab and requires that borrowed `tabId`.

Return borrowed tabs as soon as the immediate task finishes. Stopping the session is only fallback
cleanup. Never invent a tab id.

## Human help and display controls

Use `browser_assist` with `action: "request-help"` for login, captcha, OTP, payment confirmation,
consent, or another human-only step. `prompt` is required. Optional `targets` highlight fresh refs or
selectors. `completionCriteria` can detect explicit stable success through URL, selector, or text
conditions. After the user continues or criteria complete, observe again before reasoning about the
new state.

Use `action: "resize"` with `width` and `height` to resize the outer Agent Window. Use
`action: "emulate"` with a device preset or explicit width and height; `mobile: true` also requires
dimensions. Use `off: true` alone to clear emulation. Emulation is per tab.

## Read-only diagnostics

Use `browser_inspect` with `action: "console"` for buffered logs and exceptions, and
`action: "network"` for response and failure metadata. Both accept `tabId`, `since`, `limit`, and
`maxTextChars`; continue with the returned sequence cursor rather than rereading the same entries.
Console additionally accepts `includeStack`.

Arbitrary page script evaluation and interaction recording are intentionally unsupported. Do not
invent tool names or route around that limitation.

## Error handling and final checklist

On a stale ref, observe again and retry once. On an unknown tab, list tabs instead of guessing. On
an unknown session, list owned sessions or start one; never try foreign ids. On timeout, decide
whether one longer purposeful wait is justified, and never immediately repeat a failed history
action without first checking page state.

Before finishing, verify that the observable goal is met or the blocker is clear, borrowed tabs are
returned when practical, the owned session is stopped, and no extra page action occurs after
success.
