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

## Session placement in a user window

By default, `bsk session start` opens a dedicated Agent Window. For a local
normal, non-incognito user window, choose one of these options:

- `bsk session start --in-window --json` creates an agent-owned `about:blank`
  tab in the last-focused user window. `--no-focus` creates it inactive, but
  operations that require focus may still need you to select it.
- `bsk session start --current-tab --json` reuses the active tab in that window.
- `bsk session start --tab-id <id> --json` reuses a specified open user tab.

Existing-tab modes require user approval, do not move or close the selected tab,
and cannot be combined with `--no-focus`. The `--in-window` mode requires
CLI, daemon and extension protocol 1.4; existing-tab modes require 1.5.
These modes do not support remote connections or window dimensions.
`record start` remains dedicated. In a shared session, an omitted tab target
selects a session-controlled page, never an arbitrary active user page.
Same-window borrowing and returning do not move tabs. Stopping a shared
session returns borrowed tabs and closes only agent-created tabs, not the host window.

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
