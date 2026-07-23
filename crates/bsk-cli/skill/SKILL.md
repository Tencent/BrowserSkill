---
name: browser-skill
description: |
  Use when the user asks to perform browser automation tasks against their
  logged-in browser: visit and read pages, fill forms, scrape data, click
  through a flow, regression-test a PR's UI, validate a deployed page.
  Requires the bsk CLI installed and the browser-skill extension loaded.
---

# browser-skill

Drive the user's **real Chromium browser** (with their logins and cookies) through the `bsk` CLI. The extension opens an isolated **Agent Window** for automation; the user's normal windows stay protected unless you explicitly borrow a tab.

## When to use

- Open pages, read titles/text, scrape structured data from sites the user can already access
- Fill forms, click through multi-step flows, smoke-test a UI change
- Understand pages with `bsk snapshot` first; use `bsk get-html` or `bsk screenshot` only when the snapshot is insufficient
- Operate on a specific user tab they point you at (after `bsk tab borrow`)

## When NOT to use

- Tasks with **no browser** involved (files, APIs, databases only)
- Installing or configuring the extension (point the user to setup docs instead)
- **Credential harvesting** — never run `bsk evaluate` on banking, SSO, or password-manager pages to extract tokens, cookies, or secrets
- Long-lived control of a user's personal login window — borrow only for the immediate step, then `bsk tab return` or end the session
- Replacing the user's manual browsing when they only wanted an explanation

## Prerequisites

1. `bsk` on `PATH` (Rust CLI from browser-skill)
2. browser-skill **extension** loaded in Chromium and connected (popup shows green)
3. Any `bsk` command auto-starts background services as needed; use `bsk doctor` if anything fails

## Mandatory workflow

Every automation task **must** follow this lifecycle. Do **not** rely on idle timeouts (default session idle is 5 minutes).

```
1. bsk session start              → capture the 4-letter session id printed on stdout
2. … every tool command …        → always pass --session <id>
3. bsk session stop <id>          → REQUIRED when done (even on error paths)
```

Optional: `bsk session start --browser <instance-id-or-label>` when multiple browsers are connected (`bsk browsers` / error output lists them).

Emergency cleanup: `bsk session stop --all` or the Agent Window overlay **Stop all**.

## Stop when the goal is met

Every task is a **bounded goal**, not open-ended browsing. The goal may come from the user's request, a recorded `trace.json`, or both.

1. **Define success first** — one concrete, observable condition derived from the user's words, `purpose`, or the last meaningful step in a trace (e.g. "form submitted", "item added to cart", "playback started").
2. **Take the shortest path** — snapshot → act → at most one check. Do not wander, re-try unrelated actions, or stack exploratory steps.
3. **Stop as soon as success is reached** — run `bsk session stop <id>` immediately unless the user explicitly asked to keep the session open (e.g. "don't close yet", "keep browsing").
4. **No post-success work** — once the goal is met, do not click, refresh, navigate, re-search, switch tabs, or "double-check" that it worked. Further verification is a new task.
5. **When blocked, pause — do not brute-force** — if the page requires human input (login, captcha, OTP, payment confirmation) or an action fails twice with no progress, call `bsk request-help` instead of retrying blindly. See **Ask the human for help** below.
6. **When unsure** — at most one extra `bsk snapshot`. If success looks met, stop. If not, ask the user; do not keep clicking.

**With a trace:** replay steps in order using `target` role/name/tag and raw `value`/`selection` fields. After the last step (or when its `effect.navigated_to` / success hint is satisfied), apply rules 3–4 immediately. The trace guides execution; it does not extend control beyond the goal.

**Without a trace:** the user's request *is* the success condition. Satisfying it ends the task — same stop rules apply.

## Core interaction loop

Write operations only affect tabs in the **Agent Window** (or tabs you **borrowed** into it).

```
bsk navigate <url> --session <id>
bsk snapshot --session <id>          → aria tree with @e1, @e2, … refs
bsk click @e3 --session <id>          → or bsk fill, bsk select, bsk press
bsk snapshot --session <id>            → again after navigation / DOM change
```

**Refs invalidate after navigation** — always re-snapshot before clicking, filling, or selecting on a new page.

Prefer `@eN` refs from the latest snapshot over raw CSS selectors. Use `--ref` / `--selector` when ambiguous (`bsk click --help`).

## Observation priority

Start with `bsk snapshot` to understand page structure, text, controls, and element refs. Only escalate when the latest snapshot cannot answer the question:

1. `bsk snapshot` — default for page understanding and interaction planning
2. `bsk get-html` — when hidden DOM, metadata, or markup details are required
3. `bsk screenshot` — when visual layout, canvas/image content, or styling cannot be inferred from the snapshot. Use `--ref @eN` (from the latest snapshot) to crop to one element; omit `--ref` for the full visible tab.

Do **not** call `bsk get-html` or `bsk screenshot` first just to inspect a page.

## Sandbox rules

| Rule | Detail |
|------|--------|
| Agent Window | `bsk tab create`, `bsk navigate`, `bsk click`, etc. work on agent tabs by default |
| User tabs | Read-only until borrowed: `bsk tab list --session <id> --scope user` then `bsk tab borrow <tab-id> --session <id>` |
| Return borrowed tabs | Call `bsk tab return <tab-id> --session <id>` when finished; unreturned tabs are **auto-returned** on `bsk session stop` |
| Writes off-agent | Commands that mutate the page fail if the tab is not in the Agent Window — borrow or create a tab first |

## Global flags

| Flag | Purpose |
|------|---------|
| `--json` | Machine-readable JSON on stdout (errors too) |
| `--quiet` | Suppress informational stderr |
| `-v` / `-vv` | More verbose logging |

Command-specific flags (timeouts, `--tab-id`, `--wait-until`, …): **`bsk <cmd> --help`**

## CLI command reference (one line each)

Details and flags: **`bsk <cmd> --help`**

### Diagnostics

| Command | Summary |
|---------|---------|
| `bsk status` | Connection health, connected browsers, active sessions |
| `bsk doctor` | Deep diagnostics and repair hints |
| `bsk browsers` | List connected browser instances (ids, labels, versions) |

### Session

| Command | Summary |
|---------|---------|
| `bsk session start` | Open Agent Window; prints **4-letter session id** |
| `bsk session stop <id>` | End session, close Agent Window, auto-return borrowed tabs |
| `bsk session stop --all` | Stop every active session |
| `bsk session list` | List active sessions |

### Tabs (require `--session <id>`)

| Command | Summary |
|---------|---------|
| `bsk tab list` | List tabs (`--scope user\|agent\|all`, default `all`) |
| `bsk tab create` | New tab in Agent Window (`--url`, `--no-active`, `--index`) |
| `bsk tab close <tab-id>` | Close an agent tab |
| `bsk tab select <tab-id>` | Focus an agent tab |
| `bsk tab borrow <tab-id>` | Move a user tab into the Agent Window |
| `bsk tab return <tab-id>` | Return a borrowed tab to its original window |

### Observation (require `--session` unless noted)

| Command | Summary |
|---------|---------|
| `bsk snapshot` | First-choice page understanding: accessibility tree with `@eN` element refs |
| `bsk get-html` | Raw HTML dump after snapshot is insufficient (high token cost) |
| `bsk screenshot` | PNG capture after snapshot is insufficient: full visible tab, or `--ref @eN` to crop to one element (`--out` path optional) |

### Navigation

| Command | Summary |
|---------|---------|
| `bsk navigate <url>` | Go to URL in agent tab (`--wait-until`, `--timeout`) |
| `bsk navigate-back` | History back one step |
| `bsk navigate-forward` | History forward one step |
| `bsk reload` | Reload current tab (`--hard` bypass cache) |

(`bsk navigate back` / `bsk navigate forward` are equivalent subcommands.)

### Interaction

| Command | Summary |
|---------|---------|
| `bsk click <ref-or-selector>` | Click element (`--button`, `--click-count`, `--modifiers`) |
| `bsk fill <ref-or-selector> --value <text>` | Clear and type into input |
| `bsk select <ref-or-selector> --value <v>` | Set `<select>` option(s) by `value` (repeat `--value` for multi-select) |
| `bsk press <key>` | Key/combo (`Enter`, `Ctrl+A`, …; optional `--ref` to focus first) |

### Scripting & timing

| Command | Summary |
|---------|---------|
| `bsk evaluate <expression>` | Run JS in agent tab (see red lines); JS throw → stderr, **exit 0** |
| `bsk wait-for-navigation` | Block until load/DOM idle/etc. (`--wait-until`, `--timeout`) |
| `bsk wait-ms <duration>` | Sleep (`500ms`, `2s`, `1m`; **no** `--session`) |

### Ask the human for help — `bsk request-help`

When a step needs a human (captcha, login, OTP) or you want the user to
confirm an important action, pause and ask:

    bsk request-help --session <id> --prompt "Solve the captcha, then click Done only after the site accepts it" \
      --title "Captcha required" --target @e7 --target "#submit" --timeout 5m

- `--prompt` (required): what the user should do.
- `--title` (optional): custom title for the overlay panel. When omitted,
  the extension shows its default localized title.
- `--target` (repeatable): a snapshot ref (`@e7`) or CSS selector
  (`#submit`) to scroll to and flash-highlight. **Strongly recommended** —
  whenever the prompt refers to a concrete element (a button to click, a
  field to fill, a checkbox to toggle), pass its `@eN` ref / selector so the
  user is guided straight to the right spot instead of hunting for it. For
  interaction scenarios, always include the relevant target(s); reserve a
  prompt with no `--target` for cases where there is genuinely no specific
  element to point at (e.g. "wait for the page to finish loading").
- `--timeout` (default `5m`): how long to wait.
- `--completion-criteria` (optional): JSON success detector. Use it only
  when there is a concrete post-help success signal, e.g.
  `{"any":[{"url_contains":"/dashboard"},{"selector_exists":"[data-testid='account-menu']"}],"stable_for_ms":1000}`.

The target tab is brought to the foreground; the page stays interactive
while the agent control mask is hidden. The call blocks until the user
explicitly acts, the timeout expires, cancellation arrives, or explicit
completion criteria match. Page reloads, SPA route changes, and captcha
refreshes do not return control by themselves. The result `outcome` is one of:

- `continued` — the user finished and clicked Done / return control (treat as confirm).
- `cancelled` — the user clicked Cancel (treat as reject/abort).
- `timed_out` — nobody acted within the timeout.
- `completed` — the explicit `--completion-criteria` matched while the user had control.
- `navigated` — deprecated legacy outcome. Do not rely on navigation as a completion signal.

`note` carries any text the user typed back. `resolved_targets` reports
which refs/selectors matched a live element.

### Recording — `bsk record`

Capture the user's own actions in the Agent Window to a `trace.json`, for later LLM-driven automation:

```bash
bsk record start --browser <instance-id-or-label> [--url https://…] [--purpose "publish a wiki doc"] [--output trace.json]
# `--url` is optional; default https://example.com/ when omitted (must be http(s)).
# Blocks until the user clicks Finish in the recording panel, then writes ./trace.json and closes the window.

bsk record stop [--output trace.json]   # terminal fallback if the browser panel is unavailable
```

- The trace is a **record-only action log** (a `pages[]` dictionary + `navigate`/`click`/`fill`/`select`/`press` steps with `target` descriptors). It records *what the user did*; deciding which inputs are variable is left to the executing agent.
- `--purpose` is optional context metadata; it does **not** change what gets captured.
- There is **no** `bsk replay` — to redo a flow, read the trace and reuse the existing `session` / `snapshot` / `@eN` / `click` / `fill` tools. Follow **Stop when the goal is met**.
- Do **not** record on banking/SSO/password-manager pages; passwords are redacted but traces may still contain sensitive text.

## Error handling

### Exit codes (`echo $?` after `bsk …`)

| Code | Meaning | What to do |
|------|---------|------------|
| `0` | Success (including `evaluate` where JS threw but RPC succeeded) | Continue |
| `1` | User error — bad args, unknown session, tab not in Agent Window, stale ref | Fix args; `bsk session list`; re-snapshot |
| `2` | Protocol / transport — service unreachable, IPC failure | `bsk doctor`; check extension connected; retry the command |
| `3` | Browser / CDP execution failed | Retry; simplify selector; check tab still open |
| `4` | Timeout | Increase `--timeout`; try `--wait-until domcontentloaded` |
| `5` | Version skew (CLI vs extension) | Upgrade/reinstall matching versions |

Human errors print `error:` + `hint:` on stderr; `--json` includes `code`, `message`, `hint`, `exit_code`.

### When to run diagnostics

| Situation | Command |
|-----------|---------|
| Before first task in a session | `bsk status` — extension connected? |
| Any failure you cannot fix in one retry | `bsk doctor` |
| Multiple browsers / wrong target | `bsk browsers` then `bsk session start --browser <id>` |

Always **`bsk session stop <id>`** in a `finally`-style path so the Agent Window closes and borrowed tabs return.

## Red lines

1. **No token theft** — do not `bsk evaluate` on sensitive sites to read `localStorage`, cookies, or auth headers for exfiltration.
2. **No long borrow** — do not leave a user's personal tab in the Agent Window across unrelated tasks.
3. **No skip stop** — always `bsk session stop <id>`; never assume idle timeout will clean up.
4. **No post-success control** — once the user’s goal (or last trace step) is met, do not keep operating the page; stop the session unless they asked to keep it open.
5. **No observe escalation before snapshot** — use `bsk snapshot` first; only use `bsk get-html` or `bsk screenshot` when the snapshot is insufficient. Element screenshots (`--ref @eN`) still require a fresh snapshot ref — never skip snapshot just to grab a visual.
6. **`evaluate` is powerful and risky** — use only when snapshot + click/fill/select cannot suffice; never on credential surfaces.

---

**More detail for any command:** `bsk <cmd> --help`
