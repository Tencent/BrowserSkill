# Select a specific browser profile

BrowserSkill connects to the extension installed in a browser profile. A successful
connection alone does not identify the profile you intended to use. The CLI does
not launch Chrome or accept Chrome's `--profile-directory` argument.

## Bind a task to the intended profile

1. Open the required profile in Chrome. If you need to verify its directory, open
   `chrome://version` in that window and check **Profile Path**.
2. Open BrowserSkill's popup in that same profile and ensure it is connected.
3. Choose **Copy profile instructions** and send the instructions along with your
   task to the agent. The copied instruction includes this profile's extension
   instance ID and requires it on every new session for the task.

You can also copy the **Instance ID** from the popup and use it directly:

```sh
bsk browsers --json
bsk session start --browser <instance-id> --json
```

Replace the placeholder with the popup's instance ID, not Chrome's extension ID,
profile display name or directory name. An existing, verified unique BrowserSkill
label also works; labels are not populated from Chrome profile names automatically.
The instruction only copies text: it does not start a session or change settings.

For a reusable human-readable selector, set **Browser name** in the extension popup,
then confirm it appears in `bsk browsers`. Keep names unique among connected browsers;
label matching is exact and duplicate labels are rejected as ambiguous. Saving a name
briefly reconnects BrowserSkill so the daemon sees it immediately. Renaming is disabled
while that browser has active tasks, so a display-name edit cannot interrupt them. You
can then start a session with, for example:

```sh
bsk session start --browser "Work profile" --json
```

If the target is offline, reconnect BrowserSkill in that profile and retry the
same selector. Do not remove `--browser` to get past the error: that could select
another profile. A missing selector is rejected when multiple browsers are online,
but automatically selects the only connected browser when just one is online.

The session remains bound to its selected instance. Opening or switching Chrome
profiles does not move an existing session. Stop it with `bsk session stop <id>`
when the task ends. Reinstalling the extension or resetting its storage can change
the instance ID; verify the mapping again instead of substituting another browser.
Copying a whole profile can also copy its extension storage, so instance IDs are
routing identifiers, not independent proof of a filesystem path.

## DeepSeek Harness

Use the verified popup instance ID in the plugin's session tool:

```text
browser_session({ action: "start", browser: "<verified-instance-id>" })
```

**Copy profile instructions** includes this tool call alongside the CLI command.
Use the DeepSeek Harness call instead of running a separate CLI session. The plugin
manages its own sessions. Supply the same selector on every new session for the task, even if
only one browser is connected. If the mapping is unknown or the target is offline,
ask the user to confirm or reconnect it; do not retry without `browser`.

## Scope and limitations

This is a manual profile-to-instance workflow, not automatic profile discovery or
a persisted task/workspace requirement. Explicit selectors reject unavailable or
ambiguous targets. Neither the CLI nor the DSH plugin can infer a profile requirement
from the user's conversation if the agent omits the selector: with only one browser
connected, an unqualified start can still select the wrong profile. The skill and
copied instructions guide the agent; they do not enforce a binding on future calls.

## Windows and macOS

The instance-selection workflow is the same on both platforms. The profile path
location differs; use the value displayed by Chrome rather than guessing it.
[Chromium documents this check](https://chromium.googlesource.com/chromium/src/+/main/docs/user_data_dir.md).

Several profiles can run in one Chrome browser process. Its startup command line
may still name the first profile after a second profile opens, so scanning process
arguments cannot prove which profile owns a connected extension. There is no need
to quit all other Chrome profiles to select a connected BrowserSkill instance.
