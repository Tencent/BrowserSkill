# BrowserSkill

<p align="center">
  <img src="docs/assets/browserskill-readme-banner.png" alt="BrowserSkill — connect your AI agent to your browser" />
</p>

<p align="center">
  <strong>Let AI agents work in your logged-in browser while you keep working.</strong>
</p>

<p align="center">
  English · <a href="README.zh-CN.md">中文</a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#website-debugging">Website debugging</a> ·
  <a href="#deepseek-harness-plugin">DSH plugin</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

**BrowserSkill connects your AI agent to Chrome or Microsoft Edge, using the accounts you are already signed into.** Ask it to read pages, fill forms, work through a website, capture a long screenshot, or investigate a failing request. Tasks run in a separate, visible **Agent Window**; an existing tab can be explicitly borrowed and returned when the task ends.

Use the `bsk` CLI with Cursor, Claude Code, Codex, OpenClaw, CodeBuddy, WorkBuddy, Pi, Hermes Agent, or another shell-capable agent. **DeepSeek Harness** has a dedicated plugin with native browser tools and task previews. You choose the agent and model; BrowserSkill provides the browser connection.

## What you can do

| Capability | What it gives you |
| --- | --- |
| **Work with your existing accounts** | Use the browser's current login state to read documents, search internal sites, fill forms, and complete web workflows. |
| **Keep browser tasks visible** | Give the agent its own window, borrow an existing tab when needed, and take over for login, verification, or other human-only steps. |
| **Read, interact, and capture** | Inspect page text and controls, click and type, manage tabs, capture viewport or full-page screenshots, and upload or download files in local mode. |
| **Debug websites with evidence** | Connect actions to requests, response bodies, console messages, and page changes. Inspect performance, slow APIs, and suspected duplicate requests; use explicit HTTP rules or request replay to test a hypothesis. |
| **Choose the right browser** | Name browser instances, bind a task to a specific profile, or pair an agent running on a server with a browser on your computer. |
| **Review what happened** | Reopen browser-local debugging history, export evidence as JSON, or enable a separate operation audit to review task activity. |

Watch a browser task in action:

https://github.com/user-attachments/assets/db782c92-b1d4-4aae-a255-039675937a90

## Quick Start

For local automation, you need **an AI agent + the `bsk` CLI + the browser extension**. The CLI includes the background daemon. The skill teaches your agent how to use it.

| Component | Supported environments |
| --- | --- |
| CLI / daemon | macOS: Apple Silicon and Intel · Linux: x64 and ARM64 · Windows: x64 |
| Extension | Chrome and Microsoft Edge, based on Chromium 125 or later. Other Chromium browsers may work; compatibility is not guaranteed. |
| Agent integration | A shell-capable agent with the BrowserSkill skill, or DeepSeek Harness with the [DSH plugin](#deepseek-harness-plugin). |

### Let your agent set it up

Send this to your agent:

```text
Set up browser-skill on this machine by following https://raw.githubusercontent.com/Tencent/BrowserSkill/main/AGENT_INSTALL.md
```

The guide covers CLI installation, the correct skill or DSH plugin, connection checks, and a first browser task. You will still need to install the extension in the browser you want to use:

**[Install for Chrome](https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi)** · **[Install for Edge](https://microsoftedge.microsoft.com/addons/detail/browserskill/emacgiaaaiojkkpkddmmdfhmokgmnikg)**

<details>
<summary><b>Manual setup</b></summary>

#### 1. Install the CLI

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.sh | sh
export PATH="${BSK_INSTALL_DIR:-$HOME/.local/bin}:$PATH"
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.ps1 | iex
```

By default, the binary is installed under `~/.local/bin`. Check it in the terminal or agent environment that will use it:

```sh
bsk --version
```

If an already-running agent cannot find `bsk`, restart it to pick up the new PATH, or configure the installed binary's absolute path.

#### 2. Connect the extension

Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi) or [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/browserskill/emacgiaaaiojkkpkddmmdfhmokgmnikg). Open its popup, enable the local connection, and check its status after starting the CLI.

#### 3. Install the skill for your agent

```sh
bsk install-skill
```

Select your harness with **Space**, then press **Enter**. For non-interactive setup, choose it explicitly:

```sh
bsk install-skill --harness cursor --json
```

Use `bsk install-skill --list` to see supported targets and paths. Existing installations are skipped unless you explicitly replace them with `--force`. For another harness, copy the entire [`crates/bsk-cli/skill/`](crates/bsk-cli/skill/) directory into its skills directory as `browser-skill/`, including `references/`.

DSH users should install the [plugin](#deepseek-harness-plugin) instead; it includes the skill.

#### 4. Check the connection

```sh
bsk doctor
```

Resolve any failed checks and confirm that the extension shows **Connected**. Start a new agent session and check that it can discover `browser-skill`; a successful doctor check alone does not confirm skill discovery.

</details>

### Try your first task

Once connected, ask your agent:

```text
Use browser-skill to open https://example.com, summarize the page, and end the browser session when finished.
```

The agent should open an Agent Window, read the page, return the summary, and stop its task. Harnesses that support skill slash commands can also use `/browser-skill`.

<details>
<summary><b>Try the CLI directly</b></summary>

Start a session and keep the returned `session_id`:

```sh
bsk session start --no-focus --json
```

Replace `<id>` with that value in each command below. With multiple connected browsers, select one using `--browser <instance-id-or-name>` when starting the session.

```sh
bsk navigate https://example.com --session <id>
bsk observe --session <id>
bsk screenshot --session <id> --out example.png
bsk session stop <id>
```

Use `bsk --help` or `bsk <command> --help` for command options. Always stop your session when finished, including after a failed task; borrowed tabs are returned to their original window.

</details>

If your agent sandbox removes background processes after each command, use the [sandbox setup guide](docs/sandboxed-agents.md). It explains how to keep the daemon in a persistent host environment and connect with shared `BSK_HOME` and `BSK_AUTO_START=0`.

## DeepSeek Harness plugin

The [DSH plugin](packages/dsh-plugin-browserskill/README.md) adds native `browser_*` tools, browser task previews, and screenshot results to the DeepSeek Harness Web UI. It uses the same `bsk` CLI and extension and includes its own BrowserSkill skill.

With DeepSeek Harness, pnpm, and `bsk` installed and the extension connected, add the plugin to your profile:

```sh
dsh plugin --profile web add @wxg-prc-cpg/browser-skill-dsh-plugin
dsh --profile web
```

Replace `web` with your profile name. Make sure `bsk` is available on the PATH used to start DSH, or set the plugin's `bskPath`. In a conversation, invoke `/browser-skill` and describe the task. A separate `bsk install-skill` step is not needed.

[Plugin usage and configuration](packages/dsh-plugin-browserskill/README.md) · [npm package](https://www.npmjs.com/package/@wxg-prc-cpg/browser-skill-dsh-plugin)

## Website debugging

**Give your agent the browser evidence behind a bug.** Start capture before reproducing an issue on a website you are authorized to debug, then inspect the result in the extension or through the agent.

- **Follow an operation:** see its requests, console output, form-field values, and immediate or delayed page changes. Capture includes supported manual actions as well as agent actions.
- **Inspect a request:** read retained headers, submitted data, response bodies, timing, and errors. Filter traffic or inspect a specific JSON field.
- **Investigate performance:** inspect page-load metrics, API timing summaries, and suspected duplicate requests. Missing or partial evidence is identified explicitly.
- **Test and keep evidence:** configure task-local request modification, blocking, mock responses, or same-origin replay; save a JSON record to review or share later.

Try a task such as:

```text
Use browser-skill to investigate why saving the form on http://localhost:3000 fails. Start website debugging before reproducing it, inspect the request, response and console, then export the evidence and end the session.
```

From the extension, open **Quick Actions → Website debugging** for an existing task. The evidence page connects the operation timeline, requests, Console, page context, Performance, and API analysis. Its history remains accessible after the task ends, even without a daemon connection. A new agent task needs a user-provided export to inspect an ended task's history.

Request replay sends a new request using the page's current session and can change server data. Capture and redaction have limits; retained evidence may still contain sensitive information. See [website debugging](docs/website-debugging.md) for the workflow, CLI examples, and limits.

## More workflows

### Capture a full page

Use **Quick Actions → Full-page screenshot** for automatic scrolling, a long image you scroll yourself, or the visible area. This extension feature also works without an agent or daemon connection.

For a page in an agent session:

```sh
bsk screenshot --session <id> --full-page --out page.png
```

Agent capture supports background tabs without focusing the window and restores the original scroll position when the document remains available. Full-page capture follows the document's scroll area; nested scrolling panels and virtualized lists have limitations. [Screenshot guide](docs/long-screenshot.md)

### Choose a browser profile

Open the extension in the intended profile and choose **Copy profile instructions**, then send those instructions with your task. You can also assign a unique **Browser name** and select it explicitly:

```sh
bsk browsers
bsk session start --browser "Work profile" --no-focus --json
```

The name is set in BrowserSkill; it is not automatically taken from Chrome's profile name. Each session stays bound to the selected instance. [Profile selection guide](docs/browser-profiles.md)

### Run the agent on a server

Keep the browser and its logins on your computer while the agent, CLI, and daemon run on a server. Pair the extension with that server over authenticated WSS; the browser initiates the connection, so your computer needs no inbound port.

The built-in server supports device pairing, renewal, and revocation. Remote mode currently does not support file upload or download. [Remote connection guide](docs/remote-extension-connection.md)

## Browser control and privacy

An Agent Window shares the selected profile's login state; **it is not a separate account or security sandbox**. Agents can act with the permissions of the signed-in websites, so choose the tasks and agent you trust.

The extension has two independent **Automation settings**, both enabled by default:

| Setting | What it controls |
| --- | --- |
| **Confirm before borrowing tabs** | Ask before an agent takes control of one of your existing tabs. Turning it off permits borrowing without that prompt. |
| **Allow requests for human help** | Let the agent ask you to handle login, verification, or another step that needs your participation. |

By default, sessions use a dedicated Agent Window. For a local session,
`session start --in-window` instead creates an agent-controlled tab in the
last-focused normal user window and leaves that host window open during cleanup.
This mode requires protocol 1.4 and cannot be combined with remote mode or window
dimensions. Adding `--no-focus` starts the tab inactive; `record start` continues
to use a dedicated window.

With protocol 1.5, `session start --current-tab` or `--tab-id ID` reuses an existing
user tab in place after confirmation. Stopping the session releases the tab without
moving or closing it. `--ephemeral` gives the session an owner lease; clients can
renew or release it with `session lease`. The DSH plugin renews its leases while
connected. Idle sessions still expire, and `session list` reports ownership,
lifecycle, lease expiry, and cleanup failures. The extension records owned browser
resources so a restarted service worker can finish interrupted cleanup.

These browser settings apply to existing and new sessions. Legacy `--unattended`, `tab borrow --no-confirm`, and `BSK_REQUEST_HELP=off` inputs cannot override them. Disabling human help does not mean the requested step was completed. Close the Agent Window to stop its tasks.

BrowserSkill does not operate a mandatory cloud service or collect product telemetry. Automation results go to your selected daemon or gateway and the agent using it; that agent or service may process or retain them under its own policies. The extension does not independently call an AI provider.

| Optional history | Where it is saved | What to know |
| --- | --- | --- |
| **Website debugging** | The current browser profile, including in remote mode | Retains captured evidence, including available bodies and field values. Stopped records expire after 30 days, with a 50-record / 50 MiB retention budget and earlier eviction when necessary. Stop capture before deleting a record. |
| **Operation audit** | The daemon's host, under `BSK_HOME/audit` | Off by default. Records task and operation metadata, excluding input values, page bodies, screenshots, and file contents. Ended tasks expire after 30 days. |

Both offer export and deletion. Stopping a task or disconnecting does not delete saved history; expiration is applied during history access or cleanup. Exported copies and copies already received by an agent or gateway must be managed separately. Known secrets are filtered from debugging evidence, but redaction cannot guarantee that all sensitive data is removed.

[Privacy policy](apps/extension/PRIVACY.md) · [Operation audit](docs/operation-audit.md) · [Debugging retention and limits](docs/website-debugging.md#history-and-export)

## Updating

Finish active browser tasks, then update the CLI:

```sh
bsk update --yes
```

For the default local setup, this restarts a running daemon when an update is installed. If Windows reports a staged update, wait for replacement to finish. If you use the installer to replace the binary, restart the daemon afterwards with `bsk daemon restart`.

Update the extension through its browser store. Update the DSH plugin separately, then restart its profile:

```sh
dsh plugin --profile web update @wxg-prc-cpg/browser-skill-dsh-plugin --latest
```

Check `bsk --version`, `bsk status`, and `bsk doctor`. Keep the CLI, running daemon, extension, and optional DSH plugin on matching releases for new features. This README describes the current repository; store builds can lag during review. Check the [changelog](CHANGELOG.md) and [releases](https://github.com/Tencent/BrowserSkill/releases) for availability.

Managed CLI skills update on daemon startup, `session start`, or `doctor` while their files remain unchanged. Local edits and custom skills are preserved. Start a new agent session to load updated instructions; doctor reports any paused skill updates.

<details>
<summary><b>Custom ports, sandbox hosts, and remote servers</b></summary>

Stop the daemon in its owning host or supervisor, update with `bsk update --yes --no-restart-daemon`, then start it there with its original flags and `BSK_HOME`. Use `BSK_AUTO_START=0` in agent commands during this process. Follow the [sandbox](docs/sandboxed-agents.md) or [remote](docs/remote-extension-connection.md) guide for your deployment.

</details>

## Documentation

| Goal | Guide |
| --- | --- |
| Install and verify with an agent | [Agent setup](AGENT_INSTALL.md) |
| Investigate a website or API | [Website debugging](docs/website-debugging.md) |
| Capture long pages | [Full-page screenshots](docs/long-screenshot.md) |
| Use a specific account or profile | [Browser profiles](docs/browser-profiles.md) |
| Connect a server-side agent | [Remote browser connections](docs/remote-extension-connection.md) |
| Run in a sandbox | [Sandboxed agents](docs/sandboxed-agents.md) |
| Review recorded task metadata | [Operation audit](docs/operation-audit.md) |
| Integrate with DeepSeek Harness | [DSH plugin](packages/dsh-plugin-browserskill/README.md) |
| Understand the implementation | [Architecture](docs/architecture.md) · [Protocol](crates/bsk-protocol/README.md) |

## For Developers

The repository is a Rust + pnpm workspace. For a source build, use Rust stable, Node.js 22, and the pnpm version declared in `package.json`:

```sh
pnpm install --frozen-lockfile
cargo build --release --locked
pnpm ext:build
```

The CLI is built under `target/release/`; load `apps/extension/dist/chrome-mv3/` as an unpacked extension. For extension development, use `pnpm ext:dev`.

| Directory | Component |
| --- | --- |
| `crates/bsk-cli` | CLI, daemon, and bundled agent skill |
| `crates/bsk-protocol` | Wire types and JSON schemas |
| `apps/extension` | Browser automation, debugging workspace, and extension UI |
| `packages/dsh-plugin-browserskill` | DeepSeek Harness integration |
| `packages/ui`, `packages/i18n`, `packages/vom` | Shared UI, localization, and page observation |
| `evals/browser` | Local test pages and browser capability evaluations |

Run `cargo test --workspace --locked`, `pnpm ext:test`, and `pnpm lint` for the relevant checks. See the [browser evaluation guide](evals/browser/README.md) for reproducible browser cases. Bug reports and focused contributions are welcome through [GitHub Issues](https://github.com/Tencent/BrowserSkill/issues) and pull requests; remove sensitive data before attaching browser evidence.

The extension interface supports English, Simplified and Traditional Chinese, Korean, Japanese, French, Italian, Spanish, German, and Brazilian Portuguese. See [localization](packages/i18n/README.md) to contribute translations.

## License

[MIT](LICENSE)
