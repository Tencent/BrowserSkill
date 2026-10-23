# BrowserSkill for DeepSeek Harness

[![npm version](https://img.shields.io/npm/v/@wxg-prc-cpg/browser-skill-dsh-plugin)](https://www.npmjs.com/package/@wxg-prc-cpg/browser-skill-dsh-plugin)

Use [BrowserSkill](https://github.com/Tencent/BrowserSkill) in
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) to browse
websites, fill forms, and capture screenshots through native `bsk_*` tools.
Browser tasks run in Agent Windows, with a live view in the dsh Web UI.

## Installation

Before installing the plugin:

- Install [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and
  [pnpm](https://pnpm.io/installation), which dsh uses to manage plugins.
- Install the `bsk` CLI and connect the BrowserSkill extension in Chrome or Edge.
  Follow the [BrowserSkill setup guide](https://github.com/Tencent/BrowserSkill#quick-start).
- Make sure `bsk` is on the `PATH` used to start dsh, or set `bskPath` in the plugin configuration.

Install the plugin into the `web` profile, then start it:

```sh
dsh plugin --profile web add @wxg-prc-cpg/browser-skill-dsh-plugin
dsh --profile web
```

Replace `web` with your profile name if you use a different profile. The plugin
includes the complete `browser-skill` package; no separate `bsk install-skill` step is needed.
Its compact entry point loads first; references ship with the plugin and are read only
when needed. Relative paths resolve from the packaged skill directory, not your project.

In a conversation, try:

```text
/browser-skill open example.com and summarize the page.
```

By default, the browser tools become available when the skill is invoked.

The plugin declares support for DSH `^0.1.5-rc.3 || ^0.2.0-rc.1`.
DSH 0.2 checks these peer requirements before loading the plugin; versions outside
this range are not declared compatible. The range preserves the existing 0.1.x
baseline and admits 0.2.x without opting into future 0.3.x hosts.

## Updating

Installed plugins do not update automatically. To upgrade this plugin to npm's
`latest` version, including versions outside the profile's saved dependency range:

```sh
dsh plugin --profile web update @wxg-prc-cpg/browser-skill-dsh-plugin --latest
```

Restart that dsh profile after upgrading. This command updates the plugin; update
the `bsk` CLI and browser extension separately when a release requires it.

### Breaking tool API migration (0.3.3)

The coordinated 0.3.3 release replaces all six `browser_*` tool names with stable
BrowserSkill-specific names. This avoids collisions with other browser plugins
such as `dsh-builtin-browser`; both plugins keep their own tools and sessions.

| Previous name | New name |
| --- | --- |
| `browser_session` | `bsk_session` |
| `browser_page` | `bsk_page` |
| `browser_inspect` | `bsk_inspect` |
| `browser_interact` | `bsk_interact` |
| `browser_tabs` | `bsk_tabs` |
| `browser_assist` | `bsk_assist` |

The tool-name migration leaves actions, parameters, results and `/browser-skill`
unchanged. The old tool
names are not registered as aliases. After upgrading, restart the DSH profile and
invoke `/browser-skill` again in existing conversations to load the new instructions.
Update hardcoded tool calls, allow/deny lists, and `toolOrder` entries to the new
names. Do not replay old calls unchanged: another plugin may own those names.

Existing conversation logs and screenshot attachments are left intact. New
`bsk_inspect` results use the screenshot view; old `browser_inspect` cards may use
DSH's generic renderer and do not retain the custom thumbnail/preview interaction.
This is a breaking change from 0.3.2. Upgrade the CLI and browser extension to
0.3.3 before upgrading this plugin to use the new video, extraction and element-wait
capabilities. Updating the npm package does not update either component.

## Tools

| Tool | Actions | Purpose |
| --- | --- | --- |
| `bsk_session` | `start`, `stop`, `list`, `share`, `sync`, `wait-user`, `cooperation-status` | Manage owned sessions and shared-tab control. |
| `bsk_page` | `navigate`, `back`, `forward`, `reload`, `wait`, `wait-for-element`, `dialog` | Navigate the active tab; wait for page lifecycle events or one element condition; answer native JavaScript dialogs. |
| `bsk_inspect` | `observe`, `snapshot`, `html`, `screenshot`, `console`, `network`, `debug`, `video`, `extract` | Inspect page state, debug websites, capture screenshots or requested task videos, and export structured tables/lists. |
| `bsk_interact` | `click`, `hover`, `wheel`, `scroll-to`, `focus`, `blur`, `fill`, `select`, `press`, `evaluate`, `upload`, `download` | Interact with controls using fresh refs or selectors. |
| `bsk_tabs` | `list`, `create`, `select`, `close`, `borrow`, `return` | Manage Agent Window tabs and temporarily borrow user tabs. |
| `bsk_assist` | `resize`, `emulate`, `request-help` | Resize or emulate the browser and pause for human-only steps. |

For `bsk_page` with `action: "wait-for-element"`, see the
[element-wait reference](skill/references/interaction-details.md#element-waits) for
supported conditions, timeout results and recovery with existing single actions.

For native wheel input (`action: "wheel"`), see the [wheel reference](../../docs/wheel.md)
for signed deltas, optional targets, result semantics and interruption.

For `bsk_interact` with `action: "scroll-to"`, see the
[scroll-to reference](../../docs/scroll-to.md) for parameters, visible bounds and errors.

For `bsk_inspect` with `action: "extract"`, see
[structured extraction](../../docs/structured-extraction.md) for discovery, list
fields, JSON/CSV output and loaded-DOM completeness.

Scripts and file transfers use `bsk_interact` actions `evaluate`, `upload` and `download`,
with the same session ownership and observation context as other actions. Interaction recording
is not exposed by this plugin.

Human/agent collaboration is enabled automatically for new sessions and owned task tabs.
No `share` call is required. See [cooperation](skill/references/cooperation.md).
Actions on shared tabs require the `contextId` returned by `sync`; each context is used once.

### Activation failures

The six tools register as a complete suite. If any registration fails, the plugin
rolls back that attempt and reports the failing tool through DSH's logger. A model
invocation of `skill` returns an error instead of claiming successful activation;
slash-command and restored conversations receive a scoped notice. Unrelated
conversations continue normally, and repeated identical failures do not flood logs.

Resolve the reported registration error, then invoke `/browser-skill` again or
start the next turn to retry. Session entry and service discovery also retry a
pending activation; streaming events do not. The affected conversation receives
one recovery notice. If the failed model call never delivered the skill body,
the notice asks the model to load it before using the tools. With `lazyTools: false`,
a registration failure fails plugin startup and releases its resources; reload
after fixing it.

## Multi-session model

One agent conversation can drive several browser sessions at once:

- `bsk_session` with `action: start` returns the session id and makes it the **current session**.
- Every operation tool accepts an optional `session` argument. When omitted, the call acts on the
  current session (the one most recently started or used); when given, that session becomes current.
- Every tool result echoes the session it actually acted on, so the model never has to guess.
- The number of concurrent sessions started through the plugin is capped (`maxSessions`, default 5).
- Unloading the plugin stops every session it started and kills in-flight bsk processes.

Starts are journaled before creating a window. Lost replies and failed cleanup remain
recoverable on reload; `bsk_session action=list` reports `pendingCleanup`, and stop
can retry it even when there is no current session. This requires a CLI and daemon
that support recoverable starts. See [the lifecycle contract](../../docs/recoverable-session-starts.md).

Stops also retain their target and cleanup intent. A failed or interrupted stop can be
retried without accidentally stopping the next current session. Once the intent is saved,
cancelling the call only stops waiting; cleanup continues in the background. If it finishes
before a retry, that retry acknowledges the original result. With several unacknowledged
stops, pass `session` or the owned `requestId` explicitly (not both). List exposes request
IDs; stop results include `requestId` and `alreadyClosed`. Completed receipts survive reload
until acknowledged and do not occupy browser capacity.

**Ownership boundary**: the bsk daemon may be shared with other agents, terminals, or dsh
instances. The plugin therefore only ever sees and operates on sessions it created itself —
an explicit `session` argument naming a foreign or unknown id is rejected, the `list` action on
`bsk_session` shows plugin-created sessions only (no daemon-wide view), and stop/unload cleanup
can never touch a session owned by another program.

## Configuration

After installing the plugin, edit your profile's `cordis.patch.yml`. For the `web`
profile, the default location is `~/.dsh/profiles/web/cordis.patch.yml`. If you set
`DSH_HOME`, use `$DSH_HOME/profiles/web/cordis.patch.yml` instead. Replace `web` with
your profile name as needed.

If the file contains only comments and `[]`, keep the comments and replace `[]`
with the YAML below. If it already contains patch entries, add this entry to the
existing list or edit its existing `id: browserskill` entry. Keep a single
top-level YAML list. This overrides the plugin registered by the installed bundle:

```yaml
- id: browserskill
  config:
    bskPath: bsk
    defaultTimeoutMs: 120000
    maxSessions: 5
    observationEnabled: true
    thumbnailIntervalMs: 1500
    idleIntervalMs: 8000
    lazyTools: true
```

Change `bskPath` to the full path of your CLI binary if it is not on dsh's `PATH`.
A patch replaces the entry's entire `config` object, so keep all overrides you need
together in that object.

Configuration changes follow `dsh.profile.patchReload` in the profile's
`package.json`: `live` (the default for `web`) applies changes when you save the
patch file; `startup` requires restarting the profile. Restart after upgrading
the plugin in either case.

All fields are optional; omitted fields use the defaults below:

| Option | Default | Purpose |
| --- | --- | --- |
| `bskPath` | `bsk` | Path to the CLI binary. |
| `sessionStateDirectory` | Scoped under `$BSK_HOME/dsh-starts` (or `~/.bsk/dsh-starts`) | Durable recovery records; optionally isolate by host/profile. |
| `defaultTimeoutMs` | `120000` | Default command execution timeout in milliseconds; output collection after exit has a separate 2-second limit. |
| `maxSessions` | `5` | Maximum concurrent sessions started by this plugin. |
| `observationEnabled` | `true` | Enable live browser observation. |
| `thumbnailIntervalMs` | `1500` | Screenshot interval for active sessions, in milliseconds. |
| `idleIntervalMs` | `8000` | Screenshot interval for idle sessions and the recent-activity window, in milliseconds. |
| `lazyTools` | `true` | Reveal the browser tools when the skill is invoked. Set `false` to register them at startup. |

With `lazyTools: true`, only the skill's catalog entry is initially advertised to
the model. A successful model `skill` call makes the six `bsk_*` schemas available
in the next step. A user `/browser-skill` gesture activates them when the host
claims the input, before prompt assembly, so the first request includes both the
skill instructions and tool schemas. Set `lazyTools: false` to register at startup.

After a plugin reload, a live or resumed conversation's successful skill invocation
restores the tools from its stored history. If an older plugin reports
`unknown tool "bsk_session"`, invoke `skill browser-skill` again, or set
`lazyTools: false` in the profile patch as a temporary workaround.

## Live browser view

The dsh Web UI prefers a **Browser Skill** tab in DSH's native right sidebar.
The native tab opens when the current conversation first has a browser session;
ordinary screenshot and action updates do not switch tabs or reopen a tab you
closed. You can reopen it from the sidebar's guide.

The native sidebar is optional. Profiles without its services use a floating
panel, and a failed native integration falls back to that panel. No
`dsh-better-sidebar` installation is required; it can coexist with BrowserSkill,
which registers directly with DSH rather than with the third-party sidebar.

- See the current action, elapsed time, and recent screenshot for each session.
- Select a session to focus on it. The sidebar view follows the current conversation.
- Use **Use floating view** to move observation into a floating panel, and
  **Move to sidebar** (or **Show here** in the tab) to return. This choice lasts
  only until the page reloads; it is not saved in your profile or browser storage.
- Use **Interrupt** to cancel the current browser command. The agent may continue
  with another action afterward.
- Drag or resize the floating panel, or use **Pop out** to open a Picture-in-Picture
  window in browsers that support it.
- Periodic screenshots are requested while a browser observation view is visible.
  Configure the active and idle intervals with the options above.

The floating panel shows all browser sessions managed by this plugin instance;
the native tab shows the current conversation's browsers and those of its subagents.

The observation endpoints require a loopback address such as `localhost` or
`127.0.0.1`. Access through a LAN hostname or non-loopback reverse proxy is not supported.

## Development

```sh
pnpm install
pnpm --filter @wxg-prc-cpg/browser-skill-dsh-plugin typecheck
pnpm --filter @wxg-prc-cpg/browser-skill-dsh-plugin test     # unit tests mock bsk; no browser needed
pnpm --filter @wxg-prc-cpg/browser-skill-dsh-plugin build    # tsdown -> lib/
```

See the [development notes](https://github.com/Tencent/BrowserSkill/blob/main/packages/dsh-plugin-browserskill/docs/development.md)
for skill registration, tool results, and observation APIs in the current source.

## Publishing

The [Release dsh plugin workflow](https://github.com/Tencent/BrowserSkill/blob/main/.github/workflows/release-dsh-plugin.yml)
publishes the package and this README to npm. Pushing a `dsh-plugin-vX.Y.Z` tag
triggers it; ordinary commits to `main` do not.

Before publishing the 0.3.3 plugin, publish the coordinated 0.3.3 CLI and extension.
Element waits require the implementation introduced in [#407](https://github.com/Tencent/BrowserSkill/pull/407).
The `cli-v0.3.0`, `cli-v0.3.1`, and `cli-v0.3.2` releases do not include this
command. Confirm the compatible CLI and extension release artifacts are available
before pushing the plugin tag; publishing the npm package alone does not upgrade
either component on users' machines. Older installations can still use the
[single-action recovery path](skill/references/interaction-details.md#element-waits).

1. Prepare a release PR that updates the shared CLI, extension and plugin version,
   local Cargo lock entries, changelog and relevant documentation. Merge it after
   validation and record the merge commit.
2. Tag that commit as `ext-v<version>` and wait for the browser extension to become
   available. Then tag the same commit as `cli-v<version>` and wait for the complete
   CLI release, including [Windows signing](../../docs/windows-signing.md).
3. Create `dsh-plugin-v<version>` on that same merge commit and push only that tag:

   ```sh
   git tag -a dsh-plugin-v<version> <merge-commit> -m "Release DSH plugin <version>"
   git -c push.followTags=false push origin refs/tags/dsh-plugin-v<version>
   ```

4. Approve the `npm-publish` environment deployment in GitHub Actions when required,
   then verify the published npm version and `latest` dist-tag.

The workflow checks the version, runs typechecks and tests, builds the package,
and publishes it to npm.

You can also run the workflow manually from GitHub Actions on the intended release
ref. Both triggers require an unpublished version and the `NPM_TOKEN` secret in the
`npm-publish` GitHub Environment.

npm updates the package README only when a new version is published, including
for documentation-only changes. Published versions cannot be overwritten. See
[npm's README update rules](https://docs.npmjs.com/about-package-readme-files/).

## License

MIT

## Task video recording

Ask the agent to record before it performs the task. It starts an authorized task
tab, confirms recording is active, performs the task, then stops video before
ending the session. No manual Start click is required. Preview and Save As are in
the extension's Features → Video recording → Recent recordings.

`bsk_inspect` with `action: "video"` exposes `videoAction` start/status/stop/save/
list/discard. The default is a silent, fixed-tab MP4 with a 60-second limit (up to
10 minutes). Export requires an explicit `output` path on the harness host; the
extension's Save As writes on the browser computer. Partial recordings and limits
are reported explicitly. See the [video reference](skill/references/video.md).
