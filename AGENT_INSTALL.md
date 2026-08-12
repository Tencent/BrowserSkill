# browser-skill — Install Guide for AI Agents

You are an AI agent setting up browser-skill for the user. Done = `bsk doctor`
reports every check `ok` (or `na`). Never use `sudo`; you cannot install the
extension yourself (Step 3 is the user's job).

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

```bash
bsk doctor
```

Each `fail` row prints a `hint` — follow it and re-run once. A fresh install
where only `extension connected` fails is expected; go to Step 3.

## 3. Open the extension install page

If `extension connected` is `FAIL` (`0 browsers connected`), the user likely
has not installed or enabled the browser extension yet. Open the
[Chrome Web Store install page](https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi)
in the user's browser, then tell the user:

> Install **BrowserSkill** from the
> [Chrome Web Store](https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi),
> open the popup, and wait until it turns green. Reply when done.

If opening the page fails, give the user the same link. Then run `bsk doctor`
once more. All `ok`/`na` → tell the user it's ready.
