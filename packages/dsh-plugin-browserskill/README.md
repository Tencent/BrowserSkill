# dsh-plugin-browserskill

npm: [`@wxg-prc-cpg/browser-skill-dsh-plugin`](https://www.npmjs.com/package/@wxg-prc-cpg/browser-skill-dsh-plugin)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) tool plugin that exposes
[BrowserSkill](https://github.com/Tencent/BrowserSkill) (`bsk`) browser automation to the model.

Each tool maps to one `bsk <cmd> --json` invocation: the plugin spawns the bsk CLI, parses its
structured JSON output, and returns a canonical typed value. The bsk daemon, browser, and browser
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

## Agent skill (progressive disclosure)

Beyond the tools, the plugin publishes the **`browser-skill` agent skill** through the harness's
official skill seam (`ctx.skills.register`): the catalog entry (name + routing description) is
resident in `<available_skills>`, and the body is loaded only when the model invokes the `skill`
tool. The body is assembled at build time from two parts, so there is exactly one source of
truth: a dsh-specific prelude (`skill/prelude.md` — tool↔CLI map, owned-session semantics,
plugin-only overrides) followed verbatim by the canonical CLI skill (`skill/SKILL.md` at the
repo root — the same file `crates/bsk-cli/build.rs` mirrors for the CLI package; workflows,
stop-when-done rules, refs usage, sandbox rules). Registration and every pre-step catalog
snapshot are pure in-memory reads (no disk/process/daemon); compositions without the skill
seam degrade silently.

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
dsh plugin --profile <name> add @wxg-prc-cpg/browser-skill-dsh-plugin
dsh --profile <name>
```

Prerequisite: the `bsk` CLI must be installed and on `PATH`, and the BrowserSkill browser extension
(Chrome or Edge) must be connected — see the
[BrowserSkill README](https://github.com/Tencent/BrowserSkill). When bsk is missing, tool calls fail
with install guidance instead of a bare spawn error.

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
        # observationEnabled: true     # live PiP/overlay observation (below)
        # thumbnailIntervalMs: 1500    # frame cadence while a session is active
        # idleIntervalMs: 8000         # idle cadence / recent-activity window
        # lazyTools: true              # reveal browser_* tools only after the skill is invoked
```

- **`lazyTools` (default `true`)** — the final progressive-disclosure stage: the eleven
  `browser_*` tool schemas stay OUT of the system prompt (zero schema tokens) until the
  `browser-skill` skill is actually invoked — the skill catalog entry is the only
  advertisement. One successful invocation (model tool call, or a `/browser-skill` user
  gesture) registers the whole suite for the rest of the process; repeated invocations are
  no-ops, and sessions resumed with a past invocation in their durable log reveal the suite
  on entry. Set `false` for the legacy always-on registration.

## Observation overlay (PiP mini-window)

When the plugin runs inside the dsh Web UI, an **observation overlay** floats over the app
(registered into the `shell.overlay` seat): a breathing thumbnail per owned session plus its
current action and elapsed time. The card docks at the top-right of the content area (clear of
the composer and the shell's header controls) and wears the **BrowserSkill product family's own
look**: the overlay reuses `@browser-skill/ui` components (`Button`, `cn`) and its oklch design
tokens (`--card`, `--primary`, `--destructive`, `--ring`, …), status dots spec'd after the
extension popup's connection indicator, and Remix icons. The BSK utility sheet is compiled
scoped under the `.bsk-obs` root class (`scripts/build-client-css.mjs`), so the overlay looks
like the BrowserSkill extension without leaking a single selector into the host shell — and the
shell's theme cannot bleed back in.

- **Lifecycle**: hidden while the plugin owns no sessions; appears on the first
  `browser_session_start`; disappears when all sessions stop (or the plugin unloads).
- **Focus view**: status row (green/idle/red dot + session + action + mm:ss), the latest page
  frame (refreshes every ~1.5s while active, ~8s when idle; the last good frame stays on
  stage while the next one loads, and is kept on errors so the card does not flash),
  and a compact icon toolbar (Interrupt + Pop out, hover for the label).
- **Interrupt**: one click kills the in-flight bsk command of the focus session (same semantics
  as the chat Stop button — the current action fails, the agent run may continue). Strip items
  carry their own hover interrupt button.
- **Multi-session strip**: every session gets a tile (mini frame + id + status dot); focus
  auto-follows the most recently active session; clicking a tile pins focus (pin badge, click
  again to release); errored sessions get a red edge without stealing focus; sessions the daemon
  lost are greyed out; prolonged daemon/browser outage shows "browser unavailable" and greys
  the interrupt button until captures recover.
- **Drag & resize**: drag the header to move the card; drag any of the four
  corners to resize (min 240×180, max 80% of the viewport; no visible grip).
  Both are remembered for the page lifetime.
- **Pop out (PiP)**: upgrades the card into a native Document PiP window (requires a user
  gesture, per browser rules), sized from the current card; closing the PiP falls back to the
  in-page card with state intact. Browsers without Document PiP simply hide the button.
- **Wire**: the host serves `GET /bsk-observation/state`, `GET /bsk-observation/events` (SSE),
  `POST /bsk-observation/interrupt`, and `GET /bsk-observation/thumbnail/<attachmentId>` over
  the dsh `webServer` route seam (dsh 0.1's Typert Remote pipeline is closed to out-of-tree
  packages). All commands for one session — tool calls and frame captures alike — run through a
  per-session FIFO, because the daemon accepts only one unfinished command per session.
- **Trust model**: these routes expose live screenshots (and an interrupt write), so they
  replicate the browser-trust fence dsh applies to its own `/api` routes: the request Host
  must be a loopback authority (`localhost`, `127.0.0.0/8`, `[::1]`), a present Origin must
  match the Host, `sec-fetch-site: cross-site` is refused, and POST requires an
  `application/json` body (cross-site simple requests can never satisfy that). The channel is
  therefore built for **loopback-only serving** — binding the dsh web server to `0.0.0.0` and
  reaching it through a LAN address will (deliberately) fail the fence; do not put these
  routes behind a non-loopback reverse proxy without adding your own authentication.
- Configure with `observationEnabled` / `thumbnailIntervalMs` / `idleIntervalMs`.

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
pnpm --filter @wxg-prc-cpg/browser-skill-dsh-plugin typecheck
pnpm --filter @wxg-prc-cpg/browser-skill-dsh-plugin test     # unit tests mock bsk; no browser needed
pnpm --filter @wxg-prc-cpg/browser-skill-dsh-plugin build    # tsdown -> lib/
```

## Publishing

The GitHub Actions workflow **Release dsh plugin** publishes this package to npm
as `@wxg-prc-cpg/browser-skill-dsh-plugin`. The Cordis plugin id stays
`dsh-plugin-browserskill`.

Trigger it by pushing a tag that matches `package.json`'s `version`:

```sh
git tag dsh-plugin-v0.1.0
git push origin dsh-plugin-v0.1.0
```

Or run the workflow from the Actions tab (`workflow_dispatch`). The job reads
`NPM_TOKEN` from the GitHub Environment of the same name.

## License

MIT
