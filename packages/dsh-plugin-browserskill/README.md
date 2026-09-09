# BrowserSkill for DeepSeek Harness

[![npm version](https://img.shields.io/npm/v/@wxg-prc-cpg/browser-skill-dsh-plugin)](https://www.npmjs.com/package/@wxg-prc-cpg/browser-skill-dsh-plugin)

Use [BrowserSkill](https://github.com/Tencent/BrowserSkill) in
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) to browse
websites, fill forms, and capture screenshots through native `browser_*` tools.
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
includes the `browser-skill` skill; no separate `bsk install-skill` step is needed.

In a conversation, try:

```text
/browser-skill open example.com and summarize the page.
```

By default, the browser tools become available when the skill is invoked.

## Updating

Installed plugins do not update automatically. To upgrade this plugin to npm's
`latest` version, including versions outside the profile's saved dependency range:

```sh
dsh plugin --profile web update @wxg-prc-cpg/browser-skill-dsh-plugin --latest
```

Restart that dsh profile after upgrading. This command updates the plugin; update
the `bsk` CLI and browser extension separately when a release requires it.

## Tools

| Tool | Actions | Purpose |
| --- | --- | --- |
| `browser_session` | `start`, `stop`, `list` | Manage plugin-owned Agent Window sessions. |
| `browser_page` | `navigate`, `back`, `forward`, `reload`, `wait` | Navigate the active tab and wait for page lifecycle events. |
| `browser_inspect` | `observe`, `snapshot`, `html`, `screenshot`, `console`, `network` | Read semantic or diagnostic page state and capture screenshots. |
| `browser_interact` | `click`, `hover`, `fill`, `select`, `press` | Interact with controls using fresh refs or selectors. |
| `browser_tabs` | `list`, `create`, `select`, `close`, `borrow`, `return` | Manage Agent Window tabs and temporarily borrow user tabs. |
| `browser_assist` | `resize`, `emulate`, `request-help` | Resize or emulate the browser and pause for human-only steps. |

Arbitrary page-script evaluation and interaction recording are not supported.

## Multi-session model

One agent conversation can drive several browser sessions at once:

- `browser_session` with `action: start` returns the session id and makes it the **current session**.
- Every operation tool accepts an optional `session` argument. When omitted, the call acts on the
  current session (the one most recently started or used); when given, that session becomes current.
- Every tool result echoes the session it actually acted on, so the model never has to guess.
- The number of concurrent sessions started through the plugin is capped (`maxSessions`, default 5).
- Unloading the plugin stops every session it started and kills in-flight bsk processes.

**Ownership boundary**: the bsk daemon may be shared with other agents, terminals, or dsh
instances. The plugin therefore only ever sees and operates on sessions it created itself —
an explicit `session` argument naming a foreign or unknown id is rejected, the `list` action on
`browser_session` shows plugin-created sessions only (no daemon-wide view), and stop/unload cleanup
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
| `defaultTimeoutMs` | `120000` | Default command timeout in milliseconds. |
| `maxSessions` | `5` | Maximum concurrent sessions started by this plugin. |
| `observationEnabled` | `true` | Enable live browser observation. |
| `thumbnailIntervalMs` | `1500` | Screenshot interval for active sessions, in milliseconds. |
| `idleIntervalMs` | `8000` | Screenshot interval for idle sessions and the recent-activity window, in milliseconds. |
| `lazyTools` | `true` | Reveal the browser tools when the skill is invoked. Set `false` to register them at startup. |

With `lazyTools: true`, only the skill's catalog entry is initially advertised to
the model. The six `browser_*` tool schemas are added to the system prompt after
the `browser-skill` skill is successfully invoked, either by the model or through
`/browser-skill`. Set `lazyTools: false` to make the tools available immediately.

## Live browser view

The dsh Web UI shows the plugin's browser sessions in a floating panel. If your
profile provides the `dsh-better-sidebar` integration, the view appears in a
**Browser Skill** sidebar tab instead.

- See the current action, elapsed time, and recent screenshot for each session.
- Select a session to focus on it. The sidebar view follows the current conversation.
- Use **Interrupt** to cancel the current browser command. The agent may continue
  with another action afterward.
- Drag or resize the floating panel, or use **Pop out** to open a Picture-in-Picture
  window in browsers that support it.
- Periodic screenshots are requested while a browser observation view is visible.
  Configure the active and idle intervals with the options above.

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

1. Commit this README and any other changes intended for the release.
2. From the repository root, run the
   [release script](https://github.com/Tencent/BrowserSkill/blob/main/scripts/release.mjs)
   with a new stable version, replacing `<version>` below. The script updates the
   CLI, extension, and DSH plugin versions, commits the version changes, and creates
   their release tags:

   ```sh
   node scripts/release.mjs <version>
   ```

3. Push the version commit to the release branch, then push the DSH plugin tag
   created by the script, using the same `<version>`:

   ```sh
   git push origin HEAD
   git push origin dsh-plugin-v<version>
   ```

   This publishes the DSH plugin. Push the CLI and extension tags separately when
   those components are ready for release.

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
