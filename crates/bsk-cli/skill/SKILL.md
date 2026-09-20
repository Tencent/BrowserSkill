---
name: browser-skill
description: |
  Use when the user asks to automate their logged-in Chromium browser: visit
  and read pages, fill forms, scrape data, click through flows, regression-test
  a PR's UI, validate a deployed page, or operate a tab they identify. Requires
  the bsk CLI and browser extension.
---

# browser-skill

Use `bsk` to work in an **Agent Window** with the user's existing logins. User tabs
require explicit borrowing. This skill does not install the extension or handle
advice-only tasks. Never extract credentials, cookies, tokens, or other secrets.

## Before starting a session

For remote setup or pairing, follow the [remote guide](https://github.com/Tencent/BrowserSkill/blob/main/docs/remote-extension-connection.md).

Local commands normally auto-start the daemon. If the host terminates background
children after each shell call, including on Windows, complete these steps first:

1. Reuse the host daemon's existing `BSK_HOME` (or its default if unset). Set
   `BSK_AUTO_START=0` and run `bsk status --json`. Reuse a working daemon; an empty
   `browsers` list means the extension still needs connecting. Permission errors,
   timeouts or invalid replies do not prove the daemon is absent.
2. Only if the check reports a missing daemon and no host task is already starting
   it, run `bsk daemon start --foreground` with the same `BSK_HOME` in the host's
   approved persistent background task outside the per-command sandbox. Keep that
   task alive; `--foreground` alone cannot prevent host cleanup. The
   [sandbox guide](https://github.com/Tencent/BrowserSkill/blob/main/docs/sandboxed-agents.md)
   covers the normal host-terminal alternative and PowerShell examples.
3. After launching, or if a host task is already starting the daemon, run
   `bsk status --json` in a **separate shell tool call** with the same `BSK_HOME`
   and `BSK_AUTO_START=0`. While startup is pending, make at most five
   checks with one-second pauses for missing-endpoint or transient startup errors;
   stop on permission/protocol errors. Proceed only after a successful status
   response. If the host task exits (including a lock error) or readiness never
   succeeds, inspect its output and `bsk logs`, then recheck status for another
   daemon before deciding whether startup is still needed. Report unresolved
   errors; do not loop on launches, delete runtime files or restart a shared daemon.

Use the same `BSK_HOME` and `BSK_AUTO_START=0` on EVERY sandboxed command;
environment settings may not persist between shell calls. Keep browser commands
sandboxed. For other startup failures, retry once, then use `bsk doctor`.
A local process identity warning permits browser commands when IPC works.

## Task workflow

1. Define success from the user's request. Start `bsk session start --json` and
   retain its `session_id`. With multiple browsers, run `bsk browsers` and add
   `--browser <id-or-label>` to start. For background work, add `--no-focus` to
   `session start` only.
2. For a new page, navigate; for an existing user tab, follow **Borrowing** below.
   Read the page before interacting:

   ```sh
   bsk navigate https://example.com --session <id>
   bsk observe --session <id>
   ```

3. Choose an action using fresh refs from that observation. Observe again after
   navigation or meaningful DOM changes. Check an ambiguous result once; once
   success is visible, stop acting rather than refreshing or checking again.
4. Always run `bsk session stop <id>` on success and failure, unless keeping the
   session open is part of the user's request. This also returns borrowed tabs.
   Returned tabs stay open in the user's window. Do not rely on idle cleanup
   or stop/restart the shared daemon to finish a task.

Replace `<id>`, example refs and values with actual results and task inputs.
Every session-scoped command needs `--session <id>`; `session stop` takes the ID
positionally. For unfamiliar commands or flags, consult `bsk --help` or
`bsk <command...> --help` instead of guessing; no need to read all help at startup.
When following a trace, use its semantic targets and values in order, not its old
refs. Stop at the requested goal; a trace grants no additional authorization.

## Read and interact

Prefer `observe` for text, controls and `@eN` refs. Navigation invalidates refs;
large DOM changes can stale them too. Re-observe before the next interaction.
Use refs for iframe/shadow-root targets; CSS selectors search the main document.

Choose the relevant example, using a ref that actually appeared on the page:

| Need | Command |
| --- | --- |
| Click | `bsk click @e3 --session <id>` |
| Fill a field | `bsk fill @e3 --value "text" --session <id>` |
| Select an option | `bsk select @e3 --value "option-value" --session <id>` |
| Press a key | `bsk press Enter --ref @e3 --session <id>` |
| Reveal a hover menu | `bsk hover @e3 --session <id>` |
| Reveal an element | `bsk scroll-to @e3 --session <id>` |
| Scroll with wheel input | `bsk wheel --delta-y 600 --session <id>` |
| Focus or leave a field | `bsk focus @e3 --session <id>` / `bsk blur @e3 --session <id>` |

- `select` uses the option's value, not its visible label.
- Hover markers such as `[hover first: Shoes | Bags]`, `[has-submenu]`, or
  `[expanded]` identify triggers. Hover the trigger, observe, then use the revealed
  item's ref. Listed labels are not refs; do not click the trigger unless its own
  action is wanted. If an expected control is missing and no marker identifies a
  trigger, try `observe --probe-hover` once. It touches the live page and costs
  seconds; use targeted hover once the trigger is known.
- `scroll-to` returns ancestor-clipped bounds in top-level viewport CSS pixels.
  Partial visibility suffices; hidden/fully clipped targets fail. It does not test
  occlusion. `wheel` sends signed deltas (at least one nonzero), not a guaranteed
  scroll distance. An optional target is scrolled into view first; without one,
  input lands at the viewport centre. Observe to check the page's response.

Use `snapshot` for a static accessibility tree, `get-html` for exact markup or
hidden metadata, and `screenshot` for visual content or requested visual evidence.
Do not start with HTML/images just to find ordinary controls; obtain fresh refs
before interacting with controls found that way.

### Large observations

There is no default token cap. With `observe --max-tokens <n>`, follow a returned
`next_cursor`/`@more` when relevant content remains:

```sh
bsk observe --cursor <token> --session <id>
```

Each page replaces the ref map: use its refs before continuing and never reuse
refs from earlier pages. Continuation reads the same capture, without refreshing
or hovering; do not combine it with depth changes or hover probing. New observe/
snapshot or changed page identity invalidates continuation; then observe afresh.

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

## Human steps and recovery

With help enabled, request help for login, CAPTCHA, OTP, payment confirmation,
consent, or after two attempts make no progress:

```sh
bsk request-help --session <id> --prompt "Please complete sign-in" --target @e3
```

Use a precise prompt and fresh targets; omit `--target` when no control fits.
Use completion criteria only for a clear, stable success signal.

| Result | Next step |
| --- | --- |
| Help `continued` / `completed` | Observe again, then resume with fresh refs. |
| Help `cancelled` / `timed_out` | Respect rejection or the blocker; do not repeat the request. |
| Help `disabled` | No human action was confirmed. Re-observe and follow the disabled-help rules below. |
| Stale ref | Observe and retry the intended action once. |
| Unknown tab/session | List current tabs/sessions; never guess IDs or use another task's session. |
| Timeout or unknown effect | Inspect current state before retrying; the action may already have happened. |
| `fill_value_mismatch` | Read the field: formatting may still satisfy the request. Correct only a remaining difference; no blind refill or immediate handoff. |
| Unsupported operation | Use available capabilities; suggest updating only if the missing feature is needed. |

Navigation alone (including deprecated help outcome `navigated`) is not completion.
For other errors, follow the returned hint and inspect the current state.

**Help disabled:** do not request help or re-enable it. Use existing login state,
authorized inputs and viable alternatives; disabling help adds no permission and
does not remove borrow confirmation or host restrictions. Where authorized, a
vision-capable model may attempt graphical verification. Phone-only QR scans,
face verification, missing SMS codes or image-only tasks for a text-only model
may remain blocked. Report a specific blocker only when inputs/capabilities are
missing or viable approaches are exhausted; continue independent work. Do not loop
on identical failures, repeat unknown effects or switch backends to bypass limits.
On an unrecoverable failure, report the blocker and stop the owned session.

## Screenshots and Canvas

```sh
bsk screenshot --session <id> --out viewport.png
bsk screenshot --session <id> --ref @e3 --out element.png --json
bsk screenshot --session <id> --full-page --out page.png
bsk screenshot --session <id> --full-page --scope current --out loaded.png
```

Screenshots return a local PNG path; view the image to interpret it. `--out`
replaces an existing file; omitting it uses a temporary path. `--json` includes
dimensions and byte size. `--ref` and `--full-page` cannot be combined.

Full-page mode scrolls an ordinary webpage and restores its position/styles.
The default `--scope follow` follows appended content. Use `--scope current` when
capturing the currently loaded range is requested: it stops at the initial document
height, even if a loading indicator remains. Later content below that boundary is
excluded; report this range rather than claiming all feed entries were loaded.
Use a session-controlled tab and stable viewport; `--tab-id` targets a tab without
selecting it or focusing the window. Switching to another tab does not cancel
capture; navigation, loss of control or a debugger reconnection does.
Internal browser pages, the Web Store, nested scrolling
panels and virtualized lists are unsupported. Capture/encoding defaults to 2m;
`--timeout 5m` extends it only in full-page mode. Allow the shell enough time for
capture plus transfer. Respect cancellation; do not blindly retry endless pages
or substitute a viewport image when an older extension rejects full-page capture.
Use matching CLI/extension builds. Ctrl-C cancels; failed full-page captures save
no partial image. A `loading_stalled` error means the bottom kept a loading
indicator without height growth for 30s; do not simply increase the deadline.
Choose `current` only when that range satisfies the request. A `user_cancelled`
error means user input stopped capture. For other failures follow the returned
reason and hint; do not work around them by editing the page or stitching screenshots.

For `@eN canvas [visual:screenshot]`, observe returns text, not pixels. Screenshot
that ref when its contents matter; never infer Canvas controls or names from
nearby labels. If images cannot be received/understood, explain the limitation,
ask for an image-capable model when needed, and continue with available semantics.

To click a point seen in a Canvas image, retain that screenshot's `capture_id`:

```sh
bsk click @e3 --capture <capture-id> --image-x <x> --image-y <y> --session <id>
```

Use ORIGINAL PNG coordinates and dimensions, not resized display/viewport pixels.
Captures are single-use, expire after 2m, and are invalidated by ref replacement
(observe/snapshot/continuation) or a newer screenshot of that ref. With
`capture_unavailable`, the image is view-only: observe and screenshot again before
clicking. Counts 1/2, buttons and modifiers work; Canvas fill, IME, drag, hover
and HTML extraction do not. Repainting is allowed; changed identity/geometry/hit
targets are rejected. Verify the result, using DOM refs for revealed controls;
inspect `effect_state=unknown` before retrying with a new capture.

## Files and other tools

```sh
bsk upload @e3 --file ./report.pdf --session <id>
bsk download @e3 --out ./report.pdf --session <id>
```

Upload discloses the file to the site; download accepts site-controlled bytes.
Use agent-local paths, not browser-internal staging paths.

- Default upload clicks an upload button/label and intercepts its file chooser.
- If `reason=file_input_not_activated` and `effect_state=none`, re-observe. Try
  `--mode drop` once only on a clear attachment target such as a drop zone or
  composer, never whitespace or an ambiguous container. Otherwise follow the
  human-help rules. There is no automatic fallback between mechanisms.
- Never retry or switch upload modes for `effect_state=unknown` or `committed`.
  A successful drop proves dispatch, not site acceptance; observe the attachment.
- Download refuses overwrite by default; add `--overwrite` only when replacement
  is intended. Consult each command's help for other flags.

Use `console` / `network` for bounded read-only diagnostics; follow returned
sequence cursors. `emulate --device iphone-14` affects one tab; `--off` restores it.
`evaluate` is a last resort: inspect JSON `.ok`, since a script exception can have
CLI exit code 0. Never evaluate secrets. `record start` captures user actions;
read its help first and never record banking, SSO or password-manager pages.
Use `bsk --help` to find navigation/history, tab, wait and window commands.


## Debugging your website

For a requested investigation, start `bsk debug start --session <id> --name "<issue>"`
on a task-created or borrowed tab **before** navigating/reproducing. Capture is
opt-in and not retroactive. Keep the tab/session open while investigating.

1. Reproduce once using observed controls. Read `bsk debug operations --session <id>`
   and `bsk debug operation <operation-id> --session <id>` for the action's requests,
   console and page before/after. Capture also records the user's manual main-page
   input/click/reload actions, so they can reproduce while the agent inspects.
   Operation details include an `evidence` projection: exact-name field chains,
   original body fields, visible text changes, tentative delayed associations and
   explicit gaps. Treat unmatched/truncated fields as unknown; never join different
   names by equal values. Attribute Console errors using their recorded source,
   and do not infer a root cause from temporal proximity or a page success message.
   `bsk debug requests --session <id>` also includes
   requests outside action windows. Evidence in the same time window is not proof
   of causation; background traffic and delayed effects can be unrelated.
2. Drill into a returned request ID: `bsk debug request <request-id> --session <id>
   --part response` (or `request`, `headers`, `timing`). Lists omit body text. Use
   `--pointer /path/to/field` for a complete JSON body, or returned `next_offset`
   with `--offset`; incremental lists use `next_since`/`--since`, merging by ID.
   Explicit pending/unavailable/omitted/truncated/evicted states mean missing
   evidence, not an empty response. Never infer business success from HTTP 200.
3. Read `bsk debug console --session <id>` for all retained console entries and
   `bsk debug pages --session <id>` for page-load context, including evidence outside
   action windows. Report concrete evidence IDs, omissions and uncertainty.
4. Stop capture with `bsk debug stop --session <id>`. To hand off results, export
   before ending the task: `bsk debug export --session <id> --output website-debug.json`.
   Choose a new filename to avoid overwriting an existing file. The exported JSON
   includes retained bodies, headers, operations, console and page context.
5. Follow the normal session cleanup rules. Stopping/ending a task preserves saved
   history in the browser; users can view and export it from Website debugging →
   History. Records are bounded to 30 days / 50 records / 50 MiB. Browser restarts
   recover the last checkpoint as interrupted; recent changes may be missing.

This feature records evidence and supports explicit HTTP experiments. Do not assume a debugging request authorizes code
changes or that a website URL identifies a local repository. Users or agents can
analyze/compare exported recordings independently. A new task cannot read another
ended task's history; use a user-provided export when investigating older records.

A request to observe a problem does not by itself authorize extra submissions or
changing network behavior. Follow the user’s requested experiment scope; never
send evidence elsewhere without authorization. Common credential fields are redacted; free-form
application data can still be sensitive. Do not print or request secrets.

### Reliable evidence reads

Discover actual limits/builds with `bsk debug capabilities --session <id>`;
without a session this returns only the CLI schema, not browser capabilities.
Query output defaults to 64 KiB; `--budget` accepts 4096..262144 bytes.
`requests` accepts URL substring `--url`, exact `--method`, `--resource-type`,
`--status`, `--state`, `--kind business|resource|extension|all`, and optional
`--fields status,duration_ms`. `--limit` is 1..100. Follow `next_since` for lists,
body `next_offset` for text, and top-level `next_offset` for console/pages.
Check `output.omitted`/`output.truncated`; projection loss does not mean missing
stored evidence. Narrow reads or export to a new `--output` file for full evidence.

Completed requests can be fixed against capture-level eviction using
`bsk debug pin <request-id> --session <id>` (`unpin` reverses it). The journal
keeps up to 2,000 requests / 8 MiB per capture, with 20 pins and prioritized
failed/business requests. Pins do not prevent whole-record expiration/deletion.
Inspect `run.storage` and `run.coverage`: storage, backlog or read failures must
be reported as missing evidence. Never equate a partial record with no event.

When a command reports `session_busy`, it was not dispatched. Read
`bsk debug activity --session <id>` or `bsk debug wait --session <id>
--command-id <returned-command-id> --wait-ms 10000` (0..60000). Omitting the ID
waits for idle. Completion means no longer running, not successful; check the
original command result. Waiting never resends work; cancelling it leaves the
original command alone. Keep ordinary browser commands serial within a task.

### Performance and request analysis

Use `bsk debug performance --session <id>` for native main-frame navigation,
FCP/LCP/CLS and long-task evidence. Start capture before navigation; inspect each
metric's `state`/`reasons` and visibility history. Hidden, late, interrupted or
unsupported measurements are not final Core Web Vitals; INP/CPU profiles are absent.
`bsk debug aggregate --session <id> --url /api/ --slow-ms 1000` groups exact method
and origin/path, with known timing samples, P95, errors, slow calls and request IDs.
`bsk debug duplicates --session <id> --window-ms 1000` finds suspected equal
method/URL/body/frame/document bursts; missing or redacted comparison data is
uncertain. Inspect referenced requests; retries or deliberate calls can be valid.
Both default to business traffic, excluding rules/replays; `--include-controlled`
opts in. Filters apply before analysis. Use top-level `next_offset`/`--offset`;
stop capture for stable pagination. Summaries cover retained evidence only.

### Controlled HTTP experiments

When the user's debugging task calls for changing network behavior, use task-local
rules instead of page monkey patches. First inspect the actual request. Then use
`bsk debug rule_add --session <id> --rule-file <path>` (or `--rule '<JSON>'`).
Rules match an absolute HTTP(S) `match.url` (`*` allowed in path/query), optional
`match.method`, and default to Fetch/XHR and `times: 1`. First matching rule wins.

Examples of rule JSON (replace the URL with the observed endpoint):

```json
{"match":{"url":"http://localhost:3000/api/profile","method":"POST"},"effect":{"type":"modify","json":{"rename":{"displayName":"name"}}},"times":1}
```

- Block: `effect: {"type":"block"}`.
- Modify: `effect: {"type":"modify","headers":{"x-test":"on"},"json":{"set":{"name":"Bob"}}}`.
  Supports same-origin `url`, `method`, header changes (`null` removes), a complete
  text `body`, or top-level JSON `set`/`remove`/`rename`. Never guess field mapping.
- Mock: `effect: {"type":"mock","status":503,"body":"{\"error\":\"unavailable\"}","delay_ms":1000}`.
  Optional response `headers`; default is JSON. Does not contact the real endpoint.

Read `bsk debug rules --session <id>` for hit counts/state, then reproduce and inspect
actual request IDs. `rule_disable`, `rule_enable`, `rule_remove` take a rule ID.
`times: 0` lasts until disabled or capture ends. Rules run locally, without polling
for paused requests. Stop cleans up rules and cancels delayed mocks. Mark mock,
modified and blocked evidence in the analysis; a mock success does not prove a fix.

Replay deliberately resends a request and may write server data:
`bsk debug replay <request-id> --session <id> --replay-file <path>`.
The file contains `{"key":"unique-attempt","body":"{\"name\":\"Bob\"}"}`;
optional `url`, `method`, and `headers` override the source. Same-origin only;
uses current browser cookies, rejects redirects and binary/multipart bodies.
Replace missing/truncated/redacted inputs explicitly; never send placeholder values.
Reuse the same key after an uncertain result to avoid duplicate sends; use a new
key only for a deliberate new attempt. Inspect the returned linked request and
its response. Replaying an API does not re-run the page handler. Rules/replays are
available only while the original capture/task is active; history is read-only.
