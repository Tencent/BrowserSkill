# dsh-plugin-browserskill

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) tool plugin that exposes
[BrowserSkill](https://github.com/Tencent/BrowserSkill) (`bsk`) browser automation to the model.

Each tool maps to one `bsk <cmd> --json` invocation: the plugin spawns the bsk CLI, parses its
structured JSON output, and returns a canonical typed value. The bsk daemon, browser, and Chrome
extension keep owning the actual browser control — this package is a thin, well-typed bridge.

## Tools

| Tool | bsk command | Purpose |
| --- | --- | --- |
| `browser_session_start` | `bsk session start` | Open an Agent Window session; optional initial URL, window size, and device emulation preset. Returns the session id and makes it the current session. |
| `browser_session_stop` | `bsk session stop` | Stop a session (the current one by default) and close its Agent Window. Only plugin-created sessions can be stopped. |
| `browser_session_list` | — (registry only) | List the sessions this plugin created, marking the current one. Foreign daemon sessions are never shown. |
| `browser_navigate` | `bsk navigate` | Navigate the active tab, with `waitUntil` / timeout control. |
| `browser_snapshot` | `bsk snapshot` | Indented aria-tree snapshot with `@eN` refs for interaction tools. |
| `browser_observe` | `bsk observe` | Semantic VOM observation (read-only) with `@eN` refs. |
| `browser_click` | `bsk click` | Click a snapshot ref or CSS selector (button / click-count options). |
| `browser_fill` | `bsk fill` | Fill an input / textarea / contenteditable (clears first by default). |
| `browser_press` | `bsk press` | Dispatch a key or combo, optionally focusing a target first. |
| `browser_screenshot` | `bsk screenshot` | PNG capture of the tab or a ref-cropped element; inlines the image when the deployment supports image input, otherwise returns a file path. |
| `browser_emulate` | `bsk emulate` | Apply or clear mobile device emulation on the active tab. |

## Multi-session model

One agent conversation can drive several browser sessions at once:

- `browser_session_start` returns the session id and makes it the **current session**.
- Every operation tool accepts an optional `session` argument. When omitted, the call acts on the
  current session (the one most recently started or used); when given, that session becomes current.
- Every tool result echoes the session it actually acted on, so the model never has to guess.
- The number of concurrent sessions started through the plugin is capped (`maxSessions`, default 5).
- Unloading the plugin stops every session it started and kills in-flight bsk processes.

**Ownership boundary**: the bsk daemon may be shared with other agents, terminals, or dsh
instances. The plugin therefore only ever sees and operates on sessions it created itself —
an explicit `session` argument naming a foreign or unknown id is rejected, `browser_session_list`
shows plugin-created sessions only (no daemon-wide view), and stop/unload cleanup can never touch
a session owned by another program.

## Installation

The plugin follows the standard dsh bundle layout (`dsh.bundle` manifest + `cordis.patch.yml`):

```sh
dsh plugin --profile <name> add <path-or-spec-of-this-package>
dsh --profile <name>
```

Prerequisite: the `bsk` CLI must be installed and on `PATH`, and the BrowserSkill Chrome extension
must be connected — see the [BrowserSkill README](https://github.com/Tencent/BrowserSkill). When bsk
is missing, tool calls fail with install guidance instead of a bare spawn error.

## Configuration

All fields are optional and validated through the plugin's Schemastery `Config`:

```yaml
# cordis.patch.yml override example
- insert:
    - id: browserskill
      name: dsh-plugin-browserskill
      config:
        bskPath: bsk          # path to the bsk binary (default: resolve from PATH)
        defaultTimeoutMs: 120000
        maxSessions: 5
```

## Behavior notes

- **Cancellation**: aborting a tool call (`exec.signal`) kills the underlying bsk child process,
  matching BrowserSkill's cooperative tool-cancellation model.
- **UI cards**: calls render as terminal cards (command line as title, output as the completed
  card). Screenshots additionally attach the image itself when the host mounts an attachment store
  and the active model route declares image input; otherwise the PNG path is returned.
- **Web UI toolview (browser half)**: the package is dual-face. `dsh.client` (platform `web`) ships
  `lib/client.js`, which registers a keyed `tool.call.toolview` view for `browser_screenshot`. The
  custom view keeps the terminal block (command + output) and, when the settled result carries an
  image block, resolves the durable attachment through the client session's authorized
  `readAttachment` RPC and renders it with the shared `MessageImage` thumbnail/lightbox atoms.
  Every other `browser_*` tool keeps the stock terminal card. The bundle follows the dsh client
  contract: a CJS closure factory handed to `window.__ModuleLoader__.load`, platform modules
  (`react`, `dsh-client-ui-*`) external, everything else inlined, CSS Modules compiled by
  lightningcss.
- **Errors**: non-zero bsk exits surface the CLI's JSON error envelope (`code`, `message`, `hint`)
  so the model gets the daemon's actionable guidance.
- **Long-running work** (e.g. `bsk record`) is not backgrounded via `ctx.jobs` yet — tracked as a
  follow-up.

## Development

```sh
pnpm install
pnpm --filter dsh-plugin-browserskill typecheck
pnpm --filter dsh-plugin-browserskill test     # unit tests mock bsk; no browser needed
pnpm --filter dsh-plugin-browserskill build    # tsdown -> lib/
```

## License

MIT
