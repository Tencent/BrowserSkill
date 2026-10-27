## Required browser profiles

If the user or workspace requires a specific profile, confirm its instance ID before
starting, even with only one connected browser. If unknown, ask the user to open the
intended profile, check **Profile Path** at `chrome://version` if a directory was
specified, and copy the **Instance ID** or **Copy profile instructions** from the
connected BrowserSkill popup in that same profile. Connected alone and Chrome's
process arguments do not prove the profile.

Use the verified ID (or verified unique BrowserSkill label) on every new session:

```text
bsk_session({ action: "start", browser: "<verified-instance-id>" })
```

For copied command-line examples, use the instance ID in
this tool call, without running the command. A Chrome profile name, directory,
or extension ID is not an instance ID. If the mapping is unclear/ambiguous or the
target unavailable, stop and ask the user to confirm/reconnect. Never omit
`browser` or substitute another instance to recover.

## Incognito tasks

When temporary login isolation from ordinary browsing is required, start with:

```text
bsk_session({ action: "start", incognito: true, browser: "<verified-instance-id>" })
```

The extension must have **Allow in incognito** enabled, and the CLI, daemon and
extension must support protocol 1.4 or later. Report a permission or
compatibility error instead of retrying in normal mode.

Incognito sessions cannot borrow tabs, and normal sessions cannot borrow incognito
tabs. Create tabs in the task window. All incognito windows in one profile share
login state with each other; they are separate from the profile's ordinary windows.
Website data persists until every incognito window closes, so stopping the session
does not guarantee immediate data removal.

## Borrowing and settings

Use `bsk_tabs` to list IDs before acting. Borrow for the immediate step and
return promptly. Browser Automation settings
govern confirmation and help; never change them to bypass a prompt or repeat
pending/denied/expired borrows. Inspect unknown outcomes; follow version-error hints.
Remote reads/actions require task-created or borrowed tabs; popups gain no control.
An unowned tab inside the Agent Window needs a user move to a user window before borrowing.
