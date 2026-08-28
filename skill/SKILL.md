---
name: browser-skill
description: |
  Use when the user asks to automate their logged-in Chromium browser: visit
  and read pages, fill forms, scrape data, click through flows, regression-test
  a PR's UI, validate a deployed page, or operate a tab they identify. Requires
  the bsk CLI and browser extension.
---

# browser-skill

Drive the user's real Chromium browser through `bsk`. Automation runs in an isolated **Agent
Window** with the user's existing logins and cookies. User-window tabs remain protected unless they
are explicitly borrowed.

Do not use this skill for tasks with no browser, for extension installation, or when the user only
wants instructions. Never extract credentials, cookies, tokens, or other secrets from pages.

## Required lifecycle

Every browser task owns a bounded session:

```text
1. bsk session start              # retain the printed 4-letter session id
2. bsk ... --session <id>         # pass it to every session-scoped command
3. bsk session stop <id>          # always run on success and error paths
```

Do not rely on the idle timeout for cleanup. Stop the session as soon as the goal is met unless the
user explicitly asks to keep it open. Stopping also returns borrowed tabs.

Any `bsk` command auto-starts the background services it needs; never manage the daemon by hand.
When multiple browsers are connected, use `bsk browsers` and start with
`bsk session start --browser <id-or-label>`. Add `--no-focus` to that same start command when the
Agent Window does not need to interrupt the user's current work; it is not a flag on other commands.
Run `bsk doctor` when startup or transport problems persist after one retry.

## Work toward one observable goal

- Derive a concrete success condition from the user's request or a supplied trace.
- Take the shortest purposeful path: observe, act, then make at most one observation to confirm an
  ambiguous result.
- Once success is visible, do not click, refresh, navigate, switch tabs, or perform extra checks.
- If a human-only step appears or two attempts make no progress, request help instead of
  brute-forcing.

With a trace, follow its semantic target information and values in order, but treat its refs as
record-local hints. Stop when its purpose or last meaningful effect is satisfied. A trace guides the
task; it does not expand the user's goal or authorize additional actions.

## Observe, act, observe

Use this default loop:

```text
bsk navigate <url> --session <id>
bsk observe --session <id>
bsk click|hover|fill|select|press ... --session <id>
bsk observe --session <id>             # after navigation or a meaningful DOM change
```

Prefer fresh `@eN` refs over CSS selectors. Navigation invalidates refs; large DOM changes may also
make them stale. Observe again before the next interaction.

An observation marks a hover-only surface as `@e1 button "Products" [hover first: Shoes | Bags]`.
The listed items are labels, not usable refs: hover the trigger, observe again, then act on the
revealed item's own ref. Do not click the trigger itself unless the user wants the trigger's action.
`[has-submenu]` and `[expanded]` mark the same kind of trigger without listing what it hides.

`bsk observe` does not hover the page on its own. Reach for `--probe-hover` when a control you have
good reason to expect is absent **and** no marker points at a trigger — that combination is what a
CSS-only hover menu looks like from here. It hovers a bounded set of likely triggers, so it costs a
few seconds and touches the live page; once you know which element hides the menu, `bsk hover <ref>`
is cheaper and more precise.

When `bsk observe` renders
`@eN surface ... [visual-only; requires=image-understanding; ...]`, the ref identifies rendered
canvas content that is not represented by the text observation, not an interactable DOM control.
Keep using any reliable DOM/AX text and controls that appear alongside it. If you can actually
inspect image output, use `bsk screenshot --ref @eN --session <id>` to obtain the visible crop. If
you lack multimodal or image-reading capability, do not take a screenshot and pretend to know its
contents, and never guess coordinates; tell the user that they need to switch to a model with
image-understanding capability. Do not pass a visual surface ref to click, fill, hover, or select;
those commands intentionally reject screenshot-only refs.

Escalate page reading only as needed:

1. `bsk observe` for normal semantic understanding, text, controls, and refs.
2. `bsk observe --probe-hover` once when an expected control is missing and no marker points at a
   trigger.
3. `bsk snapshot` when a stricter static accessibility tree is more useful.
4. `bsk get-html` for exact markup or hidden metadata that semantic views cannot provide.
5. `bsk screenshot` for layout, styling, canvas, images, or requested visual evidence.

Do not start with raw HTML or screenshots merely to discover ordinary controls. When interaction is
needed, obtain a fresh observation before acting on screenshot or HTML findings.

## Respect the Agent Window boundary

Normal page writes affect only Agent Window tabs. To operate a user tab, first list it with
`bsk tab list --scope user --session <id>`, then `bsk tab borrow <tab-id>`. Return it immediately
after the relevant step with `bsk tab return <tab-id>`; never invent a tab id or keep a personal tab
borrowed across unrelated work.

## Ask the human when needed

Use `bsk request-help` for login, captcha, OTP, payment confirmation, consent, or another step the
user must complete. Give a precise prompt and pass fresh `--target` refs/selectors when concrete
controls can be highlighted. Use completion criteria only when the page has a clear stable success
signal.

The result `outcome` is one of `continued`, `completed`, `cancelled`, `timed_out`, or `disabled`
(`navigated` is deprecated — never treat navigation as a completion signal). Resume only after
`continued` or `completed`. Treat `cancelled` as rejection, and `timed_out` or `disabled` as a
blocker rather than a reason to retry. After control returns, run a fresh `bsk observe` before
reasoning about the page or using refs.

## Command inventory

This list of names is complete. Never invent a command outside it; read
`bsk <command...> --help` for flags instead of guessing them.

```text
session start|stop|list   browsers   status   doctor   update   logs
navigate   navigate-back   navigate-forward   reload   wait-for-navigation   wait-ms
observe   snapshot   get-html   screenshot   console   network
click   hover   fill   select   press   evaluate
tab list|create|close|select|borrow|return   window resize   emulate
request-help   record start|stop
```

Required flags that are easy to get wrong:

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
| `bsk upload <ref-or-selector> --file <path>` | Click one upload trigger and attach an agent-readable local file (`--file` is repeatable) |
| `bsk download <ref-or-selector> --out <path>` | Click one download trigger and copy the single completed file to an exact local path (`--overwrite` is opt-in) |

The agent/harness decides whether a file transfer is appropriate and which local path belongs to the task. Treat upload as disclosure of that file to the current website, and download as accepting website-controlled bytes onto the local filesystem. Use only paths that are necessary for the user's bounded goal.

BrowserSkill enforces the mechanical boundary: files are staged under a session-scoped opaque transfer, only daemon-minted capabilities reach the extension, upload/download still obey Agent Window tab checks, and transfers are chunk/size bounded. Upload intercepts the native chooser for one transaction, locates the input activated in the resolved target's document, and assigns only the staged file paths. Download uniquely correlates one exact-target browser intent with one Chrome download in either event order, routes it through a daemon-minted relative directory, and lets the daemon validate and import it. Upload staging remains available for a later form submission and is removed when the session ends. Downloads cannot overwrite an existing destination unless `--overwrite` is explicit. BrowserSkill does not inspect file content or decide whether its meaning is sensitive.

Do not use `request-help` merely because a native file chooser or browser download is involved; try these commands first. For transfer failures, use the structured error instead of retrying blindly:

- `reason=file_input_not_activated` means the requested click did not activate exactly one `<input type="file">`; the page may use a non-input picker such as `window.showOpenFilePicker()`. Do not retry blindly. If human help is available, call `request-help` and tell the user the exact original local path to choose. The staged daemon path is internal and must not be shown to the user.
- `reason=file_input_probe_failed` means BrowserSkill could not safely establish the browser-side upload transaction. Do not repeat the same action; use `request-help` when available.
- `reason=set_file_input_failed` means BrowserSkill found the activated file input but Chrome rejected the staged path or assignment. Check the extension's file-URL access permission; otherwise use `request-help`.
- `reason=download_capture_failed` means BrowserSkill could not attribute exactly one completed download to the requested target. Do not retry blindly or accept an unrelated browser download; use `request-help` when available.
- `effect_state=none` means BrowserSkill confirmed that no file-transfer effect was committed. Follow the accompanying reason; a corrected target or explicit human fallback may be attempted.
- `effect_state=unknown` means the browser may already have attached or created the file. Do not repeat the transfer. Observe the page if that can establish the result; otherwise stop and report the uncertainty.
- `effect_state=committed` means the browser-side effect occurred even if later completion or cleanup failed. Do not repeat it; continue only after verifying the resulting page/download state.

If `request-help` returns `outcome="disabled"`, do not retry it. Stop gracefully and report the transfer mechanism that requires human intervention.

### Scripting & timing

| Command | Summary |
|---------|---------|
| `bsk evaluate <expression>` | Run JS in agent tab (see red lines). JS throw → stderr, **exit 0** (RPC success); use `--json` and check `.ok` to detect JS errors |
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

Capture the user's own actions in the Agent Window to a **trace bundle**, for later LLM-driven automation. New CLI builds request **trace v3** (page observations + action chain); older extensions may still return **trace v2** (actions only), which the CLI exports as a single `trace.json` without `states/`.

```bash
bsk record start --browser <instance-id-or-label> \
  [--url https://…] [--purpose "publish a wiki doc"] \
  [--max-page-tokens 3000] [--redact-values] \
  [--output trace]
# `--url` is optional; default https://example.com/ when omitted (must be http(s)).
# Blocks until the user clicks Finish in the recording panel, then writes:
#   trace/trace.json    — action chain (+ state index when v3)
#   trace/states/       — v3 only: one `sN.txt` observe snapshot per settled page state

bsk record stop [--output trace]   # terminal fallback if the browser panel is unavailable
```

`select` matches an option's `value` attribute, not its visible label. Device preset ids are
lowercase and hyphenated, such as `iphone-14`.

- `console` and `network` provide bounded, read-only debugging evidence.
- `emulate` applies viewport, user-agent, and touch overrides to one tab; new tabs do not inherit
  them. Use `--off` to restore the real environment.
- `evaluate` is a last resort when observe plus normal interactions cannot complete the task. With
  `--json`, inspect `.ok`: a JavaScript exception may still have CLI exit code 0 because the RPC
  succeeded. Never evaluate credential surfaces to read storage, cookies, or auth data.
- `record` captures a user's actions for later replay. Read `bsk record start --help` before use,
  and never record banking, SSO, password-manager, or other sensitive pages.

## Recover without wandering

- Stale ref: observe again and retry the intended action once.
- Unknown tab or session: list current tabs/sessions; never guess identifiers.
- Timeout: inspect current page state before deciding whether one longer purposeful wait is useful.
- Unsupported command: continue with available capabilities; suggest updating only when the missing
  command is necessary.
- Unrecoverable failure: report the blocker and stop the session in a finally-style path.

The CLI's current help and error hints are authoritative for flags, parameters, and recovery
details.
