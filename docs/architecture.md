# browser-skill architecture

Developer-oriented overview of how the CLI, daemon, and extension fit together.
Consolidates design §2, §3, §5, and §6.

## System diagram

The diagram shows the default local setup. In [remote mode](remote-extension-connection.md),
the CLI and daemon run on a server; the extension connects from the user's browser
over authenticated WSS. CLI-to-daemon communication remains local IPC on the server.

```mermaid
flowchart TB
  subgraph harness [Agent harness]
    Agent[Claude Code / Cursor / Codex]
  end

  subgraph host [Developer machine]
  Agent -->|shell: bsk ...| CLI[bsk CLI]
  CLI <-->|JSON Lines / UDS| Daemon[bsk daemon]
  Daemon <-->|WebSocket JSON| Ext[bsk extension MV3]
  end

  subgraph browser [Chromium]
  Ext -->|CDP + WebExt| Tabs[User tabs + Agent Windows]
  end

  Skill[SKILL.md] -.->|documents workflow| Agent
```

## Components

### bsk CLI (`crates/bsk-cli`)

- Parses verb-noun subcommands (`bsk session start`, `bsk click`, …).
- Uses IPC to discover a running daemon. Automatically starts one only when
  discovery or its listener is absent, unless `BSK_AUTO_START=0` disables implicit
  startup. See [sandboxed agent setup](sandboxed-agents.md) for host-managed daemons.
- Speaks JSON Lines over `$BSK_HOME/run/daemon.sock` (Unix) or a named pipe (Windows);
  the default home is `~/.bsk`.
- Renders human-readable output by default; `--json` emits structured responses.

Key modules:

| Module | Role |
| --- | --- |
| `cli/` | Clap command tree, per-tool handlers |
| `ipc_client.rs` | UDS client, line framing |
| `daemon/` | WS server, session routing, idle shutdown |

### bsk daemon (same binary: `bsk daemon`)

- In local mode, listens on loopback WebSocket (default **52800**, configurable with `bsk daemon start --port`) for extensions. The extension popup saves the matching connection port; saving ends existing sessions and reconnects when enabled.
- Server mode supports authenticated remote extension connections with device pairing, renewal and revocation. Native TLS or a TLS reverse proxy provides WSS; the deployment supervisor owns server restarts.
- Validates `Origin: chrome-extension://…` on handshake.
- Maintains `browsers` (connected extensions) and `sessions` (window containers and page ownership).
- **Per-session queue** serializes tool calls targeting one session.
- Forwards `tool.*` RPCs to the correct extension connection.

State files under `~/.bsk/`:

| File | Purpose |
| --- | --- |
| `daemon.lock` | Advisory lock — single daemon instance |
| `daemon.json` | `{ sock_path, pid, ws_port, version }` |
| `daemon.log` | Rolling trace log |
| `daemon.pid` | PID for status/doctor |

### bsk extension (`apps/extension`)

WXT / MV3 Chromium extension. Built with React popup and a service worker background.

| Directory | Responsibility |
| --- | --- |
| `transport/` | Pluggable `Transport` (v1: `WSTransport`) |
| `tools/` | `ToolDispatcher` → 21 tool handlers |
| `session-manager/` | Dedicated/shared session containers, tab ownership, ref-store (`@e1`) |
| `browser-driver/` | CDP-backed browser operations |
| `entrypoints/popup/` | Connection status UI |
| `content/` | Control overlay on session-controlled pages |

### bsk-protocol (`crates/bsk-protocol`)

Shared Rust types + JSON Schema generation. TypeScript mirrors frame shapes in
`apps/extension/src/transport/types.ts` (kept in sync via tests and schema dumps).

## Typical tool call

1. Agent runs `bsk click @e1 --tab-id 42 --session ab12`.
2. CLI ensures daemon is running, opens UDS, sends one JSON request line.
3. Daemon resolves session `ab12` → browser client → forwards `tool.click` over WS.
4. Extension dispatcher validates sandbox rules, invokes CDP via `BrowserDriver`.
5. Response travels CLI ← daemon ← extension; CLI prints result and exits.

The [scroll-to primitive reference](scroll-to.md) documents `tool.scroll_to`,
including its CLI/plugin mappings, visible-bounds contract and cancellation
behavior. It follows the same routing path and is classified as a browser
mutation for session queueing and user-interruption gating.

## Session and sandbox model

- **Session** = opaque ID + window container + session-scoped ref-store and tab ownership.
  The default container is a dedicated **Agent Window**. Local `session start --in-window`
  creates a controlled tab in the last-focused normal user window (protocol 1.4).
  Protocol 1.5 adds `--current-tab` / `--tab-id`, which claim an approved existing tab
  without moving it or creating another window or tab.
- **Write scope**: dedicated sessions use their Agent Window. Shared sessions require
  both explicit tab ownership (created or borrowed) and location in their host window.
  Sharing a host never grants control of user pages or another session's pages.
- **Lifecycle**: persistent sessions still use explicit `bsk session stop` with the idle
  timeout as a safety net. Ephemeral sessions carry a renewable owner lease and are
  stopped after owner disconnect/lease expiry; lease renewal does not disable the same
  idle safety net. Physical ownership is also journaled in extension storage so an MV3
  worker restart can recover interrupted cleanup. A browser restart or extension
  reload/update clears the authoritative `storage.session` epoch, so older numeric
  Chrome ids are diagnosed and pruned without being dereferenced.
- Multiple sessions may use separate Agent Windows or share a local user window;
  controlled pages remain isolated by session. Shared cleanup returns borrowed pages
  and removes its created pages without actively closing the host window. An
  existing-tab session releases its stationary root tab without moving or closing it.
- Remote content reads and actions require task-created or explicitly borrowed tabs.
  A page-opened popup or a user tab moved into the Agent Window does not become
  controlled automatically; see [remote tab ownership](remote-extension-connection.md#browser-permissions-and-task-lifetime).

### tab_list scopes

| `scope` | Visible tabs |
| --- | --- |
| `user` | User pages, excluding other sessions' controlled pages and dedicated windows |
| `agent` | Current dedicated Agent Window, or explicitly controlled pages in a shared host |
| `all` | Both scopes, excluding other sessions' controlled pages and dedicated windows |

## Concurrency

| Scope | Policy |
| --- | --- |
| Same session | Daemon serializes RPCs (ref-store safety) |
| Different sessions | Parallel |
| Multiple browsers | `bsk session start --browser <id>` when >1 extension connected |

## Module dependency graph

```mermaid
flowchart LR
  subgraph rust [Rust workspace]
    CLI[bsk CLI crate]
    Proto[bsk-protocol]
    CLI --> Proto
  end

  subgraph ts [Extension]
    BG[background]
    T[Transport]
    D[ToolDispatcher]
    SM[SessionManager]
    BD[BrowserDriver]
    BG --> T
    BG --> D
    D --> SM
    D --> BD
    SM --> BD
  end

  CLI <-->|JSON protocol| T
```

## Connection security

- Local mode binds WebSocket to **loopback**. Server mode permits remote access
  through authenticated WSS; plaintext listeners remain on loopback behind TLS
  termination or for development.
- Extension origin allow-list at WS upgrade.
- Website cookies stay in the user's browser profile. Remote device credentials
  are stored in extension-origin IndexedDB; the built-in server stores credential
  hashes in its private `BSK_HOME`. Pairing and device grants govern remote access.
- `evaluate` follows session write scope, including explicit ownership in shared mode.
- Operation audit, when enabled, is stored on the daemon host, including the
  server in remote mode. See [operation audit](operation-audit.md).

### File-transfer boundary

Upload and download are supported only for local connections. Remote sessions
return `unsupported`; screenshots and other RPC content results remain available.

- The invoking agent/harness decides whether a transfer is authorized and supplies the task-local source or destination path.
- The CLI is the only component that reads an upload source or writes the final download destination. Before browser dispatch it owns rollback of partially staged uploads; after dispatch, ownership moves to the session because a transport timeout cannot prove that Chrome did not attach the file. Download output becomes visible through one atomic commit, and replacement is opt-in without a pre-delete window. The extension never receives either agent-facing path.
- The daemon is the authority for storage capabilities and limits. It issues opaque session-scoped transfer IDs, stages bounded chunks in a private runtime directory, and injects only private staged upload paths. For download it mints one relative Chrome directory capability. Only after validating the reported path, file type, symlink boundary, and authoritative byte limit does it take ownership of browser-file cleanup and import the bytes.
- The extension owns only the browser transaction. Every transfer resolves one `ResolvedActionTarget`. The default upload mechanism arms Chrome's chooser interception before clicking, then accepts either an exact `Page.fileChooserOpened` input node or an independent probe anchored in the trigger node's document; one verified input is committed with `DOM.setFileInputFiles`, while a non-input picker is rejected immediately. Explicit drop mode performs no click and never falls back to the chooser mechanism: after geometry resolution it temporarily excludes BrowserSkill's own overlay, verifies that the resolved drop zone still owns its local action point, and sends one native `dragEnter` / `dragOver` / `drop` transaction to that node's CDP target before restoring the overlay. OOPIF drops use target-local coordinates rather than top-level click coordinates. Download correlates exact-target CDP intent and `chrome.downloads` filename candidates in either arrival order, claims only one unique match, and never cancels an unclaimed candidate.
- Browser-side operations report `effect_state` (`none`, `committed`, or `unknown`), `phase`, and `cleanup_state`. Confirmed success wins over a late cancel; an unknown effect is preserved across timeout or transport loss and must not be retried blindly. A transfer deadline sends cancellation to the extension and keeps the session queue occupied for bounded compensation rather than abandoning an in-flight browser effect.
- Download staging is released after CLI commit. Upload staging remains until session teardown because the page may read an attached file only on a later form submission. Remaining staging is released on session stop/browser disconnect and on daemon startup after a crash. BrowserSkill does not inspect content or decide whether a transfer is appropriate.

## Repository layout

```
browser-skill/
├── apps/extension/       # WXT Chromium extension
├── crates/
│   ├── bsk-cli/           # `bsk` binary (CLI + daemon)
│   └── bsk-protocol/      # Wire types + schemas
├── install.sh            # CLI installer (GitHub Releases)
├── skill/SKILL.md        # Agent harness instructions
└── docs/                 # architecture, guides
```
