---
name: browser-skill
description: Browser automation through six injected domain tools.
---

# browser-skill for DeepSeek Harness

Drive the user's logged-in Chromium through this plugin's structured browser tools. Automation is
isolated in an Agent Window; user-window tabs remain protected unless explicitly borrowed.

Loading this skill reveals six tools for the rest of the conversation:

- `browser_session` owns session lifecycle.
- `browser_page` handles navigation and lifecycle waits.
- `browser_inspect` reads semantic, visual, console, and network state.
- `browser_interact` performs normal page interactions.
- `browser_tabs` manages Agent Window tabs and temporary user-tab borrowing.
- `browser_assist` handles human help, window size, and device emulation.

Every call includes an `action`. Treat each loaded tool schema as authoritative for its actions and
parameters; do not guess fields. All browser work must use the injected tools directly so session
ownership, cancellation, attachments, observation UI, and cleanup remain intact. Do not invoke
another process to control the browser.

## Mandatory workflow

Every task owns a bounded plugin session:

```text
browser_session({ action: "start", ... })
... use the returned sessionId for browser work ...
browser_session({ action: "stop", session: sessionId })
```

Pass the session explicitly when more than one exists. Never guess or reuse an id owned by another
program. Stop in a finally-style path on success and failure unless the user explicitly asks to keep
the session open. Stopping also returns borrowed tabs.

## Work toward one observable goal

- Derive a concrete success condition from the user's request.
- Take the shortest purposeful path: observe, act, then make at most one observation to confirm an
  ambiguous result.
- Once success is visible, do not click, refresh, navigate, switch tabs, or perform extra checks.
- If a human-only step appears or two attempts make no progress, request help instead of
  brute-forcing.

## Observe, act, observe

Use `browser_inspect` action `observe` as the primary semantic page view. It returns roles, states,
text, and `@eN` refs. Prefer fresh refs over raw selectors. Refs invalidate after navigation and may
also become stale after large DOM changes, so observe again before the next interaction.

Use `browser_interact` for click, hover, fill, select, and key actions. An observation marks a
hover-only surface as `@e1 button "Products" [hover first: Shoes | Bags]`. The listed items are
labels, not usable refs: hover the trigger, observe again, then act on the revealed item's own ref.
Do not click the trigger itself unless the user wants the trigger's action.

Escalate reading only as needed:

1. `observe` for normal understanding and interaction refs.
2. `snapshot` when a stricter static accessibility tree is more useful.
3. `html` for exact markup or hidden metadata that semantic views cannot provide.
4. `screenshot` for layout, styling, canvas, images, or requested visual evidence.

Do not start with raw HTML or screenshots merely to discover ordinary controls. When interaction is
needed, obtain a fresh observation before acting on screenshot or HTML findings.

Use `browser_page` for purposeful navigation, history, reload, or a lifecycle wait. Avoid speculative
waits when no navigation is expected. After any page change, discard old refs and observe again.

## Respect the Agent Window boundary

Use `browser_tabs` to list returned tab ids before selecting, closing, borrowing, or returning tabs.
Borrow a user tab only for the immediate task, and return it as soon as that step is complete. Never
invent a tab id or keep a personal tab borrowed across unrelated work.

## Ask the human when needed

Use `browser_assist` action `request-help` for login, captcha, OTP, payment confirmation, consent, or
another step the user must complete. Give a precise prompt and highlight fresh targets when concrete
controls are involved. Use completion criteria only for a clear stable success signal.

Resume only after the user continues or the criteria complete. Treat cancellation as rejection and
timeout as a blocker rather than retrying. Observe again after control returns before reasoning about
the new state or using refs.

The same tool can resize the Agent Window or emulate a device when the task requires visual or
responsive testing. Emulation is scoped to one tab.

## Debug and recover without wandering

Use `browser_inspect` console or network actions only for relevant, bounded, read-only diagnostics.
Continue from returned sequence cursors instead of rereading the same buffer.

- Stale ref: observe again and retry the intended action once.
- Unknown tab: list tabs instead of guessing.
- Unknown session: list owned sessions or start one; never try foreign ids.
- Timeout: inspect current state before deciding whether one longer purposeful wait is useful.
- Unrecoverable failure: report the blocker and stop the owned session.

Arbitrary page-script evaluation and interaction recording are intentionally unsupported. Do not
invent tools or route around those limits.
