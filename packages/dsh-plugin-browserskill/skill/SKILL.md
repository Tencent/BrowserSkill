---
name: browser-skill
description: Browser automation through six injected domain tools.
---

# browser-skill for DeepSeek Harness

All browser work must use the injected tools directly, in an Agent Window with existing logins.
Use loaded schemas; never control through another process.

## Mandatory workflow

1. Define success. Start a session and retain `sessionId`. Navigate using `browser_page(action: "navigate", session, url)`, then `browser_inspect(action: "observe", session)`.

2. Borrow existing user tabs. Use returned IDs/refs, never foreign IDs. Pass `session` if multiple exist.
3. Observe after page changes; check ambiguous results once. Stop acting when success
   is visible. On success or failure, call
   `browser_session({ action: "stop", session: "<id>" })` unless keeping the session
   open is part of the user's request. Stopping returns borrowed tabs, leaving them
   open in the user's window.

## Read and interact

Use `observe` for text/refs, `snapshot` for static accessibility, `html` for markup, `screenshot` for visuals. Console/network reads use sequence cursors. Wait only for expected navigation.

Refs invalidate after navigation; observe again after DOM changes.
Prefer refs for frames/shadow roots; selectors search the main document. Observe before acting on HTML/screenshot findings.
Select options by value, not visible label.

- Hover markers like `[hover first: Shoes | Bags]` list labels, not refs. Hover the
  trigger, observe, then use the item's ref. Click the trigger only if its action is wanted.
- `scroll-to` returns ancestor-clipped bounds in top-level viewport CSS pixels.
  Partial visibility suffices; hidden/fully clipped targets fail. It does not test occlusion.
- `wheel` uses signed `deltaX`/`deltaY`, at least one nonzero. Optional `target` is
  scrolled into view first; otherwise it uses the viewport centre. It reports input,
  not scrolling success: observe afterwards. Focus/blur change focus states.

## Borrowing and human help

List IDs with `browser_tabs`; borrow only for the immediate step and return promptly. Browser Automation settings
govern confirmation and help; never change them to bypass a prompt or repeat
pending/denied/expired borrows. Inspect unknown outcomes; follow version-error hints.
Remote reads/actions require task-created or borrowed tabs; popups gain no control.
Unowned Agent Window tabs need a user move to a user window before borrowing.

With help enabled, use `browser_assist` action `request-help` for login, CAPTCHA,
OTP, payment confirmation, consent, or after two attempts without progress. Supply
precise prompts, fresh targets and stable success criteria.
Resume only on `continued` / `completed`, then observe. Cancellation/timeout blocks
the step; do not repeat the request. Navigation alone is not success.
`browser_assist` also resizes windows or emulates a device for one tab.

With help disabled, do not request help or re-enable it. `disabled` confirms no human
action or new permission. Re-observe; use existing logins, authorized inputs and
viable alternatives within task/host rules. Vision models may try graphical
verification where authorized. Phone-only QR scans, face verification, missing SMS
codes or image-only tasks for text-only models may remain blocked. Report missing
inputs/capabilities or exhausted alternatives; continue independent work. Never repeat
unknown effects or switch backends to bypass limits. Borrow confirmation still applies.

## Recover

- Stale ref: observe, then retry the intended action once.
- Unknown tab/session: list owned resources or start a session; never guess IDs.
- Failed or interrupted session stop: accepted cleanup continues in the background.
  Retry the same stop; a completed previous stop returns `alreadyClosed: true`.
  If several stops are pending, specify `session` or the owned `requestId` from the
  result/list/error (not both). A request ID targets the original operation even if
  the short session ID is reused. Never switch to another session just to retry cleanup.
- Timeout/unknown effect: inspect before retrying; the action may have happened.
- Unconfirmed fill: read the field. Formatting may satisfy the goal; correct only a
  remaining difference instead of blindly refilling or requesting help.
- Other errors: follow the hint; on unrecoverable failure, report and stop the owned session.

Arbitrary page-script evaluation and interaction recording are intentionally unsupported.
Do not invent tools or bypass these limits.

## Canvas

`@eN canvas [visual:screenshot]` is text, not an image. Screenshot the ref when needed; never infer
Canvas names/controls from nearby labels. If images cannot be understood, ask for
an image-capable model and continue with available semantics.

```text
browser_inspect({ action: "screenshot", session: "<id>", ref: "@e3" })
browser_interact({ action: "click", session: "<id>", target: "@e3", captureId: "<capture-id>", imageX: 100, imageY: 50 })
```

Use captureId with ORIGINAL PNG coordinates. Captures expire after use, 2m, ref replacement or a newer screenshot. `captureUnavailable` means
view-only: observe and screenshot again before clicking. Counts 1/2 and buttons/
modifiers work; Canvas fill/IME/drag/hover/HTML do not. Repainting is allowed; verify
results and use DOM refs for revealed controls. Inspect `effect_state=unknown`
before retrying with a new capture.

With `maxTokens`, continue via `nextCursor`/`cursor`. Each page replaces refs: use them before continuing, never
reuse old ones. Continuation reads the same capture without refresh/depth changes;
new observe/snapshot or changed page identity invalidates it.

## Website debugging

`browser_inspect(action: "debug", session, debugAction)`: read `capabilities` for
limits/filters (default 64 KiB); `start` before reproduction.
List `operations`/`requests`; read `operation`/`request` by `id`, `part: "response"`
for bodies. Missing is unknown; HTTP 200 is not success.
Follow `next_since`/`next_offset`; inspect `output.omitted`, `run.storage`, `run.coverage`.
`pin`/`unpin` protect completed requests from capacity eviction, not expiry.
`stop` saves; `export` to a new `output` file.
`activity` gives command ID; `wait`: completion, not success; never resends/cancels.

`performance`: navigation/paint/CLS/long tasks; check states/reasons/visibility.
`aggregate`: method/path, P95/errors/slow counts. `duplicates`: suspected equal
URL/body/document bursts; retries may be valid. Both default to business traffic;
`includeControlled` adds rules/replays. Inspect request IDs/gaps; paginate with
`offset`/`next_offset` after stopping.

Authorized `rule_add` takes JSON-string `rule` (schema): one Fetch/XHR match by
default, first wins. `rules` lists state; `rule_enable`/`rule_disable`/`rule_remove` take `id`.
Capture end clears rules. `replay`: source `id`, JSON-string `replay` with `key`.
May write server data; reuse the key on uncertain retries. Same-origin,
current cookies; replace missing/redacted values. No UI update. Controls require
active capture; history retains provenance.
