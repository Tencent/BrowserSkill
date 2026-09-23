# Human help and recovery

With help enabled, use `browser_assist` action `request-help` for login, CAPTCHA,
OTP, payment confirmation, consent, or after two attempts without progress. Supply
a precise prompt and fresh targets; completion criteria need a stable success signal.
For URL completion, `urlMatches` accepts RE2-compatible regular expressions.
Patterns using backtracking-only features such as backreferences are rejected;
use `urlContains` when a substring is enough.
Resume only on `continued` / `completed`, then observe. Cancellation/timeout blocks
the step; do not repeat the request. Navigation alone is not success.

With help disabled, neither request help nor re-enable it. `disabled` grants no human
action or permission. Re-observe; use existing logins, authorized inputs and alternatives
within task/host rules. Vision models may try authorized graphical verification.
Phone-only QR scans, face verification, missing SMS codes and image-only tasks for
text-only models may stay blocked. Report missing inputs/capabilities or exhausted
alternatives; continue independent work. Never repeat unknown effects or switch
backends to bypass limits. Borrow confirmation still applies.

## Recover

- Unknown browser tool after plugin reload: invoke `skill` with `name: "browser-skill"`
  again (users can enter `/browser-skill`), then retry the intended browser tool once
  after its schema appears. If it remains unavailable, report the failure.
- Stale ref: observe, then retry the intended action once.
- Unknown tab/session: list owned resources or start a session with the required
  browser selector, if any; never guess IDs.
- Failed/interrupted stop: accepted cleanup continues in the background. Retry the
  same stop; completed cleanup returns `alreadyClosed: true`. For multiple pending
  stops, specify `session` or the owned `requestId` from the result/list/error,
  never both. The request ID identifies the original operation even if its short
  session ID is reused. Never switch sessions to retry cleanup.
- Timeout/unknown effect: inspect before retrying; the action may have happened.
- Unconfirmed fill: read the field. Formatting may satisfy the goal; correct only a
  remaining difference instead of blindly refilling or requesting help.
- Other errors: follow the hint; on unrecoverable failure, report and stop the owned session.
