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

Escalate page reading only as needed:

1. `bsk observe` for normal semantic understanding, text, controls, and refs.
2. `bsk snapshot` when a stricter static accessibility tree is more useful.
3. `bsk get-html` for exact markup or hidden metadata that semantic views cannot provide.
4. `bsk screenshot` for layout, styling, canvas, images, or requested visual evidence.

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

```text
bsk fill <ref> --value <text>      bsk select <ref> --value <option-value>
bsk screenshot --out <path>        bsk emulate --device <preset-id>
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
