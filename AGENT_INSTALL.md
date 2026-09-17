# browser-skill — Install Guide for AI Agents

You are an AI agent setting up browser-skill for the user. Done = the intended
harness can load `browser-skill`, `bsk doctor` reports no `fail` checks, and a
small browser task succeeds and cleans up its session. Doctor alone does not
verify skill installation or discovery: no installed skill is reported as `N/A`.
Explain remaining warnings; a local process identity warning permits browser use
over working IPC. Never use `sudo`; the user installs the browser extension.

## Choose the connection mode first

- **Agent and browser on the same computer:** follow the local steps below.
- **Remote, with a configured service or pairing link:** follow
  [pairing and first-use verification](docs/remote-extension-connection.md#pair-and-verify).
  The browser computer needs only the extension; CLI and harness setup belongs on the Agent server.
- **Remote, with a server still to configure:** use Steps 1–2 on the Agent server,
  then follow [server setup](docs/remote-extension-connection.md#standalone-server)
  before checking the connection. Report missing server access or TLS prerequisites.

## 1. Install the CLI

For an existing installation, check `bsk --version` and follow the
[upgrade instructions](README.md#updating) if an update is needed. For a new install:

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.sh | sh
export PATH="${BSK_INSTALL_DIR:-$HOME/.local/bin}:$PATH"
bsk --version
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.ps1 | iex
bsk --version
```

The Unix installer cannot update its parent shell's PATH. Repeat the export in
later shell tool calls if needed, or use the installed binary's absolute path
(`~/.local/bin/bsk` by default; `~/.local/bin/bsk.exe` on Windows). A running agent
may retain its old PATH even after a new terminal picks up the installation.

## 2. Install for the intended agent harness

- **DeepSeek Harness (`dsh`):** follow the [plugin setup](README.md#deepseek-harness-plugin)
  for the user's profile. The plugin supplies its own skill and native tools;
  skip `bsk install-skill`.
- **Other supported harnesses:** inspect the available IDs and paths:

  ```sh
  bsk install-skill --list --json
  ```

  Install into the intended harness explicitly. For Cursor, for example:

  ```sh
  bsk install-skill --harness cursor --json
  ```

  Replace `cursor` with the ID from the list. Explicit `--harness` works even
  when detection is false. `--yes` without `--harness` selects every detected
  harness and fails if none are detected; it does not identify the current agent.
- **Unlisted harnesses:** follow the [manual skill instructions](README.md#quick-start)
  and use that harness's documented skill directory.

Check the install result and destination. Existing files are skipped; inspect
them before deciding whether to keep them or restore the bundled skill with
`--force`, which overwrites the file. Doctor explains paused automatic updates;
custom instructions are preserved. Verify discovery in Step 5.

## 3. Run `bsk doctor`

If this environment reaps child processes after every shell command, first follow
the [sandbox setup guide](docs/sandboxed-agents.md), including its PowerShell examples
for Windows. Reuse the host daemon's existing `BSK_HOME` (or its default if unset),
set `BSK_AUTO_START=0`, and check `bsk status --json`. Reuse a working daemon; a
permission error or timeout is not evidence that it is absent. Only when it is
missing and no host task is already starting it, launch
`bsk daemon start --foreground` in a persistent host task, or use a normal host
terminal as described in the guide. In another shell tool call, confirm status
succeeds before continuing; allow up to five checks with one-second pauses for
transient startup errors. If the task exits or never becomes ready, inspect its
output and `bsk logs`, then recheck for an existing daemon before another launch.
Use the same `BSK_HOME` and `BSK_AUTO_START=0` for every sandboxed command, including
`doctor` and session commands. Keep browser commands sandboxed; environment settings
may not persist across shell calls. Report unresolved errors instead of looping.

```bash
bsk doctor
```

Each `fail` row prints a `hint` — follow it and re-run once. When auto-start is
disabled and the daemon is missing, return to the reuse/startup checks above.
For a path/permission failure, use the resolved path in the report to check the
shared directory and sandbox access rules; do not guess `/home/<user>` or delete
daemon files. A fresh install where only `extension connected` fails is expected;
go to Step 4.

## 4. Connect the browser extension

If the intended browser is already connected, continue to Step 5.

If the extension is not installed, give the user the page matching their browser —
[Chrome Web Store](https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi)
for Chrome and other Chromium browsers,
[Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/browserskill/emacgiaaaiojkkpkddmmdfhmokgmnikg)
for Microsoft Edge — and ask them to install it on the computer with that browser.

- **Local:** ask the user to open the popup, enable the connection and confirm the
  port matches the local daemon; wait for the connected status.
- **Remote:** ask the user to select **Remote connection**, paste the pairing link
  and save it. Follow the [remote verification steps](docs/remote-extension-connection.md#pair-and-verify);
  installing the extension or generating a link alone does not establish a connection.
- **Extension installed but still not connecting?** If `bsk doctor` reports
  `0 browsers connected` while the daemon itself is healthy, check whether Chrome has
  been open since before the CLI and extension were installed. Chrome starts an
  extension's service worker on browser events, not on demand, so the worker can stay
  dormant: `~/.bsk/daemon.log.<date>` then shows no connection attempt at all, not
  even a rejected one. Quit Chrome completely and reopen it once (reloading the
  extension from `chrome://extensions` also works), then open the popup again.
  Opening a new tab, `chrome://restart`, and command-line navigation to a
  `chrome-extension://` URL do not wake it.

After the user completes the browser-side step, run `bsk doctor` on the Agent's
machine. For a managed remote server, use its `BSK_HOME` and `BSK_AUTO_START=0`.

## 5. Verify skill discovery and first use

Confirm that the intended harness lists or can invoke `browser-skill`. If it needs
a new agent session or profile restart to discover the skill, tell the user how
to do that and report verification as pending until it has been loaded there.

Use the installed skill to open `https://example.com` and summarize the page.
For CLI harnesses, start with `bsk session start --no-focus --json`, retain the
returned session ID, then navigate and observe using `--session <id>`. Stop that
session with `bsk session stop <id>` on success or failure. With multiple browsers,
use `bsk browsers` and add `--browser <id>` when starting the session.
For dsh, use its injected `browser_*` tools instead.

Report success only after the page is read and the test session is stopped.
If a step remains blocked, report which part is ready and what remains unverified.
