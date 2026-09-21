# Remote browser connections

An Agent can run on a server while the BrowserSkill extension controls a browser on the user's computer. The extension initiates an outbound connection; the user's computer needs no inbound port. Tasks continue to use separate Agent Windows, including the existing borrow-and-return flow for user tabs.

`bsk` includes device pairing, connection authentication, credential renewal and revocation. No account system or authentication gateway is required. Alternatively, the extension can pair with a third-party gateway implementing the protocol below.

If a server is already configured or you have a pairing link, go to
[Pair and verify](#pair-and-verify). The browser computer needs only the extension;
the Agent, CLI and daemon belong on the server.

## Local mode

The existing local workflow remains the default:

```sh
bsk daemon start
# Equivalent: bsk daemon start --mode local
```

It listens on loopback. Existing CLI commands and extension port settings continue to work. Select **Local connection** in the extension to leave a remote connection; this ends its current tasks.

## Standalone server

Run the Agent, CLI and daemon under the same OS user on the server. Automation commands continue to use the existing local IPC socket; the public listener accepts only authenticated extension connections and credential exchanges.

Confirm server access, a browser-reachable public hostname/port, and trusted
certificate paths or an existing [TLS reverse proxy](#tls-reverse-proxy). If any
prerequisite is missing, tell the user what is needed before attempting deployment.

With a certificate and private key for `browser.example.com`:

```sh
bsk daemon start --mode server \
  --listen 0.0.0.0 --port 52800 \
  --public-url wss://browser.example.com:52800/extension \
  --tls-cert /etc/bsk/fullchain.pem \
  --tls-key /etc/bsk/privkey.pem
```

Use a certificate trusted by the user's browser. The certificate's hostname must match the public URL. `bsk` does not issue certificates or modify browser trust settings. Server mode stays in the foreground and does not exit when idle; a process supervisor can manage it. Certificate changes require a restart with the same flags. Session idle limits still apply. The server does not automatically update or restart itself.

Set `BSK_AUTO_START=0` in the Agent environment so a stopped managed server is reported as unavailable. Keep `BSK_HOME` consistent between the daemon and its CLI clients. Persist this private directory across service restarts and container replacements: it contains device grants and local IPC metadata. Do not share it between independent running servers or untrusted OS users.

Once the server is configured, follow [Pair and verify](#pair-and-verify).
Each paired device receives its own stable browser identity; it cannot select
another device's identity through its handshake.

Manage grants from the server's local CLI:

```sh
bsk daemon devices
bsk daemon revoke DEVICE_ID
bsk daemon revoke --all
```

`devices` includes device and browser IDs, label and expiration, never credentials. `revoke --all` also invalidates unused pairing links. Revocation closes existing connections as well as rejecting new ones. Active and idle connections check persisted grants on a one-second polling interval; message handling only checks in-memory cancellation state. Disk checks run outside the asynchronous executor and read atomically published snapshots without acquiring the writer lock. A failed grant read closes the connection. Authorization writes wait at most 500 ms for the writer lock; contention returns a retryable HTTP 503 instead of invalidating a valid connection. Revocation normally takes effect on the next check, subject to scheduling and storage latency; actions already performed on a page cannot be undone.

Defaults are configurable at server startup:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--pairing-ttl` | `5m` | One-use pairing lifetime, at most one hour |
| `--device-ttl` | `90d` | Device lifetime from pairing or successful renewal, at most 366 days |
| `--renew-after` | `30d` | Time before the extension should renew; must be less than device lifetime |
| `--max-connections` | `64` | Online browser capacity, between 1 and 1000; existing devices can replace their connections at capacity |
| `--authorize-rate-limit` | `60` | Pairing/renewal requests per minute per peer IP, between 1 and 60000 |

Browser connections use separate capacity from pairing and renewal requests. A new browser exceeding the configured capacity receives HTTP 503 with `Retry-After`. The server also bounds concurrent TCP/TLS/HTTP setup to 64 connections; overload at that earlier stage drops new connections and emits a rate-limited warning. Ordinary HTTP responses close their connections so idle keep-alive clients cannot retain setup capacity.

Authorization exchanges return HTTP 429 with `Retry-After` when rate-limited. The server retains at most 1024 peer counters; additional peers share a bounded overflow allowance instead of evicting existing counters. A global budget of 16 times the configured per-peer rate limits total exchange requests. These limits bound work, but do not guarantee availability during a sustained distributed attack.

The extension checks for renewal on startup and periodically while a remote connection is selected. Local mode has no renewal alarm. The popup shows the authorization expiry and reports renewal failures or a need to pair again. Temporary failures preserve the current credential and retry no more than once per minute. If it remains offline past expiration, create a new pairing link. A renewal rotates the credential; its pending replacement is persisted before the request so a lost response can be retried after a service-worker or server restart, even if the old locally recorded expiry has passed. The popup distinguishes that unconfirmed renewal from a known expired grant. Changing lifetime flags affects subsequent exchanges, not grants already issued.

## TLS reverse proxy

A conventional TLS reverse proxy can terminate HTTPS/WSS without implementing authentication:

```sh
bsk daemon start --mode server --listen 127.0.0.1 --port 52800 \
  --public-url wss://browser.example.com/extension
```

Forward both `/extension` and `/extension/authorize` to `127.0.0.1:52800`, preserving the path and WebSocket upgrade headers. Preserve `Origin`, `Authorization` and `Sec-WebSocket-Protocol`. Never log authorization headers, WebSocket subprotocol values or request bodies. Do not pass credentials in query strings. The built-in server remains responsible for authentication; proxy-injected user headers do not bypass it.

Behind a reverse proxy, the server sees the proxy's IP, so its per-peer authorization rate is shared by the proxied clients. Configure per-client rate limits at the proxy and size `--authorize-rate-limit` for the expected aggregate traffic. The server does not trust `X-Forwarded-For` or other client-IP headers.

Without native TLS, the listener must be on loopback. Plain `ws://` public URLs are allowed only for loopback development. Non-loopback browser connections require WSS. Changing the configured public URL requires revoking existing grants and generating new pairing links.

## Pair and verify

1. **Server operator:** if a pairing link has not been provided, generate one when
   the browser user is ready. In another server shell, use the daemon's OS user and
   `BSK_HOME` for this and all subsequent CLI commands:

   ```sh
   BSK_AUTO_START=0 bsk daemon pair
   ```

2. **Browser user:** [install the extension](../AGENT_INSTALL.md#4-connect-the-browser-extension)
   if needed. Open its popup, select **Remote connection**, paste the complete
   pairing link and save it. The link
   is secret, single-use and expires after five minutes by default. Saving it
   switches the connection and ends existing tasks. The extension replaces the
   pairing secret with a device credential; wait for its connected status.

3. **Agent on the server:** confirm the intended browser appears in:

   ```sh
   BSK_AUTO_START=0 bsk status --json
   ```

   A generated link or a saved pairing alone is not proof of an active connection.
   If the Agent cannot access the server, report server-side verification as pending.

4. **Verify first use:** for CLI agents, use the browser's `instance_id` from
   `status` as `<browser-id>` and retain the returned `session_id`:

   ```sh
   BSK_AUTO_START=0 bsk session start --browser <browser-id> --no-focus --json
   ```

   Replace `<id>` below with that session ID. Read a page and stop the test session
   on success or failure; report any cleanup error:

   ```sh
   BSK_AUTO_START=0 bsk navigate https://example.com --session <id>
   BSK_AUTO_START=0 bsk observe --session <id>
   BSK_AUTO_START=0 bsk session stop <id>
   ```

   With DSH, perform the same start, navigate, observe and stop lifecycle through
   its injected browser tools. Server setup and pairing remain operator steps.

Report only the stage verified by evidence:

| Evidence | Feedback to the user |
| --- | --- |
| Pairing link generated | Link ready; waiting for browser pairing. |
| Server lists the intended connected browser | Browser connected; first-use verification pending. |
| Page read and test session stopped successfully | Remote first-use verification complete. |
| A step failed or could not be checked | State the last verified stage, the observed error or missing access, and the next action. |

For an expired or already-used link, obtain a fresh one from the server operator.
For other connection failures, follow the popup error and check endpoint/TLS/proxy
configuration; do not assume that every failure means the link has expired.

## Third-party gateway protocol

The extension uses the same protocol whether it connects to `bsk` or a compatible gateway. It does not call provider-specific login APIs. The gateway may use any account or management system to issue its pairing links, but must implement this browser-facing contract:

1. A pairing link is `wss://HOST/PATH#PAIRING_SECRET`. Its fragment contains 32–256 base64url characters and is removed before any network request.
2. The extension POSTs to `https://HOST/PATH/authorize` with `Authorization: Bearer PAIRING_SECRET` and JSON `{ "action": "pair", "next_token": "…", "label": "…" }`. `next_token` is a new random 256-bit, unpadded base64url credential (43 characters). Consume the pairing secret once and bind the replacement to one device. Pairing secrets cannot open a WebSocket.
3. Return HTTP 200 with `{ "device_id": "32 lowercase hex characters", "expires_at": "RFC3339 timestamp", "renew_after": "RFC3339 timestamp", "service_name": "optional display name" }`. Invalid or unauthorized exchanges fail with a non-2xx response. The extension refuses redirects and sends no cookies.
4. WebSocket upgrades to `wss://HOST/PATH` authenticate with exactly one `Sec-WebSocket-Protocol: bsk-auth.DEVICE_TOKEN`. Validate before upgrading and echo the selected subprotocol. A browser-shaped Origin alone is never authorization. Credentials belong to the specific endpoint and cannot authorize another device or deployment.
5. Renewal uses the same POST endpoint and the current token, with `action: "renew"` and a new `next_token`. Keep the same `device_id`. Invalidate the old credential for new connections. An exact retry of the same old/new pair returns the original successful response; the old credential must not rotate to a different replacement. Revocation invalidates retries too. An already connected socket can remain open during renewal while its device grant is valid.
6. After upgrade, support the existing native handshake and RPC frames. Bind all RPC routing, responses, events and session state to the authenticated device. Do not trust its self-reported browser ID as authorization to another device's tasks. Close active sockets on expiration or revocation and cancel their pending work.

### Optional UI channel

A gateway that renders its own view of a running task can send two extra request frames on the authenticated socket. The extension answers them outside the tool queue, so they still work while the session is navigating or waiting for `request_help`, and neither one ever starts a session:

```json
{"id":"ui-1","method":"ui.task_preview","params":{"session_id":"server-owned-session"}}
```

- `ui.task_preview` returns `image_base64`, `format: "jpeg"`, `tab_id`, `title` and `captured_at`. The encoded frame is at most 640 pixels wide. Captures are coalesced per task, at most one runs per tab, and a poll that arrives while Chrome still holds one is refused rather than queued behind it. Authorization, the document revision and the debugger identity are re-checked before a frame is returned. These frames keep the extension's control and help overlays visible, so a periodic preview does not make them flicker in the user's browser; tool screenshots continue to suppress them for unobstructed page content.
- `ui.task_focus` activates the task's own tab and raises its window, returning `{ "focused": true }`.

Both are restricted to an existing remote task's owned tab in its Agent Window. Window membership alone never qualifies. The target's ownership and actual window are checked before acquiring control and again before delivering a frame or continuing focus. These checks also reject a tab moved by the browser user; Chrome calls cannot be made atomic with external user actions.

The channel exists only on authenticated remote sockets. Requests require nonempty string `id` and `session_id` values, matching the native RPC ID contract. A missing, null, empty or numeric request ID is consumed without a reply or browser work. An invalid session ID receives `invalid_params`. Success uses `{ "id": "…", "result": … }`; failure uses `{ "id": "…", "error": { "code": "…", "message": "…", "data": { "reason": "…" } } }`, with `data` optional for underlying failures.

| Failure | Code | Reason |
| --- | --- | --- |
| Task or authorized target unavailable | `not_found` | `task_unavailable` / `target_unavailable` |
| Whole preview or focus request exceeds 3 seconds | `timeout` | `ui_deadline` |
| Previous screenshot still running on this attachment | `timeout` | `preview_busy` |
| Task stopping or selected tab returning | `cancelled` | `task_stopping` |
| Document or debugger identity changed | `cancelled` | `stale_frame` |
| Chrome lookup, CDP or image-processing failure | `cdp_failed` | `ui_lookup_failed` for lookup failures; otherwise optional |

The 3-second budget includes tab lookup, acquisition, screenshot and image processing. It ends the caller's wait and invalidates subsequent UI work; it does not cancel a Chrome command already issued. The per-tab screenshot fence remains until that command settles or its debugger attachment changes. A successful acquisition retains the session's background-execution claim, shared with tools, until return/stop or loss of authority. A stale image or UI deadline alone does not release that shared claim.

Return and stop reject new UI work and invalidate pending requests. They do not drain potentially unbounded image or screenshot promises. Already-issued focus mutations get a one-second grace period, after which teardown proceeds even if Chrome has not replied. A mutation receives this grace only once, including nested tab returns. No follow-up focus steps may run after invalidation, although an already-issued native call cannot be recalled. UI work therefore cannot veto disconnect cleanup or require another wake event to reconnect. CDP release bounds its waits for pending attachment and focus-override work, revokes stale attachment attempts, and fences late raw attach callbacks through rollback. Raw focus-override commands remain serialized per tab across attachment generations; new acquisition waits for an old command to settle, while cleanup can finish its bounded wait. Loss-of-authority cleanup also runs after a UI deadline, with an acquisition-identity guard to preserve newer tool claims. These individual cleanup bounds are not a three-second guarantee for the entire session stop (which also returns tabs and closes windows).

For capability probing, send `ui.task_preview` on the remote extension socket with a valid string ID and a known session ID. Either a result or one of the UI errors above confirms support. Extensions without the channel pass this request to the native dispatcher, which returns `unknown_method`; disable UI polling on that response. Unsupported `ui.*` methods use the same native fallback. A socket connected to a local daemon does not install this channel.

A gateway can bridge this protocol to a local `bsk` daemon on its server, keeping that daemon's loopback/IPC boundary private. A gateway that terminates device authentication owns that authentication lifecycle and routing isolation. Merely forwarding its credentials to the built-in server will not authorize them: the built-in server accepts its own issued grants.

## Browser permissions and task lifetime

Pair only with a server you trust to operate your browser. A paired server can create Agent Windows and navigate using that browser profile, including its signed-in website sessions. Pairing is device authorization, not a restricted account or website sandbox.

Remote content reads, screenshots, recording and page operations require a tab explicitly created or borrowed by the task. Listing tab titles and URLs remains available to select a tab to borrow. A user tab moved or opened inside an Agent Window does not by itself become authorized. Borrowing uses the existing browser-controlled confirmation preference; remote request flags cannot change that preference. After a borrowed tab is returned, remote content access ends. Returning a tab during remote recording cancels that recording before releasing the tab.

A page may open targets through `target="_blank"`, `window.open`, or a login flow. An opener relationship and window membership alone do not authorize them. During a short observation window armed immediately before native click/key dispatch, a main-frame navigation-target event from a currently controlled source may grant control of a new tab already in the same Agent Window. Nested same-window targets follow the same source checks. These observed tabs are kept separate from explicitly agent-created tabs: session stop releases their control and preserves them and their window. If the final tab query fails, known observed tabs still require preserving the window. An explicit `tab_close` remains a separate destructive tool action.

Cross-window popups are never automatically moved or claimed. They use the ordinary `tab_borrow` flow. Late or unattributed targets also retain that flow; an unowned target already inside the Agent Window must first be moved to a regular browser window before borrowing. Tabs explicitly created by `tab_create` remain agent-owned and are closed on stop. A tab already controlled by any session cannot acquire a second borrow claim.

Disconnecting cancels task work, returns borrowed tabs and closes task-created tabs. User-created tabs survive cleanup. Failed returns preserve the window and must be resolved before reconnecting. Reconnection starts new tasks; commands and sessions are never replayed. Failed remote authentication does not select a local connection automatically.

Remote upload and download are unsupported in this version and return the `unsupported` error. Existing local file transfer behavior is unchanged. Screenshots and other existing RPC content results remain supported. Remote mode has no gateway preview or focus side protocol, background task tab group, or alternative window model. The local `session start --in-window` option is unsupported for remote connections.

Device credentials live in extension-origin IndexedDB; ordinary extension settings contain only the selected connection mode and a non-secret revision. Fresh local profiles and explicitly selected local mode do not read that credential database. If remote storage fails, the popup reports the error and the extension does not fall back automatically. Explicitly selecting the local connection can recover startup even when the credential database is unavailable. Legacy remote settings still migrate before ordinary settings access is restored. The standalone server persists hashed credentials with private file permissions and atomic writes. Treat the whole browser profile and `BSK_HOME` as trusted local data. Protect TLS private keys separately.

## Validation

Build the CLI and extension, then run the ordinary Rust and extension suites. The real browser regression additionally needs an isolated Chrome for Testing executable:

```sh
cargo test --workspace
pnpm --filter @browser-skill/extension test
cargo build -p bsk
pnpm --filter @browser-skill/extension build
BSK_REMOTE_CLI=/absolute/path/to/target/debug/bsk \
BSK_REMOTE_CHROME=/absolute/path/to/chrome-for-testing \
  pnpm --filter @browser-skill/extension test src/transport/__tests__/remote-connection.browser.test.ts
```

The remote server integration tests cover credential exchange, rotation retries, stable device routing, replacement connections, revocation, connection capacity, file-lock contention and native TLS. Unit tests additionally cover rate-limit saturation, unavailable extension storage, local recovery, renewal retry frequency and popup authorization states. TLS fixtures contain a test-only private key and must never be used for deployment.

### Popup observation lifetime

Only `tool.click` and `tool.press` arm observation, immediately before sending native input rather than during target lookup, scrolling, navigation, evaluation or other RPC preparation. Each input phase opens 100 ms of observation. Operation completion waits for the remainder of the last input interval; cancellation closes the listener immediately. Events cannot extend the interval. There is no browser-global `tabs.onCreated` tail. This remains a best-effort source-and-time policy, not proof of causality. Targets delivered outside that interval require explicit borrowing.

Only main-frame source events qualify. Source ownership and its actual window, target window, competing claims and borrow reservations are rechecked before granting non-destructive control. After the action and its observation interval finish, candidate processing has a 500 ms budget, so observation and candidate processing together can delay the tool result by at most 600 ms. Expiry or abort removes listeners and invalidates late continuations without granting ownership; no Chrome movement needs compensation because observation never moves tabs.

Closing a tab or moving it out of its window revokes observed control. On stop, only the session's explicitly created tabs are closed. Observed tabs are preserved even when they originated from a page script or user interaction during the short input window.
