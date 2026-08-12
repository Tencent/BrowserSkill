# BrowserSkill — Privacy Policy

**Last updated:** May 25, 2026

This Privacy Policy describes how the **BrowserSkill** browser extension (the "Extension") handles information when you install and use it. BrowserSkill is published as part of the open-source [BrowserSkill](https://github.com/Tencent/BrowserSkill) project. The source code is publicly auditable.

If you have questions about this policy, please open an issue in the project repository.

---

## 1. What BrowserSkill Does

BrowserSkill is a local automation bridge that lets AI coding agents (such as Cursor, Claude Code, Codex, and OpenClaw) drive a Chromium browser through a command-line tool (`bsk`). The Extension communicates exclusively with a local daemon running on your own computer. **The Extension itself does not contact any remote server, cloud service, or AI provider.**

## 2. Single Purpose

The Extension's single purpose is to expose browser automation primitives (navigation, DOM observation, screenshots, clicks, form filling, tab management) to a locally running BrowserSkill daemon over a WebSocket connection on `127.0.0.1`, so that an AI agent invoked by the user can interact with web pages on the user's behalf.

## 3. Data the Extension Accesses

Depending on the commands the user (via their AI agent) sends to the local daemon, the Extension may access the following categories of data **on the user's local device**:

| Category | What is accessed | Why |
|---|---|---|
| **Web page content** | The DOM, accessibility tree, HTML, and visible-tab screenshots of pages opened in the BrowserSkill-controlled "Agent Window," or in user tabs the user explicitly approves for borrowing. | Required so the AI agent can read pages, locate elements, and verify results. |
| **User input simulated by the agent** | Mouse clicks, keystrokes, and form values that the AI agent dispatches through the Chrome DevTools Protocol (CDP). | Required to perform automation actions the user has asked the agent to do. |
| **Tab and window metadata** | Tab IDs, URLs, titles, window IDs of the Agent Window and any tabs the user explicitly authorizes. | Required to target automation commands at the correct tab/window. |
| **Local extension storage** | A randomly generated 8-character instance ID and an optional user-supplied label. | Used so the local daemon can recognize this browser instance across reconnects. No personal data is stored. |
| **OS notifications** | Permission to display a system notification when the agent requests to "borrow" one of the user's existing tabs. | Required to obtain explicit, per-tab user consent before the agent touches any pre-existing tab. |

## 4. Data the Extension Does **Not** Collect

BrowserSkill does **not**:

- Send any data to remote servers, the Extension's authors, or any third party.
- Call any LLM, AI, or cloud API. The Extension contains no API keys, model identifiers, or remote endpoints.
- Read or transmit cookies, browsing history, bookmarks, downloads, saved passwords, or autofill data.
- Use webcam, microphone, geolocation, or any device sensor.
- Include analytics, telemetry, crash reporting, advertising SDKs, or fingerprinting code.
- Track users across websites or across sessions.
- Sell, rent, share, or transfer user data — there is no user data leaving the device.

## 5. Permissions Justification

The Extension requests the following Chrome permissions. Each is used solely for the single purpose described above.

- **`debugger`** — Attach the Chrome DevTools Protocol to the Agent Window so the agent can observe and interact with pages. Used only on tabs explicitly under BrowserSkill's control.
- **`tabs`** — Inspect, create, and close tabs in the Agent Window; query tab metadata.
- **`windows`** — Create and manage the dedicated Agent Window that isolates agent activity from the user's normal browsing.
- **`alarms`** — Periodically wake the service worker to keep the local WebSocket connection alive.
- **`idle`** — Detect when the device returns from idle/locked so the Extension can promptly re-establish the local WebSocket connection after the machine wakes. No idle data is stored or transmitted.
- **`notifications`** — Show a system notification to obtain user approval before the agent borrows a user-owned tab.
- **`storage`** — Persist a random instance ID and optional label in `chrome.storage.local`.
- **Host permission `<all_urls>`** — Inject a small status overlay (showing "Agent Active") on pages controlled by the agent, and enable automation across whatever sites the user directs the agent to. The Extension does **not** read or transmit page content from sites the agent is not actively driving.

## 6. Where Data Goes

All Extension activity stays on the user's local device. The only network traffic the Extension generates is a WebSocket connection to `ws://127.0.0.1:52800` (loopback only). What the AI agent connected to that local daemon does with the data afterwards (for example, sending a screenshot to an LLM provider) is governed by the privacy policy of that agent or LLM provider, **not** by this policy. BrowserSkill is not a party to those communications.

## 7. Data Retention

- The instance ID and optional label persist in `chrome.storage.local` until the user uninstalls the Extension or clears extension storage.
- Page content, screenshots, DOM snapshots, and other observed data are returned to the local daemon in response to commands and are **not retained by the Extension**. They live only as long as the agent's tool call.

## 8. User Control

Users can at any time:

- Uninstall the Extension from `chrome://extensions`, which removes all stored data.
- Close the Agent Window to stop all agent automation immediately.
- Deny tab-borrow notification prompts to keep their existing tabs off-limits.
- Stop the local daemon to sever the WebSocket connection.

## 9. Children's Privacy

The Extension is a developer tool and is not directed at children under 13. It does not knowingly collect personal information from anyone, including children.

## 10. Security

Because the Extension communicates only with `127.0.0.1`, no data is exposed to the network. Users should still avoid running BrowserSkill in untrusted environments, since any local process able to bind to `127.0.0.1:52800` could send commands to the Extension. Run BrowserSkill only on machines you control.

## 11. Open Source and Auditability

BrowserSkill is open source. Anyone can verify the claims in this policy by reading the source code in the project repository. The Extension contains no obfuscated or minified code paths that hide network calls.

## 12. Changes to This Policy

If this policy changes materially, the **Last updated** date above will change and a new version will be published with the Extension. Continued use of the Extension after an update constitutes acceptance of the revised policy.

## 13. Contact

For privacy-related questions or requests, please open an issue in the BrowserSkill project repository.
