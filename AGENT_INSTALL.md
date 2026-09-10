# browser-skill — Install Guide for AI Agents

You are an AI agent setting up browser-skill for the user. Done = `bsk doctor`
reports no `fail` checks. Explain any remaining warnings to the user; a warning
about local process identity permits browser use over working IPC. Never use
`sudo`; you cannot install the extension yourself (Step 3 is the user's job).

## 1. Install the CLI and skill

Run the install command from [`README.md`](README.md):

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.sh | sh
bsk install-skill --yes
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.ps1 | iex
bsk install-skill --yes
```

## 2. Run `bsk doctor`

If this environment reaps child processes after every shell command, first follow
the [sandbox setup guide](docs/sandboxed-agents.md): arrange a persistent daemon
in the owning host environment, then use the same accessible `BSK_HOME` and
`BSK_AUTO_START=0` for every sandboxed command, including `doctor` and the session
commands. Keep normal browser commands sandboxed. Do not assume one `export`
persists across separate shell tool calls.

```bash
bsk doctor
```

Each `fail` row prints a `hint` — follow it and re-run once. When auto-start is
disabled, an unavailable daemon needs host-side startup using the same directory.
For a path/permission failure, use the resolved path in the report to check the
shared directory and sandbox access rules; do not guess `/home/<user>` or delete
daemon files. A fresh install where only `extension connected` fails is expected;
go to Step 3.

## 3. Open the extension install page

If `extension connected` is `FAIL` (`0 browsers connected`), the user likely
has not installed or enabled the browser extension yet. Open the install page
matching the user's browser —
[Chrome Web Store](https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi)
for Chrome and other Chromium browsers,
[Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/browserskill/emacgiaaaiojkkpkddmmdfhmokgmnikg)
for Microsoft Edge — then tell the user:

> Install **BrowserSkill** from the
> [Chrome Web Store](https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi)
> (or [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/browserskill/emacgiaaaiojkkpkddmmdfhmokgmnikg)
> on Edge), open the popup, and wait until it turns green. Reply when done.

If opening the page fails, give the user the same link. Then run `bsk doctor`
once more. No `fail` checks → tell the user it's ready and explain any warnings.
