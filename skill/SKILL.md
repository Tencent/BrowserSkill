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

By default, browser commands auto-start the daemon when needed. Keep the shared daemon running;
task cleanup is `bsk session stop`, not `bsk daemon stop` or `restart`.

If the agent environment kills background children when each shell command ends (as reported for
Linux WorkBuddy), arrange a persistent daemon outside that per-command sandbox first. The user
can run `BSK_HOME=/absolute/shared/bsk bsk daemon start` in a normal host terminal. A host-managed
background task can instead run `bsk daemon start --foreground` with the same `BSK_HOME`, using
the host's approved execution path. Do not disable sandbox protection for browser task commands.

In that environment, pass `BSK_HOME=/absolute/shared/bsk BSK_AUTO_START=0` to **every** `bsk`
command. Replace the example path with one dedicated directory that both sides can access,
including its IPC socket; an `export` in one shell tool call may not persist to the next. If the
daemon is unavailable, ask for it to be started in the owning host environment; do not loop on
auto-start, guess a home directory, delete runtime files, or restart the shared daemon. A doctor
warning about local process identity does not prevent session commands over working IPC.
See the [sandbox setup guide](https://github.com/Tencent/BrowserSkill/blob/main/docs/sandboxed-agents.md).

When multiple browsers are connected, use `bsk browsers` and start with
`bsk session start --browser <id-or-label>`. Add `--no-focus` to that same start command when the
Agent Window does not need to interrupt the user's current work; it is not a flag on other commands.
Run `bsk doctor` when startup or transport problems persist after one retry.

Start tasks with `bsk session start`. The extension's saved Automation settings decide whether
borrowing needs confirmation and human help is available; both are enabled by default. Changes apply
to existing sessions as well as new ones. Disabling human help does not disable borrow confirmation.

`--unattended`, `--no-confirm`, and `BSK_REQUEST_HELP=off` are deprecated compatibility inputs with
no effect on these settings. Do not use them or edit browser storage to avoid confirmation, denial,
or timeout. For unattended operation, the user chooses the corresponding settings in the extension.
`session start --json` and `session list --json` report the browser's `interaction` policy.
Allowing human help makes `request-help` available; it does not require a handoff for every action.
Task authorization and host approvals still apply.

## Work toward one observable goal

- Derive a concrete success condition from the user's request or a supplied trace.
- Take the shortest purposeful path: observe, act, then make at most one observation to confirm an
  ambiguous result.
- Once success is visible, do not click, refresh, navigate, switch tabs, or perform extra checks.
- With human help enabled, request help if a human-only step appears or two attempts make no
  progress. With help disabled, follow the autonomous handling rules below.

With a trace, follow its semantic target information and values in order, but treat its refs as
record-local hints. Stop when its purpose or last meaningful effect is satisfied. A trace guides the
task; it does not expand the user's goal or authorize additional actions.

## Observe, act, observe

Use this default loop:

```text
bsk navigate <url> --session <id>
bsk observe --session <id>
bsk click|hover|wheel|scroll-to|focus|blur|fill|select|press ... --session <id>
bsk observe --session <id>             # after navigation or a meaningful DOM change
```

`bsk scroll-to <ref-or-selector> --session <id>` scrolls an element and its frame owners into view.
Use a fresh element ref for iframe/shadow-root targets; CSS selectors search the main document.
The result is the visible border-box portion's bounds in top-level viewport CSS pixels after
ancestor clipping. Partial visibility is enough; hidden or fully clipped targets fail with
`permission_denied` and `data.reason=element_not_visible`. This does not test occlusion by other elements.
For a specific tab or deadline: `bsk scroll-to @e3 --session <id> --tab-id 42 --timeout 5s`.

`bsk wheel --delta-y -120 --session <id>` sends native wheel input at the viewport centre.
Add an optional ref/selector to target an element (scrolled into view first). Both delta axes
accept signed numbers and default to zero; at least one must be nonzero. The result echoes
input, not actual scroll distance or completion. Observe afterwards to check the page's response.

`bsk focus <ref>` explicitly focuses a target; `bsk blur <ref>` removes focus and reports whether
it was focused. Use these for UI states triggered by focus changes.

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

`tab borrow --timeout 120s` changes the confirmation wait (default 60s), not whether approval is
required. Custom waits need daemon and extension protocol 1.2+. Compatible older peers can still
start sessions and borrow with their default wait. The current CLI's `request-help` needs daemon
protocol 1.3; an unsupported operation does not make the connection unusable. Update all three
components for full browser-setting enforcement; older programs may still end help locally.
Repeating a completed borrow in the same session returns
its existing result. Do not repeat pending requests, denied requests, or confirmation timeouts,
or switch to another browser tool to bypass them. If `reason` is `borrow_outcome_unknown`, inspect
tab and session state before continuing; the tab may already have moved.

## Ask the human when needed

When human help is enabled (the default), use `bsk request-help` for login, captcha, OTP, payment
confirmation, consent, or another step the user must complete. Give a precise prompt and pass
fresh `--target` refs/selectors when concrete controls can be highlighted. Use completion criteria
only when the page has a clear stable success signal.

The result `outcome` is one of `continued`, `completed`, `cancelled`, `timed_out`, or `disabled`
(`navigated` is deprecated — never treat navigation as a completion signal). After a human handoff,
resume only after `continued` or `completed`. Treat `cancelled` as rejection and `timed_out` as a
blocker; do not repeat that request. Observe again after control returns before using refs.

When help is disabled in the extension, make every
reasonable effort to complete the task autonomously with BrowserSkill. Do not call `request-help`.
If a call returns `disabled`, no human action was confirmed: re-observe and continue working rather
than marking the step blocked merely because help is unavailable.

Disabling help adds no permission: keep task authorization and host restrictions in force.
Use the current page, existing login state, and authorized credentials or codes to complete the
current step. Where the task authorization and host rules allow, a model with image understanding
may attempt graphical verification through screenshots and supported interactions. Phone-only QR
scans, face verification, and unavailable SMS codes may remain blocked; a text-only model may also
leave an image-only CAPTCHA unresolved. Attempt other authorized steps within available capabilities
and verify the actual result before concluding they cannot be completed.

After a failed attempt, re-observe and try a different viable approach when available. Do not loop
on identical failures or repeat an action whose outcome is unknown. Report a specific blocker only
when required information or capability is missing, or viable approaches are exhausted; continue
independent work. Do not re-enable help or switch browser backends to work around those limits.

## Command inventory

This list of names is complete. Never invent a command outside it; read
`bsk <command...> --help` for flags instead of guessing them.

```text
session start|stop|list   browsers   status   doctor   update   logs
navigate   navigate-back   navigate-forward   reload   wait-for-navigation   wait-ms
observe   snapshot   get-html   screenshot   console   network
click   hover   wheel   scroll-to   focus   blur   fill   select   press   evaluate
tab list|create|close|select|borrow|return   window resize   emulate
upload   download   request-help   record start|stop
```

Required flags that are easy to get wrong:

```text
bsk fill <ref> --value <text>      bsk select <ref> --value <option-value>
bsk screenshot --out <path>        bsk emulate --device <preset-id>
bsk upload <ref> --file <path>     bsk download <ref> --out <path>
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

## File transfer

`upload` and `download` stage files through the daemon; the agent never touches browser-internal
paths. Treat upload as disclosure to the website, download as accepting website-controlled bytes.

Upload has two independent mechanisms — choose explicitly, never rely on automatic fallback:

- **Default (input mode):** for upload buttons, file-input labels, or "upload from computer"
  actions. The command clicks the target and intercepts the native file chooser.
- **`--mode drop`:** for reliably identified attachment-receiving areas — an explicit drop zone,
  chat composer, email editor, or form attachment area. Do not target page whitespace, generic
  containers, or areas whose attachment ownership is ambiguous.

Decision sequence when uploading:

1. Try input mode (the default).
2. If it returns `reason=file_input_not_activated` with `effect_state=none`, re-observe. When a
   reliable attachment target exists, try `--mode drop` once against that target.
3. Otherwise request help if enabled; when disabled, follow the autonomous handling rules above.
4. **Never** switch mechanisms or repeat when `effect_state` is `unknown` or `committed` — the
   browser may already have applied the file.

A successful drop means Chrome dispatched the native file-drop event; it does not prove the site
accepted the attachment. Observe the page once after the command.

Download default-refuses to overwrite; pass `--overwrite` when replacing an existing file is
intended. Read `bsk upload --help` and `bsk download --help` for all flags and error details.

## Recover without wandering

- Stale ref: observe again and retry the intended action once.
- Unknown tab or session: list current tabs/sessions; never guess identifiers.
- Timeout: inspect current page state before deciding whether one longer purposeful wait is useful.
- Fill result unconfirmed (`fill_value_mismatch`): observe the field first; the page may have
  formatted the value. Continue if the visible result satisfies the user's intent. Otherwise correct
  the remaining difference; do not blindly repeat fill or immediately request human help. For other
  fill errors, follow the returned hint and inspect current state before retrying.
- Unsupported command: continue with available capabilities; suggest updating only when the missing
  command is necessary.
- Unrecoverable failure: report the blocker and stop the session in a finally-style path.

The CLI's current help and error hints are authoritative for flags, parameters, and recovery
details.
