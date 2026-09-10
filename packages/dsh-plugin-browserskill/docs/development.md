# DSH plugin development notes

For installation, usage, and configuration, see the [plugin README](../README.md).
These notes describe the current source on this branch; a published npm version may
not include later changes.

## Tool execution

The plugin runs the `bsk` CLI and parses its JSON output. The daemon and browser
extension perform the browser operations. The published package name is also the
Cordis plugin id, client bundle registration id, and `cordis.patch.yml` plugin name.
Keep these identifiers aligned so dsh can load both halves of the plugin.

## Agent skill

Beyond the tools, the plugin publishes the **`browser-skill` agent skill** through the harness's
official skill seam (`ctx.skills.register`): the catalog entry (name + routing description) is
resident in `<available_skills>`, and the body is loaded only when the model invokes the `skill`
tool. Its single source is the DSH-specific `skill/SKILL.md`, which documents only structured
`browser_*` calls and their plugin semantics. The repository-root CLI skill is intentionally not
concatenated: its command examples belong to a different execution interface and would bypass
the plugin's ownership, live observation UI, cancellation, and cleanup path if followed directly.
The build rejects internal CLI-name leakage, command-line code blocks, unknown browser tools, and
missing supported browser tools before embedding the Markdown. Registration and every pre-step
catalog snapshot are pure in-memory reads (no disk/process/daemon); compositions without the skill
seam degrade silently.

With `lazyTools: true`, the six tool schemas stay out of the system prompt until
the skill is successfully invoked. Registration happens once and lasts until the
plugin is unloaded. Repeated invocations do not register duplicate tools. Entering
a resumed conversation whose history contains a successful skill invocation also
registers the tools. Setting `lazyTools: false` registers them at plugin startup.

## Observation subscriptions and routes

- **Screenshot demand**: the client requests periodic screenshots while an observation view is
  visible, using the PiP document's visibility when popped out. Hidden or collapsed views can
  keep subscribing to state without requesting screenshots. The first screenshot subscriber
  starts capture scheduling; the last one's departure cancels timers and skips queued captures.
  An already running capture may finish. Demand applies to the service's owned sessions, not just
  the selected session.
- **Wire**: `GET /bsk-observation/events` is the live synchronization channel (SSE). Every connection,
  including reconnects, starts with `{ type: "snapshot", sessions, available }`, followed by
  `upsert`, `remove`, `reset`, and `availability` events on the same stream. Replace local state
  with each snapshot before applying subsequent events. Use `?thumbnails=0` for state-only
  subscriptions or `?thumbnails=1` to request screenshots; omitting the parameter defaults to
  requesting screenshots for compatibility. Closing the stream releases its screenshot demand.
  `GET /bsk-observation/state` remains a one-time `{ sessions, available }` read and does not
  request screenshots. It has no ordering guarantee relative to a separate SSE connection;
  live clients should initialize and resynchronize from the stream's snapshot instead.
  The host also serves `POST /bsk-observation/interrupt`, `POST /bsk-observation/stop`, and
  `GET /bsk-observation/thumbnail/<attachmentId>` through the dsh `webServer` route seam
  (dsh 0.1's Typert Remote pipeline is closed to out-of-tree packages). All commands for one
  session — tool calls and frame captures alike — run through a per-session FIFO, because the
  daemon accepts only one unfinished command per session.
- **Programmatic subscription**: `ObservationService.subscribe(listener, { thumbnails: false })`
  subscribes to state without requesting screenshots. On an active service, the listener receives
  the initial `snapshot` synchronously, before `subscribe` returns, then receives subsequent
  changes. `thumbnails` defaults to `true`, so callers should choose it explicitly. The returned
  unsubscribe function is safe to call repeatedly and releases this subscription's screenshot
  demand. Subscribing after service disposal is a no-op.
- **Trust model**: these routes expose live screenshots (and an interrupt write), so they
  replicate the browser-trust fence dsh applies to its own `/api` routes: the request Host
  must be a loopback authority (`localhost`, `127.0.0.0/8`, `[::1]`), a present Origin must
  match the Host, `sec-fetch-site: cross-site` is refused, and POST requires an
  `application/json` body (cross-site simple requests can never satisfy that). The channel is
  therefore built for **loopback-only serving** — binding the dsh web server to `0.0.0.0` and
  reaching it through a LAN address will (deliberately) fail the fence; do not put these
  routes behind a non-loopback reverse proxy without adding your own authentication.

## Tool results and cancellation

- **Cancellation**: aborting a tool call (`exec.signal`) kills the underlying bsk child process,
  matching BrowserSkill's cooperative tool-cancellation model.
- **UI cards**: calls render as terminal cards (command line as title, output as the completed
  card). Screenshots additionally attach the image itself when the host mounts an attachment store
  and the active model route declares image input; otherwise the PNG path is returned.
- **Web UI toolview (browser half)**: the package is dual-face. `dsh.client` (platform `web`) ships
  `lib/client.cjs`, which registers a keyed `tool.call.toolview` view for `browser_inspect`. The
  custom view keeps a terminal block for every inspect action and, when a screenshot result carries
  an image block, resolves the durable attachment through the client session's authorized
  `readAttachment` RPC and renders it with the shared `MessageImage` thumbnail/lightbox atoms.
  The other five tools keep the stock terminal card. The bundle follows the dsh client
  contract: a CJS closure factory handed to `window.__ModuleLoader__.load`, platform modules
  (`react`, `dsh-client-ui-*`) external, everything else inlined, CSS Modules compiled by
  lightningcss.
- **Errors**: non-zero bsk exits surface the CLI's JSON error envelope (`code`, `message`, `hint`)
  so the model gets the daemon's actionable guidance.
- **Long-running work** (e.g. `bsk record`) is not backgrounded via `ctx.jobs` yet — tracked as a
  follow-up.
