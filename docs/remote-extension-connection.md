# Connecting an extension through an authenticated gateway

This opt-in extension mode addresses the browser-side connection portion of
[issue #50](https://github.com/Tencent/BrowserSkill/issues/50). The default remains
the local daemon and its configurable port. This does not expose the daemon to
the internet or implement a remote CLI server.

Open the extension popup, expand **Remote connection**, and paste a gateway-issued
pairing link:

```text
wss://gateway.example/browser/extension#<base64url-credential>
```

The destination is shown before saving. Saving uses the existing connection
controller: finish session cleanup and return borrowed tabs before switching the
transport. If cleanup fails, the controller retains the failure rather than
silently abandoning borrowed tabs. **Use local daemon** removes the remote
preference and goes through the same cleanup path.

## Gateway authorization contract

This consumer patch adds a proposed HTTP exchange before the native handshake.
Saving a pairing link sends POST to the WebSocket path plus `/authorize` (HTTPS
for WSS), using `Authorization: Bearer <pairing-token>` and JSON
`{ "action": "pair", "next_token": "<client-generated-256-bit-token>", "label": "Chrome · BrowserSkill" }`.
The gateway atomically consumes the one-use pairing token and returns
`device_id`, `expires_at` and `renew_after` (ISO date strings), plus an optional
`service_name` used for the visible task-group label (up to 48 characters; defaults
to BrowserSkill). It stores only a
hash of the next token. HTTP redirects are rejected; cookies are omitted.

The extension stores device metadata and its token in trusted extension-local
storage. At renewal time it persists a candidate token, then uses the same
endpoint with action `renew` and the current device token as Bearer authorization.
The gateway must handle repeated old/new token pairs idempotently, allowing a
lost response to be retried after restart. The consumer gateway uses a 5-minute
pairing lifetime, 90-day device lifetime and renewal after 30 days. First-time
activation response loss requires a new pairing link. Renewal of the same device
does not tear down active sessions.

## WebSocket contract

- The extension strips the fragment before opening the WebSocket. It offers one
  subprotocol, `bsk-auth.<credential>`. The credential must be 32–256 base64url
  characters. A gateway must validate it before forwarding any browser traffic,
  and select the offered subprotocol when accepting the WebSocket.
- Non-loopback connections require WSS. Query parameters and URL userinfo are
  rejected. Do not log WebSocket subprotocol headers: this is a bearer credential.
- After upgrade, the first application frame remains `system.handshake`. Native
  BrowserSkill automation RPC methods and payloads remain unchanged. Forward the native handshake and
  frames to the authorized daemon connection without the credential subprotocol.
- Authenticate and isolate each user's daemon/routing context. The BrowserSkill
  compatibility handshake is not account authentication.
- Expiry and revocation are gateway responsibilities; renewal follows the HTTP contract above. Close an existing
  connection on revocation. Never replay commands on reconnect.
- A token authorizes the server to create and operate background task tabs. Existing
  user tabs still use BrowserSkill's original borrow confirmation and return flow.

The stored remote endpoint uses `chrome.storage.local`, not sync storage. The
popup displays the server URL, not the saved credential. A configured remote
connection never silently falls back to localhost after a transport failure.

For local gateway development only, `ws://127.0.0.1`, `ws://localhost`, and
`ws://[::1]` are accepted. This exception does not allow plaintext LAN endpoints.

## Validation

The extension tests cover unsafe endpoint rejection, credential destination
binding, out-of-order storage reads and disposal. Existing controller tests cover
session teardown and reconnect generations. An integration consumer additionally
tested a released v0.2.1 daemon and the built extension in isolated Chromium:
popup pairing, session start, navigation, Chinese text input, click, snapshot,
screenshot, pause/resume and session stop. The gateway is external to this patch.

The subprotocol convention is proposed for upstream review; it is not an existing
published BrowserSkill remote-auth standard.

## Optional gateway UI messages

The extension intercepts `gateway.task_focus` and `gateway.task_preview` before
native transport dispatch. These are proposed optional gateway messages, not
published native BrowserSkill RPCs. Both require an existing `session_id` from
the authenticated gateway's own task mapping. Focus locates that task's current
tab; it cannot start or resume a task or select an arbitrary browser tab.
Preview is described below. A gateway should expose focus only as a user action.

## Remote task tabs and preview

Remote gateway sessions use background task tabs in an existing non-incognito
Chrome window, grouped and labeled for the integration. The local-daemon mode
retains dedicated Agent Windows. Tab groups are visual only: explicit created
and borrowed tab IDs define ownership. A shared window is never a permission
boundary for remote tasks; other sessions' tabs remain invisible and even passive
page reads require an owned/borrowed tab. Existing tabs are borrowed in place
after the original confirmation, then released without moving or closing them.
Stopping a remote task closes only its created tabs, never the shared user window.

Logical task-tab selection does not activate Chrome's visible tab. Remote human
help and borrow requests preserve the original confirmation/notification UI but
do not proactively focus a window. Explicit user notification clicks and the
consumer's `gateway.task_focus` message can locate the task tab.

The optional `gateway.task_preview` UI message captures the authorized task tab through
CDP outside the automation queue. It returns a JPEG (`image_base64`, `format`,
`tab_id`, `title`, `captured_at`); final bitmap width is limited to 640 pixels,
including on HiDPI screens. Concurrent captures for the same task are coalesced.
The gateway consumer should rate-limit, authenticate, and scope preview requests,
and the viewer should stop requesting images while hidden. This is low-frame-rate
preview, not a video streaming API. Both UI messages are optional gateway
proposals and must not be represented as published native BrowserSkill RPCs.

Validation includes task-tab ownership/cleanup, rejected unapproved reads,
borrowing without moving user tabs, non-focusing human help, preview capture
coalescing/HiDPI bounds, and an external integration test using the released
v0.2.1 daemon plus headed Chromium. No cloud gateway implementation is shipped
in this repository.
