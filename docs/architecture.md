# browser-skill architecture

Developer-oriented overview of how the CLI, daemon, and extension fit together.
Consolidates design §2, §3, §5, and §6.

## System diagram

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
- On first use, **auto-spawns** the daemon if `~/.bsk/daemon.lock` is absent or stale.
- Speaks JSON Lines over `~/.bsk/daemon.sock` (Unix) or a named pipe (Windows).
- Renders human-readable output by default; `--json` emits structured responses.

Key modules:

| Module | Role |
| --- | --- |
| `cli/` | Clap command tree, per-tool handlers |
| `ipc_client.rs` | UDS client, line framing |
| `daemon/` | WS server, session routing, idle shutdown |

### bsk daemon (same binary: `bsk daemon`)

- Listens on loopback WebSocket (default **52800**) for extensions.
- Validates `Origin: chrome-extension://…` on handshake.
- Maintains `browsers` (connected extensions) and `sessions` (Agent Window bindings).
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
| `session-manager/` | Sessions, Agent Window, ref-store (`@e1`) |
| `browser-driver/` | CDP-backed browser operations |
| `entrypoints/popup/` | Connection status UI |
| `content/` | Control overlay in Agent Windows |

### bsk-protocol (`crates/bsk-protocol`)

Shared Rust types + JSON Schema generation. TypeScript mirrors frame shapes in
`apps/extension/src/transport/types.ts` (kept in sync via tests and schema dumps).

## Typical tool call

1. Agent runs `bsk click @e1 --tab-id 42 --session ab12`.
2. CLI ensures daemon is running, opens UDS, sends one JSON request line.
3. Daemon resolves session `ab12` → browser client → forwards `tool.click` over WS.
4. Extension dispatcher validates sandbox rules, invokes CDP via `BrowserDriver`.
5. Response travels CLI ← daemon ← extension; CLI prints result and exits.

## Session and sandbox model

- **Session** = opaque ID (4 lowercase letters in v0.1) + dedicated **Agent Window**
  + session-scoped ref-store + borrow table.
- **Sandbox-only**: write tools require tabs inside the Agent Window unless the tab
  was **borrowed** from the user profile.
- **Session stop is mandatory** in agent workflows (`bsk session stop`); idle timeout
  (default 5 min) is a safety net only.
- Multiple sessions on one browser → multiple Agent Windows, fully isolated.

### tab_list scopes

| `scope` | Visible tabs |
| --- | --- |
| `user` | User profile windows (default) |
| `agent` | Current session's Agent Window only |
| `all` | Agent Window + user windows for this session |

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

## Security (v1)

- Daemon and WebSocket bind to **loopback** only.
- Extension origin allow-list at WS upgrade.
- No credential storage in bsk — cookies stay in the user's browser profile.
- `evaluate` restricted to Agent Window tabs in sandbox mode.

### File-transfer boundary

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
