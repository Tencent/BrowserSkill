---
name: browser-skill
description: Browser automation through six injected domain tools.
---

# browser-skill for DeepSeek Harness

Drive the user's logged-in Chromium in an Agent Window. User-window tabs remain protected unless
explicitly borrowed.

Use the loaded `action` schemas for `browser_session`, `browser_page`, `browser_inspect`,
`browser_interact`, `browser_tabs`, and `browser_assist`; do not guess parameters.
All browser work must use the injected tools directly to preserve ownership, cancellation,
attachments, observation UI, and cleanup. Do not invoke another process to control the browser.

## Mandatory workflow

Every task owns a bounded plugin session:

```text
browser_session({ action: "start", ... })
... use the returned sessionId for browser work ...
browser_session({ action: "stop", session: sessionId })
```

Pass the session when more than one exists; never guess or use another program's id. Stop on
success and failure unless asked to keep it open. Stopping also returns borrowed tabs.

## Work toward one observable goal

- Derive a concrete success condition from the user's request.
- Take the shortest purposeful path: observe, act, then make at most one observation to confirm an
  ambiguous result.
- Once success is visible, do not click, refresh, navigate, switch tabs, or perform extra checks.
- With help enabled, request help for human-only steps or after two attempts make no progress.
  With help disabled, use the autonomous handling rules below.

## Observe, act, observe

Use `browser_inspect` action `observe` as the primary semantic page view. It returns roles, states,
text, and `@eN` refs. Prefer fresh refs over raw selectors. Refs invalidate after navigation and may
also become stale after large DOM changes, so observe again before the next interaction.

Use `browser_interact` for click, hover, scroll-to, focus, blur, fill, select, press and wheel.
`scroll-to` reveals a target and returns its visible border-box bounds in top-level viewport CSS
pixels, clipped by ancestors. Partial visibility suffices; hidden/fully clipped targets fail.
This does not test occlusion. Use refs for iframe/shadow-root targets; selectors search the main document.

`wheel` takes signed `deltaX`/`deltaY` (one nonzero). Optional `target` is scrolled into view first;
otherwise input lands at the viewport centre. Results echo input, not completed scrolling; observe afterwards.

`focus`/`blur` enter or leave focus-triggered states. Hover-only surfaces appear as
`@e1 button "Products" [hover first: Shoes | Bags]`. Items are labels, not refs:
hover the trigger, observe, then use the revealed item's ref. Click the trigger only if its action is wanted.

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

Honor Automation settings. Never repeat denied or expired borrows; inspect tabs if the outcome is unknown.

## Ask the human when needed

With human help enabled, use `browser_assist` action `request-help` for login, captcha, OTP,
payment confirmation, consent, or other human steps. Give a precise prompt and fresh targets;
use completion criteria only for a stable success signal. Resume on continuation or completion;
cancellation and timeout block the step. Observe again before using refs.

With help disabled, task/host rules and borrow confirmation still apply; no new permission is granted.
`disabled` confirms no human action: re-observe, use existing login state and authorized
inputs, and continue. Where task/host rules allow, models with vision may attempt graphical
verification using screenshots and supported interactions. Phone-only QR scans, face verification,
unavailable SMS codes, and image-only CAPTCHAs for text-only models may remain blocked. Try viable
alternatives and verify results; block only for missing inputs/capability or exhausted options.
Do not repeat unknown effects, request help again, or switch backends. Continue independent work.

`browser_assist` also resizes the Agent Window or emulates a device for one tab.

## Debug and recover without wandering

Use `browser_inspect` console or network actions only for relevant, bounded, read-only diagnostics.
Continue from returned sequence cursors instead of rereading the same buffer.

- Stale ref: observe again and retry the intended action once.
- Unknown tab: list tabs instead of guessing.
- Unknown session: list owned sessions or start one; never try foreign ids.
- Timeout: inspect current state before deciding whether one longer purposeful wait is useful.
- Fill result unconfirmed: observe the field first; the page may have formatted the value. Continue
  if the visible result satisfies the user's intent. Otherwise correct the remaining difference;
  do not blindly repeat fill or immediately request human help. For other fill errors, follow the
  returned hint and inspect current state before retrying.
- Unrecoverable failure: report the blocker and stop the owned session.

Arbitrary page-script evaluation and interaction recording are intentionally unsupported. Do not
invent tools or route around those limits.
