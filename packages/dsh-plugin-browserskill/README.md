# BrowserSkill for DeepSeek Harness

[![npm version](https://img.shields.io/npm/v/@wxg-prc-cpg/browser-skill-dsh-plugin)](https://www.npmjs.com/package/@wxg-prc-cpg/browser-skill-dsh-plugin)

Lightweight [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin for [BrowserSkill](https://github.com/Tencent/BrowserSkill).

It packages the canonical `browser-skill` agent skill, automatically heals `PATH` for `~/.local/bin` (and any configured `bskPath`), and bundles an on-demand `bsk` CLI + browser extension setup flow — running on the exact same `bsk` CLI, daemon (`DSH_SESSION_ID` session isolation), and Agent Window runtime as Claude Code, Codex, Cursor, and OpenClaw.

## Installation

Add the plugin to your DeepSeek Harness profile (or install it from the DSH Web UI plugin panel), then start DSH:

```sh
dsh plugin --profile web add @wxg-prc-cpg/browser-skill-dsh-plugin
dsh --profile web
```

Replace `web` with your profile name if you use another profile. No separate `bsk install-skill` step is needed.

### On-demand setup (first run)

If `bsk` and the browser extension are already installed, start using `/browser-skill` right away:

```text
/browser-skill open https://example.com, summarize the page, and close the browser session.
```

If `bsk` is **not** installed on your computer yet, simply invoke `/browser-skill` (or ask DSH to open a webpage):

1. The plugin detects that `bsk` is missing and instructs the DSH agent to run the bundled cross-platform installer (`bin/install-bsk.mjs`, which installs `bsk` into `~/.local/bin` without `sudo`).
2. Because the plugin automatically adds `~/.local/bin` to the DSH host `PATH`, `bsk` becomes available immediately in the same session without restarting DSH.
3. The agent runs `bsk doctor` and gives you the [Chrome Web Store](https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi) or [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/browserskill/emacgiaaaiojkkpkddmmdfhmokgmnikg) link if the browser extension still needs to be installed and connected.

You can also run the bundled CLI installer manually at any time:

```sh
npx --package @wxg-prc-cpg/browser-skill-dsh-plugin bsk-dsh-install
```

## Windows GUI hosts and the daemon

On Windows, a GUI host can run DSH (or another agent) inside a Job Object that forbids breakaway. `bsk`'s normal automatic daemon startup needs that breakaway, so the first browser command fails with:

```text
ensure daemon is running: automatic daemon startup failed: cannot start an independent Windows daemon; the Job Object of this process does not allow breakaway ...
```

This is expected in this host, not a broken installation: an already running daemon is still reused. Start it from the host's managed background task and keep that task alive across commands:

```text
bsk daemon start --foreground
```

The host must launch it **without allocating a visible console window** — for example Node's `child_process.spawn` with `windowsHide: true`. Do not substitute `Start-Process`, `cmd /c start`, WMI process creation, or a Scheduled Task: those allocate a visible console, and closing that console kills the daemon together with every active browser session.

Verify the daemon from a separate call, then use `BSK_AUTO_START=0` for later `bsk` commands so they reuse it instead of trying to start their own. The full contract — shared `BSK_HOME`, `BSK_AUTO_START=0`, and the independent-terminal fallback when the host cannot keep a task alive — is in [Running in a sandboxed agent](https://github.com/Tencent/BrowserSkill/blob/main/docs/sandboxed-agents.md).

## Configuration

The plugin exposes one optional setting in `cordis.patch.yml` and the DSH Web UI settings form:

| Option | Default | Description |
| --- | --- | --- |
| `bskPath` | `"bsk"` | Path to the `bsk` executable or its directory. Defaults to resolving `bsk` from `PATH` or `~/.local/bin` (`$BSK_INSTALL_DIR`). |

## How it works

- **Unified CLI runtime:** Uses DSH's shell execution tool to run `bsk` commands (`bsk open`, `bsk click`, `bsk fill`, `bsk sync`, `bsk close`) with full support for shared control, full-page screenshots, structured extraction, file upload/download, task video recording, recipes, and website debugging.
- **Automatic session scoping:** The `bsk` daemon recognizes `DSH_SESSION_ID` automatically so concurrent conversations and subagents keep isolated browser scopes without manual `--session` flags.
- **MCP alternative:** For restricted profiles without shell execution, connect `bsk mcp` through `@deepseek-ai/dsh-mcp-client` instead (see [MCP setup](https://github.com/Tencent/BrowserSkill/blob/main/docs/mcp.md)).

## Updating

Update the plugin in your DSH profile, then restart that profile:

```sh
dsh plugin --profile web update @wxg-prc-cpg/browser-skill-dsh-plugin --latest
```

Update the `bsk` CLI (`bsk update --yes`) and browser extension separately when a release requires a newer protocol version.
