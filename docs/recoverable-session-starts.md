# Recoverable browser session starts

Registering a browser session only after receiving a successful CLI result risks leaking an Agent Window that the caller can neither identify nor close when cancellation, a lost reply, or a host crash intervenes (issue #245). A second leak occurs if initial navigation fails and a compensating stop also fails before ownership is recorded.

## Lifecycle contract

Managed starts use a caller-generated request token before any browser side effect. A host wrapper can persist the token first, prepare the request on the daemon, and then start the session. The separate `session.start_tracked` RPC fails closed on an older daemon. A start without a prepared request also fails: a delayed CLI cannot recreate a cancelled window after a daemon restart.

The CLI flow is:

```text
bsk session request <token> --prepare --json
bsk session start --request-id <token> [window options] --json
bsk session request <token> --claim --json
bsk session request <token> --json
bsk session request <token> --cancel --json
```

A token is `<expiry-unix-ms>:<UUID>`, generated with a random UUID. Admission deadlines must be in the next ten minutes. Treat tokens as ownership handles: they are not labels, task names, or short session IDs. Ordinary `session start` remains unchanged and does not require these calls. Managed starts do not sync unrelated CLI harness skills.

Preparation creates no browser window. Start transitions from prepared to starting, then ready. Claim happens after the caller durably records the returned session and finishes initial navigation/emulation; it changes ready to active. A repeated start with the same token and parameters returns the existing result instead of opening another window; different parameters are rejected. Expired tokens cannot start again.

Cancellation is monotonic, including cancellation **before** prepare/start. An early cancellation leaves a terminal tombstone. Cancelling a starting operation preserves its original extension waiter until creation settles; a premature `session not found` cannot prove that a delayed `chrome.windows.create` has finished. These reservations are excluded from idle cleanup and ordinary stop until creation settles. The caller's wait remains bounded, while daemon-owned reconciliation may continue.

Cleanup failures retain the exact session/window identity and can be retried. The extension also retains a window whose startup compensation failed, so a later stop can actually close it. Cleanup uses the request's original session identity and verifies that a reused short session ID does not belong to another window.

The extension captures the initial tab IDs directly from window creation, before initialization or cancellation can fail. Those IDs remain owned throughout failed compensation and subsequent stops. Retry closes only agent-created tabs; later user tabs are preserved. If an agent tab cannot close beside a user tab, stop reports a cleanup failure and retains the session binding instead of releasing a leaking window.

The existing daemon reaper cancels unclaimed requests after their admission deadline (normally within the next 30-second tick), retries failed cleanup, and removes expired terminal tombstones. Claimed sessions retain the existing session idle policy. Browser disconnection still follows the existing session teardown behavior. An unresponsive browser can delay confirmed cleanup; that state remains owned and visible as pending rather than being reported as closed.

CLI and daemon must both support the request protocol. Preparation detects unsupported versions before opening a window. Update the extension as well to obtain retryable startup-compensation failures. No persistent daemon service, external database, or new package dependency is introduced.

## Regression coverage

- Daemon: cancellation before prepare/start; expired tokens and tombstone collection; restart admission; unclaimed vs. claimed leases; reused short IDs; concurrent duplicate requests; delayed creation beyond the old cancellation grace; retryable close failures; foreign session isolation.
- Integration: actual CLI child killed after dispatch and before its successful response, followed by recovery through a new CLI process. IPC and WebSocket tests use a real daemon and a controlled extension peer, without operating the user's browser.
- Extension: the production stop handler retries failed startup compensation, closes initial agent tabs, preserves later user tabs, and retains mixed-window ownership when an agent tab still cannot close.

These checks complement the existing session, cancellation, and extension tests.
