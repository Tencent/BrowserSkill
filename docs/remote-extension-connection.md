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

A gateway can bridge this protocol to a local `bsk` daemon on its server, keeping that daemon's loopback/IPC boundary private. A gateway that terminates device authentication owns that authentication lifecycle and routing isolation. Merely forwarding its credentials to the built-in server will not authorize them: the built-in server accepts its own issued grants.

## Browser permissions and task lifetime

Pair only with a server you trust to operate your browser. A paired server can create Agent Windows and navigate using that browser profile, including its signed-in website sessions. Pairing is device authorization, not a restricted account or website sandbox.

Remote content reads, screenshots, recording and page operations require a tab explicitly created or borrowed by the task. Listing tab titles and URLs remains available to select a tab to borrow. A user tab moved or opened inside an Agent Window does not by itself become authorized. Borrowing uses the existing browser-controlled confirmation preference; remote request flags cannot change that preference. After a borrowed tab is returned, remote content access ends. Returning a tab during remote recording cancels that recording before releasing the tab.

This also applies to tabs or windows opened by a page through `target="_blank"`, `window.open`, or an OAuth flow. An opener relationship does not grant control. If such a tab is already inside the Agent Window, it cannot be borrowed in place: the browser user must first move it to a regular browser window, then the Agent can use the ordinary borrow flow. Tabs explicitly created through `bsk tab create` are controlled immediately. Automatic popup authorization is outside this version's scope.

Disconnecting cancels task work, returns borrowed tabs and closes task-created tabs. User-created tabs survive cleanup. Failed returns preserve the window and must be resolved before reconnecting. Reconnection starts new tasks; commands and sessions are never replayed. Failed remote authentication does not select a local connection automatically.

Remote upload and download are unsupported in this version and return the `unsupported` error. Existing local file transfer behavior is unchanged. Screenshots and other existing RPC content results remain supported. There is no gateway preview or focus side protocol, background task tab group, or alternative window model.

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
