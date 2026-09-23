# BrowserSkill — Privacy Policy

**Last updated:** September 23, 2026

This Privacy Policy describes how the **BrowserSkill** browser extension (the "Extension") handles information when you install and use it. BrowserSkill is published as part of the open-source [BrowserSkill](https://github.com/Tencent/BrowserSkill) project. The source code is publicly auditable.

If you have questions about this policy, please open an issue in the project repository.

---

## 1. What BrowserSkill Does

BrowserSkill lets a user-directed AI agent drive a Chromium browser through the `bsk` command-line tool. By default the Extension connects to a daemon on the same computer. Users can instead explicitly pair with a server running `bsk` or a compatible third-party gateway. In that mode, automation data is sent to the selected server. The Extension does not independently call an AI provider.

## 2. Single Purpose

The Extension exposes browser automation primitives to the user's selected BrowserSkill daemon or compatible gateway so an AI agent can interact with web pages on the user's behalf. Local connections use loopback WebSocket; remote connections use authenticated WSS. Remote upload and download are unsupported in this version.

Optional website debugging helps the user or their agent inspect requests, page behavior and performance in the same authorized browser task, with browser-local history for later review.

## 3. Data the Extension Accesses

Depending on the commands the user (via their AI agent) sends to the selected daemon or gateway and the features the user starts in the Extension, it may access the following categories of data **on the user's local device**:

| Category | What is accessed | Why |
|---|---|---|
| **Web page content** | The DOM, accessibility tree, HTML, and screenshots of pages controlled in the "Agent Window," tabs borrowed according to the browser's confirmation setting, or pages selected for user-initiated Quick Actions. | Required to read pages, locate elements, verify results, and capture requested screenshots. |
| **User input simulated by the agent** | Mouse clicks, keystrokes, and form values that the AI agent dispatches through the Chrome DevTools Protocol (CDP). | Required to perform automation actions the user has asked the agent to do. |
| **Website debugging evidence** | For the selected tab while capture is active: request URLs, methods, headers, request and response bodies when available, status, timing, errors and related network metadata; console messages; agent actions and supported manual input, click, submission and navigation events; bounded visible page text, form-field values and page/performance context. Configured HTTP rules and replay outcomes are also recorded. | Used to inspect and reproduce website behavior, associate operations with requests and page changes, analyze performance, and review or export debugging history. |
| **Tab and window metadata** | Tab IDs, URLs, titles and window IDs, including user tabs listed to select a tab for borrowing. | Required to target automation commands at the correct tab/window. |
| **Local extension storage** | A randomly generated 8-character instance ID, an optional user-supplied label, feature preferences including the audit toggle, and optionally a paired endpoint and device credential. | Used to recognize this browser instance and restore user settings. |
| **File transfers requested by the agent** | Local files explicitly supplied to `bsk upload`, and the file created by a single `bsk download` action. | Required to attach a task file to a web page or return a browser-generated download to the invoking local agent. |
| **OS notifications** | Permission to display a system notification when the agent requests to "borrow" one of the user's existing tabs. | Used to request per-tab consent when browser confirmation is enabled. |

## 4. Data Collection Boundaries

- The Extension sends automation results only to the daemon or gateway the user selects. BrowserSkill's authors do not receive telemetry or operate a mandatory hosted service.
- The Extension does not independently call LLM, AI or cloud APIs and contains no AI provider API keys.
- BrowserSkill does not enumerate the browser's browsing-history database, bookmarks, saved passwords or autofill databases. Website debugging creates its own history of the selected tab's activity during capture; this is separate from the browser's browsing-history database. Download handling observes the download initiated by an active local `bsk download` call.
- Website debugging starts only when explicitly requested by the user or their agent. Each capture targets one task-created or borrowed tab per task, including network evidence from its frames. Merely opening a tab or moving it into the Agent Window does not authorize capture. During capture, supported manual actions in the selected page are recorded as well as agent actions.
- Stopping capture, returning or closing its tab, ending its task, or disconnecting stops new collection but does not delete saved debugging history. After a browser or extension restart, unfinished captures are recovered as interrupted rather than automatically resumed.
- Automation uses the existing browser profile. Controlled pages may expose personal data and signed-in website sessions; pairing with a server allows its Agent to operate those pages.
- The Extension includes no analytics, advertising, fingerprinting or cross-site tracking system and does not sell user data.

## 5. Permissions Justification

The Extension requests the following Chrome permissions. Each is used solely for the single purpose described above.

- **`debugger`** — Attach the Chrome DevTools Protocol to tabs selected for automation or user-initiated capture, so BrowserSkill can observe, interact with, and capture those pages. During explicitly started website debugging, it also reads network headers and bodies, console and performance evidence, observes page actions and field values, and applies explicitly configured task-local HTTP rules and request replays.
- **`activeTab`** — Allow temporary access to the active tab when the user invokes the Extension, for user-initiated Quick Actions.
- **`scripting`** — Inject the full-page screenshot helper into the selected page when it is missing, such as after an extension reload.
- **`webNavigation`** — Track page navigation and frames so captures, recordings, and human-help completion checks follow the correct document.
- **`tabs`** — Inspect, create, and close tabs in the Agent Window; query tab metadata.
- **`windows`** — Create and manage the dedicated Agent Window that isolates agent activity from the user's normal browsing.
- **`alarms`** — Periodically wake the service worker to keep the selected connection alive and renew remote device authorization.
- **`idle`** — Detect when the device returns from idle/locked so the Extension can promptly re-establish the selected WebSocket connection after the machine wakes. No idle data is stored or transmitted.
- **`notifications`** — Show a system notification to obtain user approval before borrowing a user-owned tab when browser confirmation is enabled.
- **`downloads`** — Correlate and route the one browser download initiated by an active `bsk download` command. If that claimed transaction fails, BrowserSkill cancels an in-progress file or removes its completed temporary browser file. It is not used to enumerate download history or alter unclaimed downloads.
- **`storage`** — Persist a random instance ID, optional label, and feature preferences in `chrome.storage.local`. Remote credentials and website debugging history are stored separately in extension-origin IndexedDB, outside these settings.
- **Host permission `<all_urls>`** — Inject a small status overlay (showing "Agent Active") on pages controlled by the agent, and enable automation across whatever sites the user directs the agent to. Remote connections also use this permission for the selected endpoint. Remote page-content access requires a task-created or explicitly borrowed tab.

## 6. Where Data Goes

Local mode connects to the loopback daemon (default port **52800**). Remote mode sends pairing and renewal requests over HTTPS and automation traffic over authenticated WSS to the endpoint the user explicitly selects. Plain HTTP/WS is allowed only on loopback for development. Pairing secrets are removed from the URL before network requests.

The selected server receives task results, including requested page content, screenshots, recording traces, tab metadata and requested website debugging evidence, which can include retained request/response headers and bodies, console messages and field values. Agents and gateway operators may retain or forward those results under their own policies. In remote mode, enabled operation audit is stored on the daemon's server, not on the browser computer. BrowserSkill does not operate a required intermediary service.

Website debugging history is saved in the current browser profile even when connected to a remote daemon. It is available in the Extension's history page without a daemon connection. The owning agent can request retained evidence while its task retains access to the target tab; ending that task or releasing the tab revokes that agent access, while the user can still review or export local history. Saving history does not automatically upload the entire archive to the selected server. Exported JSON files include retained evidence and can be shared by the user.

When explicitly configured by the user or agent during an active capture, HTTP rules can block or modify requests or supply mock responses. Request replay sends a new request to the same HTTP(S) origin as the source request and current page, using the page's current browser session, including cookies supplied by the browser. Replays can send supplied headers and bodies to that website and change its server-side data. Merely opening history or reading evidence does not replay requests.

## 7. Data Retention

- The instance ID, optional label, and feature preferences persist in `chrome.storage.local` until the user uninstalls the Extension or clears extension storage.
- Outside website debugging, page content, screenshots, DOM snapshots, and other observed data are returned to the selected daemon or gateway in response to commands and may be temporarily retained for an active recording or screenshot export until that operation ends or its results are released. Website debugging evidence follows the separate history retention rules below.
- Website debugging saves redacted evidence to extension-origin IndexedDB during capture and when capture stops. Stopped records expire after **30 days**, with automatic cleanup when history is read or written. History has retention budgets of **50 records / 50 MiB of serialized data**; older stopped records may be removed earlier to stay within these budgets, while active captures are protected from this cleanup. These budgets do not describe the exact disk size of IndexedDB. Per-capture limits can omit or evict individual requests, bodies and other evidence sooner.
- Website debugging history survives task completion and disconnection. Users can delete stopped records from the history page; clearing extension storage or uninstalling removes local history. Previously exported files and copies already received by an agent or gateway are not deleted by these actions or by automatic expiration.
- Upload and download bytes are staged by the local daemon in a private, session-scoped directory. Download staging is removed after it is copied to the requested destination. Upload staging is retained until the session ends so a later form submission can still read the attached file. Remaining staging is removed when the session ends or disconnects, or when the daemon next starts after a crash.

- Operation audit is separate from website debugging and is off by default. When enabled, the selected daemon stores task and operation metadata in `BSK_HOME/audit` (by default `.bsk/audit` under the user home directory). Records include timestamps, tool types, website origins, element names with basic redaction, statuses, and error codes. Input values, page bodies, screenshots, scripts, and file contents are excluded from operation audit; these exclusions do not apply to website debugging history described above. Ended tasks are retained for 30 days and pruned when history is loaded, audit is enabled, a task starts, or the task list is queried. Users can export or delete ended tasks from the audit page. Exported copies are not automatically removed.

- Remote endpoint and device credentials remain in extension-origin IndexedDB until the user selects Local connection, clears extension storage or uninstalls. The server retains device grants until revoked; expired grants cannot connect. Disconnecting does not delete results or audit records already held by a server.

## 8. User Control

Users can at any time:

- Uninstall the Extension from `chrome://extensions`, which removes extension storage. Audit files on the daemon host and exported copies must be deleted separately.
- Stop website debugging from Quick Actions → Website debugging, or ask the agent to stop capture. Open its history page to review or export records and delete stopped records, including when no daemon is connected. Stop an active capture before deleting its record.
- Turn operation audit off in Quick Features to stop collecting new audit operations while retaining existing audit history. Previously recorded tasks still receive their final lifecycle status. This switch does not stop website debugging capture or delete its history.
- Close the Agent Window to stop all agent automation immediately.
- Enable confirmation before borrowing and deny tab-borrow prompts to keep existing tabs off-limits.
- Disable the connection, choose Local connection, or stop the selected daemon to disconnect.
- Revoke a paired device from the server with `bsk daemon revoke DEVICE_ID`, or use the gateway operator’s revocation controls.

## 9. Children's Privacy

The Extension is a developer tool and is not directed at children under 13.

## 10. Security

Local mode trusts processes able to bind the configured loopback port. Remote mode requires explicit pairing and encrypted transport, except for loopback development. The built-in server stores credential hashes, validates connections, supports rotation and closes connections on revocation or expiration. Third-party gateways are responsible for implementing the same authorization lifecycle and isolating device routing.

Remote page reads and operations require task-owned tabs; merely moving a user tab into an Agent Window does not authorize it. Borrowing follows the confirmation preference controlled in the browser. Treat a paired server as trusted to operate your browser profile and signed-in websites. Browser profile files, server data and TLS keys must remain private to trusted local users. See [remote browser connections](../../docs/remote-extension-connection.md) for deployment details.

Website debugging redacts recognized credential headers (such as Authorization, Cookie and Set-Cookie), sensitive URL parameters, JSON/form keys and common credential text patterns before retaining evidence. Observed credential, payment and file-input fields are omitted or redacted. This filtering does not guarantee that arbitrary request/response bodies, console messages, page text or field values contain no personal or confidential information. Treat retained and exported evidence as potentially sensitive, review it before sharing, and delete copies that are no longer needed. See [website debugging](../../docs/website-debugging.md) for capture, redaction and retention limits.

## 11. Open Source and Auditability

BrowserSkill is open source. Anyone can verify the claims in this policy by reading the source code in the project repository. The Extension contains no obfuscated or minified code paths that hide network calls.

## 12. Changes to This Policy

If this policy changes materially, the **Last updated** date above will change and a new version will be published with the Extension. Continued use of the Extension after an update constitutes acceptance of the revised policy.

## 13. Contact

For privacy-related questions or requests, please open an issue in the BrowserSkill project repository.
