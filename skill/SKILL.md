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

Optional: `bsk session start --browser <instance-id-or-label>` when multiple browsers are connected (`bsk browsers` / error output lists them). Add `--no-focus` to open the Agent Window in the background without stealing focus from the user's current window.

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
bsk observe --session <id>           → primary semantic VOM view; reveals hover/focus surfaces
bsk snapshot --session <id>          → static aria tree fallback when VOM is insufficient
bsk hover @e3 --session <id>          → reveal hover-triggered menus before re-observing/clicking
bsk click @e4 --session <id>          → or bsk fill, bsk select, bsk press
bsk observe --session <id>             → again after navigation / DOM change
```

**Refs invalidate after navigation** — always re-snapshot before clicking, filling, or selecting on a new page.

Prefer `@eN` refs from the latest snapshot over raw CSS selectors. Use `--ref` / `--selector` when ambiguous (`bsk click --help`).

When VOM renders `[hover first: …]` on an element, the listed items are not currently clickable refs. Run `bsk hover <that-ref> --session <id>`, then immediately run `bsk snapshot` or `bsk observe` again and click the newly visible menu item ref. Do not click the trigger itself unless the user explicitly wants the trigger action.

## Observation priority

Start with `bsk observe` to understand page structure, text, controls, element refs, and conditional hover/focus surfaces. Use `bsk snapshot` only when you need the stricter static accessibility tree or VOM is insufficient. Only escalate to raw HTML or screenshots when the latest observation cannot answer the question:

1. `bsk observe` — primary semantic VOM observation; may run bounded perception probes such as hover-surface discovery
2. `bsk snapshot` — strict static accessibility tree fallback
3. `bsk get-html` — when hidden DOM, metadata, or markup details are required
4. `bsk screenshot` — when visual layout, canvas/image content, or styling cannot be inferred from the observation. Use `--ref @eN` (from the latest snapshot/observe) to crop to one element; omit `--ref` for the full visible tab.

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

Auto-update is **on by default** — the background daemon upgrades `bsk` itself when a new release is available (postponed while a session is active). Set `BSK_AUTO_UPDATE=off` to disable it and upgrade manually with `bsk update`.

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
| `bsk session start` | Open Agent Window (`--width`/`--height` for initial size); prints **4-letter session id** |
| `bsk session start --no-focus` | Open Agent Window in the background without stealing focus |
| `bsk session stop <id>` | End session, close Agent Window, auto-return borrowed tabs |
| `bsk session stop --all` | Stop every active session |
| `bsk session list` | List active sessions |

### Window (require `--session <id>`)

| Command | Summary |
|---------|---------|
| `bsk window resize` | Resize the Agent Window (`--width`, `--height`; 100..=7680 CSS px) |

### Device emulation — `bsk emulate` (requires `--session <id>`)

Emulate a mobile device environment on the agent tab via CDP — viewport, User-Agent, and touch — to debug a page's mobile layout and behaviour:

```bash
bsk emulate --session <id> --device iphone-14
bsk emulate --session <id> --width 390 --height 844 --dpr 3 --mobile --ua "Mozilla/5.0 (iPhone…" --touch
bsk emulate --session <id> --off
```

- Presets (`--device`): `iphone-14`, `iphone-14-pro-max`, `iphone-se`, `pixel-7`, `galaxy-s23`, `ipad-mini`, `galaxy-tab-s8`. Manual flags (`--width`/`--height`/`--dpr`/`--mobile`/`--ua`/`--accept-language`/`--touch`/`--max-touch-points`) also work without a preset, or override individual preset fields; `--no-mobile`/`--no-touch` turn a preset's mobile viewport / touch emulation back off.
- Repeated runs merge field by field onto the tab's current emulation state — only the flags you pass change. E.g. after `--device iphone-14`, `bsk emulate --session <id> --width 390 --height 844` keeps the preset's dpr (`3`) and mobile viewport. (The extension remembers the state per tab; after an extension reload the next run applies only the fields it carries.)
- `--off` clears every override (viewport, UA, touch) and the remembered state, restoring the tab's real environment.
- Scope: overrides apply to **one tab only** (CDP per-target) and are **not inherited by new tabs** — re-run `bsk emulate` after opening or switching to another tab (default target is the session's active tab; `--tab-id` overrides).
- Emulation covers viewport/UA/touch only; it does not throttle the network, fake geolocation, or synthesise real touch-event streams.

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
| `bsk snapshot` | First-choice static page understanding: accessibility tree with `@eN` element refs |
| `bsk observe` | Semantic VOM observation with bounded perception probes for conditional surfaces |
| `bsk get-html` | Raw HTML dump after snapshot is insufficient (high token cost) |
| `bsk screenshot` | PNG capture after snapshot is insufficient: full visible tab, or `--ref @eN` to crop to one element (`--out` path optional) |

### Console & network debugging (read-only; require `--session`)

| Command | Summary |
|---------|---------|
| `bsk console` | Buffered page console messages, JS exceptions, and browser log entries (`--include-stack` for stack traces) |
| `bsk network` | Buffered network responses (status, method, URL, MIME/resource type) and failures (`net::ERR_*` reason) |

Both capture from the moment the tab is attached and read a bounded per-tab buffer: `--since <seq>` pages from a cursor (`next_since` in the result), `--limit` (default 50, max 200), `--max-text-chars` (default 1000, max 4096), `--tab-id` to target a non-active tab. Both are strictly read-only — they never intercept or modify traffic, and request/response headers, bodies, and timings are not captured.

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
| `bsk hover <ref-or-selector>` | Move the mouse to an element and wait for hover UI to settle (`--settle`, `--modifiers`) |
| `bsk fill <ref-or-selector> --value <text>` | Clear and type into input |
| `bsk select <ref-or-selector> --value <v>` | Set `<select>` option(s) by `value` (repeat `--value` for multi-select) |
| `bsk press <key>` | Key/combo (`Enter`, `Ctrl+A`, …; optional `--ref` to focus first) |

### File transfer (require `--session`)

| Command | Summary |
|---------|---------|
| `bsk upload <ref-or-selector> --file <path>` | Attach a local file through a file-input trigger; use `--mode drop` for a reliably identified attachment-receiving area (`--file` is repeatable) |
| `bsk download <ref-or-selector> --out <path>` | Click one download trigger and copy the single completed file to an exact local path (`--overwrite` is opt-in) |

The agent/harness decides whether a file transfer is appropriate and which local path belongs to the task. Treat upload as disclosure of that file to the current website, and download as accepting website-controlled bytes onto the local filesystem. Use only paths that are necessary for the user's bounded goal.

BrowserSkill enforces the mechanical boundary: files are staged under a session-scoped opaque transfer, only daemon-minted capabilities reach the extension, upload/download still obey Agent Window tab checks, and transfers are chunk/size bounded. The default upload mode intercepts one chooser transaction, locates the file input activated in the resolved target's document, and assigns only the staged paths. `--mode drop` does not click: it delivers the same staged files through one native browser drop bound to the explicitly resolved attachment target. These mechanisms never fall back to each other automatically. Download uniquely correlates one exact-target browser intent with one Chrome download in either event order, routes it through a daemon-minted relative directory, and lets the daemon validate and import it. Upload staging remains available for a later form submission and is removed when the session ends. Downloads cannot overwrite an existing destination unless `--overwrite` is explicit. BrowserSkill does not inspect file content or decide whether its meaning is sensitive.

Choose the upload mechanism explicitly:

- Use the default input mode for an upload button, file-input label, or “upload from computer” action.
- Use `--mode drop` only when the attachment can be reliably attributed to the target business editor: an explicit drop zone, chat composer, email editor, or form attachment area. Do not target page whitespace, a generic container, or an area whose attachment ownership is ambiguous.
- If input mode returns `reason=file_input_not_activated` with `effect_state=none`, re-observe. When a reliable attachment-receiving area is present, attempt drop once against that area; otherwise use `request-help` when available.
- Never switch mechanisms or repeat an upload when `effect_state=unknown` or `committed`.

A successful drop command means Chrome dispatched the native file drop to the resolved zone; it does not prove that the site's application logic accepted the attachment. Observe the page once after the command, and do not repeat the drop when the attachment is already present.

Do not use `request-help` merely because a native file chooser or browser download is involved; try these commands first. For transfer failures, use the structured error instead of retrying blindly:

- `reason=file_input_not_activated` means the requested click did not activate exactly one `<input type="file">`; the page may use a non-input picker such as `window.showOpenFilePicker()`. Follow the explicit mechanism-selection rule above. If no reliable attachment-receiving area exists, call `request-help` when available and tell the user the exact original local path to choose. The staged daemon path is internal and must not be shown to the user.
- `reason=file_input_probe_failed` means BrowserSkill could not safely establish the browser-side upload transaction. Do not repeat the same action; use `request-help` when available.
- `reason=set_file_input_failed` means BrowserSkill found the activated file input but Chrome rejected the staged path or assignment. Check the extension's file-URL access permission; otherwise use `request-help`.
- `reason=upload_mechanism_unsupported` means the browser cannot perform a native file drop. Do not retry the same drop; use a standard file-input trigger or `request-help`.
- `reason=file_drop_target_unavailable` means the specified point is no longer owned by the resolved attachment target. When `effect_state=none`, re-observe and select the attachment-receiving editor or drop zone itself; do not guess another target.
- `reason=file_drop_failed` means the native drop command failed. Do not retry when `effect_state=unknown`; first observe whether the page already received the file.
- `reason=download_capture_failed` means BrowserSkill could not attribute exactly one completed download to the requested target. Do not retry blindly or accept an unrelated browser download; use `request-help` when available.
- `effect_state=none` means BrowserSkill confirmed that no file-transfer effect was committed. Follow the accompanying reason; a corrected target or explicit human fallback may be attempted.
- `effect_state=unknown` means the browser may already have attached or created the file. Do not repeat the transfer. Observe the page if that can establish the result; otherwise stop and report the uncertainty.
- `effect_state=committed` means the browser-side effect occurred even if later completion or cleanup failed. Do not repeat it; continue only after verifying the resulting page/download state.

If `request-help` returns `outcome="disabled"`, do not retry it. Stop gracefully and report the transfer mechanism that requires human intervention.

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

`request-help` does not refresh the page model after the user returns
control. After a `continued` or `completed` result, issue a separate
observation tool call (usually `bsk snapshot --session <id>`) before using
new refs or reasoning about the post-help page state.
#### Disabling request-help (unattended mode)
Set `BSK_REQUEST_HELP=off` on unattended servers: `bsk request-help` then
returns immediately with `outcome="disabled"` (no overlay, no waiting,
exit 0). Any other value keeps it enabled. If you get `disabled`, do not
retry — complete the task autonomously or stop gracefully.

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
5. **No raw observe escalation before snapshot/observe** — use `bsk snapshot` first; use `bsk observe` when VOM semantics or conditional surfaces help. Only use `bsk get-html` or `bsk screenshot` when snapshot/observe is insufficient. Element screenshots (`--ref @eN`) still require a fresh snapshot/observe ref — never skip observation just to grab a visual.
6. **`evaluate` is powerful and risky** — use only when snapshot + click/fill/select cannot suffice; never on credential surfaces.

---

**More detail for any command:** `bsk <cmd> --help`
