# Tabs and profiles

## Required browser profiles

When the user requires a particular browser profile, bind the task to that
profile's extension instance before starting a session, even if only one browser
is connected. A Chrome profile name or directory is not a BrowserSkill instance
ID or an automatically assigned label.

Use the instance ID from the BrowserSkill popup in the required profile. The user
can choose **Copy profile instructions** there and send the resulting instruction.
If only a profile name/path is supplied and its mapping is unknown, ask the user
to open that profile, verify its Profile Path at `chrome://version`, and copy the
profile instructions. Do not infer the mapping from a single Connected browser
or Chrome process command lines.

Run `bsk browsers --json` to check that the supplied instance is connected, then
pass `--browser <instance-id>` on every new session for this task. A previously
verified unique label also works. If the target is missing or ambiguous, stop and
report it; never omit the selector or substitute another instance to recover.
Opening another Chrome profile does not retarget an existing session. After an
extension reinstall or storage reset, obtain the instance mapping again.

## Borrowing and browser settings

List before borrowing, and return the tab as soon as the relevant step ends:

```sh
bsk tab list --scope user --session <id>
bsk tab borrow <tab-id> --session <id>
bsk tab return <tab-id> --session <id>
```

Borrowing selects the borrowed tab within the Agent Window, preserving the default
for subsequent commands without `--tab-id`. It does not additionally focus the
window. For a background-created tab (`tab create --no-active`), retain the returned
`tab_id` and pass `--tab-id <tab-id>` to observation, navigation and input commands.
Created and borrowed web pages continue running while controlled even after they
move into the background. A default created tab starts at `about:blank`.
Viewport and full-page screenshots of controlled tabs work in the background;
pass `--tab-id` without selecting the target or focusing the window. Prefer
semantic observation first and take a screenshot when the task needs image content.
A viewport screenshot does not issue a Canvas `capture_id`; use the existing
`--ref` flow for screenshot-bound Canvas clicks.

Never invent tab IDs or keep a user tab across unrelated work. Do not repeat
pending, denied or timed-out borrows. For `borrow_outcome_unknown`, inspect tab/
session state first: the tab may already have moved. Do not bypass an outcome
through another browser backend. `tab borrow --timeout 120s` changes only the
confirmation wait (default 60s); custom waits require daemon and extension protocol 1.2+.

The extension's saved Automation settings control borrow confirmation and human
help independently; both default on and apply to existing sessions too. Read
`interaction` in `session start --json` or `session list --json` when needed.
Deprecated `--unattended`, `--no-confirm`, and `BSK_REQUEST_HELP=off` cannot override
these settings. Never change browser storage/settings to bypass them. Human-help
availability does not require permission for every action or grant extra authority.
`request-help` requires daemon protocol 1.3; update CLI, daemon and extension for
full settings support. A feature's version error does not disable other operations.

Remote content reads/actions require task-created or borrowed tabs. Page-opened
popups gain no control automatically; an unowned tab inside the Agent Window
needs the user to move it to a user window before borrowing. Remote upload/download
are unsupported; screenshots work.

## Parallel tasks and shared login state

This guidance applies to the `bsk` CLI skill; the DSH plugin is a separate
skill with plugin-owned session visibility.

Sessions started in the same browser profile share one cookie jar and one set
of site state. Two tasks operating on the same logged-in site - or switching
accounts/tenants there - can overwrite each other's login state with no error
and no obvious trace. Treat a domain overlap as a signal to assess that risk;
it does not by itself require serialization. Independent reads under the same
account, or tasks already running in separate profiles, need not be forced
serial.

Before starting tasks in parallel:

1. `bsk session list --json` and keep the sessions whose `browser_instance_id`
   matches the browser you will use.
2. Drop your own session, then for each remaining session run
   `bsk tab list --session <id> --scope agent --json` and collect the tab URLs.
3. Compare those URLs against each task's planned target domain.

`tab list --scope all` is not sufficient here: it returns only the requesting
session's Agent tabs plus user tabs, and hides other sessions' Agent Windows.

An empty overlap result is a limited observation, not a guarantee of isolation.
A task may still be on `about:blank`, start at the same time as another, or
navigate elsewhere after the check. Re-check when a destination changes.

When tasks run in parallel, each independent task keeps its own session ID and
passes that same `--session <id>` to every later command. Do not infer isolation
from the count of active sessions: N active sessions does not mean N tasks each
use a different session.

Serial execution does not restore a previous login state, so each task still
verifies the expected account or tenant on its target site. When isolating with
a separate profile, follow the profile-to-instance verification and explicit
binding steps above, and preserve any profile the user required.

## Tab groups

```sh
bsk tab group create --session <id> --tab <id> [--tab <id> ...] [--title <t>] [--color <c>]
bsk tab group create --session <id> --tab <id> --group-id <existing-group-id>
bsk tab group update <group-id> --session <id> [--title <t>] [--color <c>] [--collapsed|--expand]
bsk tab group list --session <id>
bsk tab group ungroup <group-id> --session <id>
```

Only tabs already inside the session's Agent Window (own tab or borrowed tab) can
be grouped — same sandbox rule as `tab close` / `tab select`; a tab outside it is
rejected with `permission_denied`. `list` and `ungroup` are scoped to the Agent
Window's own groups the same way. `ungroup` removes tabs from the group without
closing them.

**Choose `--title` from what the tabs are actually about, never a placeholder.**
Read the grouped tabs' titles/URLs first (`bsk tab list --scope agent`) and name
the group after the real topic — e.g. `AI Security Research` for a set of OWASP
LLM Top 10 / prompt-injection / red-team tabs, not `Group 1` or `New Tabs`. If the
tabs cover more than one topic, either pick the dominant one or split the grouping
calls so each group stays about one thing. `--color` is cosmetic; pick one that
fits the topic (e.g. `red` for security-review tabs) or omit it and let the
browser assign one.
