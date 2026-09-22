# Website debugging

BrowserSkill lets a developer's agent investigate their own website through the
same owned browser task. It records browser evidence for people and agents to inspect later:

- **Request details:** stable request IDs, URL/method/status, headers, POST body,
  response body, initiator, timing, failure, redirect and cache metadata.
- **Operation evidence:** agent and manual inputs grouped with immediate and delayed
  requests, source-labelled console messages, field values and visible page changes.
- **History:** browser-local recordings with page-load context, all retained console
  entries, and portable JSON export, independent of the original task lifecycle.

The extension records evidence and can execute explicitly configured, task-local HTTP rules and replays. The evidence page supplies bounded performance and request summaries; diagnosis and cross-record comparison belong to the
user or their agent; project discovery and source-code repair are outside this feature. This is independent of persistent operation audit.

## Entry points

The popup preserves connection settings, browser automation preferences and
existing Quick Actions. A current-task card links to a separate evidence page.
Quick Actions → Website debugging starts/stops capture for an existing task and
opens its evidence. Without a task, it provides a prompt to give the agent.
The evidence page opens both live and historical records, with a timeline, requests,
body/header/timing details, Console, page context, **Performance**, and **API analysis**. History is reachable through
Quick Actions → Website debugging even without a connected daemon or active task.
Users can search records, export JSON, and delete stopped records.

Capture must be started **before** navigation or reproduction. It targets exactly
one task-created or borrowed tab per task. Opening a user tab or placing it in an
Agent Window does not authorize capture. Returning/closing that tab, ending its
task or disconnecting stops collection and saves the retained evidence. These events
do not delete saved records. Browser/extension restarts recover the latest checkpoint
as interrupted, without resuming capture or claiming pending operations succeeded.

## CLI example

Replace IDs with actual results. Start a session normally and keep it open:

```sh
bsk debug start --session <id> --name 'Save fails'
bsk navigate http://localhost:3000 --session <id>
# Observe, fill and click using the normal BrowserSkill workflow.
bsk debug operations --session <id>
bsk debug operation <operation-id> --session <id>
bsk debug request <request-id> --session <id> --part response
bsk debug request <request-id> --session <id> --part response --pointer /error/code
bsk debug request <request-id> --session <id> --part headers
bsk debug console --session <id>
bsk debug pages --session <id>
bsk debug stop --session <id>
bsk debug export --session <id> --output website-debug.json
bsk session stop <id>
```

`status` lists captures. `requests` lists all traffic, including outside an action
window. `--run-id` selects a retained capture; otherwise ID reads infer their run
and list/stop commands use the latest capture. `--tab-id` optionally selects the
owned tab. `request --part` accepts `metadata` (default), `request`, `response`,
`headers` or `timing`. Lists never include body text.

`requests`/`operations` accept `--since` and `--limit` (default 30, maximum 100).
Use `next_since` for incremental reads and merge by stable ID: unfinished records
can reappear when updated. `truncated` also reports evicted evidence; it does not
promise another page. Read while entries remain; an empty page ends pagination.

Body reads accept `--offset` and `--max-chars` (default 4096, maximum 16384).
Follow `next_offset` while present. Offsets count UTF-16 code units, matching the
extension. RFC 6901 `--pointer` works only on a complete retained JSON body and is
applied after redaction. No network request is repeated by these reads.

DSH uses `browser_inspect` with `action: "debug"`, `debugAction` matching the CLI
subcommand, and camelCase options (`runId`, `tabId`, `maxChars`). The six public
tools, existing session ownership, cancellation and queue remain unchanged.
The wire endpoint is `tool.debug`; schemas are in `crates/bsk-protocol/schema`.
Older extensions reject it without altering the existing `console`/`network` tools.

## Performance and request analysis

```sh
# Capture starts before navigation; no evaluate script is needed.
bsk debug performance --session <id>
bsk debug aggregate --session <id> --url /api/ --slow-ms 1000
bsk debug duplicates --session <id> --window-ms 1000
# Explicitly include requests affected by rules or replay experiments.
bsk debug aggregate --session <id> --include-controlled
```

Performance capture shares the existing isolated main-frame observer and lifecycle.
It installs a new-document hook before subsequent navigation and records navigation
TTFB, DOMContentLoaded/load timing, FCP, LCP candidates, CLS, and long-task counts,
total/max duration and the 50 most expensive task intervals. Values ending in
`_ms` use milliseconds; navigation/paint timings are relative to the document time
origin. TTFB is `responseStart` from navigation start, including redirects and
connection setup, not server-only processing time. CLS uses the largest session
window (at most 5 seconds, gaps under 1 second) and excludes recent-input shifts.
See the primary definitions for [LCP](https://web.dev/articles/lcp),
[CLS](https://web.dev/articles/cls), [navigation timing](https://w3c.github.io/navigation-timing/),
and [long tasks](https://w3c.github.io/longtasks/).

Each metric has `state` and `reasons`. `provisional` values can still change;
`partial` means capture was late, interrupted, stopped before finalization, or
limited. `unavailable` and `unsupported` have no invented zero value. A page
initially hidden cannot supply valid paint measurements; the observer records
visibility changes and never activates a tab. Buffered data from late capture is
marked partial because prior visibility is unknown. BFCache restores get a separate
visit; navigation/paint metrics for BFCache and prerender are explicitly unsupported.
These are observed main-frame metrics, not a complete Core Web Vitals report:
INP, iframe vitals, SPA soft-navigation vitals and CPU profiling are not included.

At most 20 document/visit snapshots and 64 visibility transitions per visit are
retained, with explicit coverage/limit markers. Updates coalesce over 500 ms, with
immediate lifecycle checkpoints and no idle polling in the page. Metrics persist
with the recording and export; old recordings without them remain readable.

`aggregate` groups by HTTP method + exact origin/path, combining query values;
it does not guess dynamic route templates. It reports calls, transport failures,
HTTP errors, pending/interrupted calls, known timing samples (mean, nearest-rank
P50/P95, maximum), slow count, transfer samples, cache/service-worker counts and
source request IDs. HTTP 200 still does not establish business success.

`duplicates` reports **suspected** duplicate bursts within a fixed start-time
window (default 1000 ms, range 100..10000). It requires equal method, retained URL,
complete retained body, frame and document identity; headers are not compared.
Requests lacking identity/body or containing redacted comparison data are counted
as `uncomparable`. The result includes overlap, possible retry, request IDs and
nearby operation references. Deliberate repeated calls, polling and retries can be
valid; a group is not proof of a defect. Old records without document identity
cannot safely participate in duplicate matching.

Both analyses default to business traffic and exclude modified, blocked, mocked
and replayed requests. Existing URL/method/type/status/state/kind filters apply
before aggregation; use `--kind all` or `--include-controlled` explicitly as needed.
`--slow-ms` accepts 0..60000 (default 1000). Analysis is computed only when requested,
over retained evidence, without issuing any website requests. Storage and capture
gaps remain visible. Each group retains up to 50 source request references.

Performance and analysis lists use `--offset`, `--limit` and top-level `next_offset`.
Restart pagination if the live recording changes; stop capture for a stable complete
analysis. These reads use the same output budget and task/history isolation as
other debug queries. DSH exposes `debugAction: "performance" | "aggregate" |
"duplicates"` with `slowMs`, `windowMs` and `includeControlled`.

## Reliable agent reads

```sh
# Offline CLI schema; extension is null because no browser was queried.
bsk debug capabilities
# Actual extension actions, build identity, limits and unsupported features.
bsk debug capabilities --session <id>
bsk debug requests --session <id> --kind business --url /api/ --method POST --status 500 --limit 20 --budget 8192
bsk debug requests --session <id> --fields status,duration_ms,resource_type
bsk debug pin <request-id> --session <id>
bsk debug unpin <request-id> --session <id>
```

Request filters are combined before pagination: `--url` is a case-sensitive
substring; method/resource type/status/state match exactly. `--kind` is `all`,
`business`, `resource` or `extension`. `--fields` selects optional metadata;
identity, body availability and intervention/replay provenance always remain.
Ordinary query results default to a 64 KiB UTF-8 JSON budget, configurable from
4 KiB to 256 KiB. Data URLs are compacted in agent output. `output.omitted` and
`output.truncated` describe projection loss, independently of capture/storage
loss. The stored evidence is unchanged. Increase the budget, narrow a query or
export for full retained details. An insufficient budget returns an explicit error.

Request/operation lists paginate at whole entries using `next_since`; console
and page lists use top-level `next_offset` with `--offset`. Body reads use the
body's `next_offset` and preserve exact text without splitting Unicode characters.
Large narrative strings may be shortened with an omission path. Export is exempt
from the output budget; prefer `--output` to keep it out of the agent context.

Pinning protects a completed request from **that capture's** capacity eviction.
It does not extend whole-record expiration, prevent user deletion, or recover
content that was never captured. The active request detail toolbar offers the
same pin/unpin action. The evidence page shows saved request counts and explicit
storage-limit, write-backlog, write-failure and read-failure gaps. A storage failure
leaves in-memory evidence readable while available. `run.storage` reports saved
counts, logical bytes, pins and capacity evictions; `run.coverage` reports other
storage gaps. Pins and priority cannot guarantee preservation across a crash,
browser storage deletion or failed writes.

## Busy state and waiting

The CLI still runs one browser command per session. Independent sessions remain
independent. A `session_busy` error includes `dispatched: false`, `activity` with
`command_id`, method, start time and elapsed time, and a wait hint.

```sh
bsk debug activity --session <id>
bsk debug wait --session <id> --command-id <running-command-id> --wait-ms 10000
```

These two daemon-local reads work while the browser command is running; no capture
is required and nothing is sent to the page. Omitting `--command-id` waits for idle.
`--wait-ms` accepts 0..60000 (default 10000); zero is a poll. A timeout returns
`wait_complete: false, wait_timed_out: true`. `wait_complete: true` means the
specified command is no longer running, **not** that it succeeded; consult its
original result and page evidence. Cancelling the waiter does not cancel the
original command. Waiting never retries, replays or automatically queues a command.
DSH keeps its existing per-session execution queue; debug activity/wait bypass
that queue to observe ongoing work, still using the owned session.

## Evidence interpretation

Request IDs are distinct across redirects and out-of-process iframe targets.
The redirect chain uses `redirect_from`. Cache/service-worker flags are reported
when Chrome provides them. A completed request can have an error HTTP status or
an HTTP 200 body describing a business failure. Neither proves a fix.

Operations record supported agent navigation, click, fill, select, press, hover,
wheel, scroll-to, focus, blur and evaluation calls. Opt-in capture also installs a
main-frame observer in a named CDP isolated world, recording trusted manual input,
click, submission and navigation/reload events. Agent inputs suppress duplicate
manual events. Continuous typing is grouped with a 350 ms debounce; the operation
is marked running until the final input snapshot. Explicit stop flushes pending
input; interrupted tasks do not claim unfinished input completed. The observer,
new-document script, binding and timers are removed on stop or task release.

The immediate evidence window ends 1.5 seconds after the operation completes or
when the next operation starts. Later requests and console entries can appear for
up to 15 seconds as **possibly related**, capped by the next operation and stop.
A request already retained keeps its eventual response regardless of response
latency. This association is based on start time, not proof of causation.
All retained traffic remains accessible outside the operation view.

Page observations include bounded visible main-page text and up to 16 conventional
form fields with stable name/id and form identity. Field values are capped at 256
characters; credential, payment and file fields are omitted/redacted. Unidentified,
duplicate, overly long or custom field identities are not guessed. The observer
scans at most 80 candidate controls. Shadow DOM and iframe manual actions/fields
are not covered. Captured page text is bounded to 6000 characters; the accessibility
fallback also limits 100 lines. Observer values are redacted again before retention.

Follow-up page observations are coalesced at 700 ms, with bounded checkpoints to
catch silent field-property updates. Up to four changing observations are retained
per operation, with an explicit eviction flag. Page-load context is retained for
20 loads. The first later load of the same identified field can supply a later or
reload value; intervening operations are flagged, and this is not a causal claim.

The field-chain view shows recorded original, operation-time, submitted, response
and later page values. It joins only exact, unambiguous field names in complete
JSON/form bodies; different names, arrays, duplicate nested names, missing and
truncated bodies remain unlinked. Body field summaries are bounded to 12 requests,
96 scalar fields and 256 characters per value. Incomplete payload scans report
`payload_partial` and do not claim unique field matches. Full retained bodies remain available
through request details. Text differences require both recorded page states.

Cards display pending/interrupted work, truncated/unavailable bodies, missing
fields, late capture and capacity limits next to the evidence. A normal HTTP status
is not interpreted as business success. Console entries retain their source URL;
website, extension, browser and unknown sources are separated. Static resources
and extension traffic are folded by default, without deleting them from history
or export. There is no automatic root-cause verdict or completeness score.

## History and export

Already-redacted snapshots are stored in IndexedDB in the **current browser profile**,
including when connected to a remote daemon. They are separate from daemon-side audit.
No new daemon storage or browser permission is required. Removing the extension or
clearing its storage removes local history; previously exported files remain.

Request updates are coalesced and journaled to IndexedDB about every 100 ms,
with early flushes for batches. Reads and final saves flush pending writes.
Other capture context is checkpointed at most once per two seconds, with an immediate
save at start and stop. A crash can lose changes since the last checkpoint; recovered
records explicitly identify interruption and unavailable pending bodies. Storage
failures are displayed; live data remains exportable while retained in memory.

History keeps recent stopped records for 30 days, up to 50 records / 50 MiB total,
evicting the oldest stopped records first. Active captures are protected within
these limits. Requests have a separate journal of up to 2,000 entries / 8 MiB of serialized
request evidence per capture. This survives the smaller live-cache eviction. The owning task can still query and export its saved captures after they leave the four-run live cache; task completion or tab release revokes this access.
Failed requests, HTTP errors, controlled/replayed requests and Fetch/XHR/JSON traffic
have retention priority over ordinary resources. Old unpinned entries of the
lowest priority are removed first. Other context keeps its existing capture limits.
These are logical serialized-data budgets, not exact physical IndexedDB sizes. Export important records
before automatic expiration. Lists read only metadata; bodies are fetched on demand.

The JSON document contains `version: 1`, `saved_at`, `run`, `requests` (including
retained headers and bodies), `operations`, `console` and `pages`. Optional fields preserve manual/agent source,
field snapshots, later observations, extension version and browser user agent.
Older history remains readable and does not gain invented fields. Stable IDs link
operations to requests and console entries. Capacity counters, omissions and stop
reasons are preserved. Exporting an active capture produces a point-in-time snapshot.

`bsk debug export` writes this document directly to stdout while the owning task is
alive. Add `--output <new-file.json>` to save atomically without overwriting a file,
returning only path, byte count and run ID to the agent; stop capture before exporting a final record. After task teardown, use the
extension's history page to inspect/export the record, then give the JSON file to an
agent for analysis or comparison. Historical records are available to extension UI
only: creating another task or reusing a short session ID does not grant an agent
access to older tasks' data. There is no built-in comparison or repair action.

## Bounds and lifecycle

| Resource | Bound |
| --- | --- |
| Live in-memory captures | 4 across the extension; saved stopped captures evicted first |
| Local history | 30 days / 50 records / 50 MiB total |
| Page-load observations | 20 per capture |
| Fields / value length | 16 / 256 characters per page observation |
| Follow-up observations | 4 retained changes per operation, within 15 seconds |
| Live request cache / operations / console entries | 200 / 64 / 100 per capture |
| Additional in-flight tracking | 200 requests or body reads displaced from the live cache; overflow is explicitly marked `interrupted` / `tracking_limit` |
| Persistent request journal | 2,000 requests / 8 MiB per capture |
| Pinned requests | 20 completed requests per capture, each at most 8 MiB / 20 |
| Pending journal writes | 256 entries / 4 MiB, plus one batch in flight |
| Live request + response text cache | 512 Ki UTF-16 code units per capture; journal is separate |
| Individual body | 64 Ki code units, with explicit truncation/omission |
| Capture startup | 10 s total, including previous cleanup and storage waits; cancellation immediately stops retention and rolls back setup |
| Retained URL / explicit control URL | 2048 / 16384 characters; truncation is recorded separately from metadata completeness |
| Response acquisition | 4 concurrent jobs, 32 queued, 2.5 s command deadline |
| Browser response buffers | 2 MiB per target, 256 KiB per resource |
| Attached capture targets | Root + up to 16 existing/new iframe targets |
| Header retention | 4 Ki characters per header set; pending ExtraInfo bounded separately |

Known credential headers, URL parameters, JSON keys, form fields and common text
assignments are redacted before storage. This is not a guarantee that arbitrary
application data contains no secrets. Evidence is saved in browser-local history and returned when requested by the
owning agent or extension UI; it is not added to audit storage.
Bracket/dotted field paths and common password variants (for example
`user[password]`, `credentials.password`, `password_confirmation` and `newPassword`)
are covered in JSON, forms and URL parameters. Untouched JSON tokens, including
64-bit numeric IDs, retain their original text and precision. JSON-pointer and
field-chain views also preserve numeric tokens. Malformed or over-deep JSON is
omitted because its nested secrets cannot be inspected reliably.

Body states distinguish `pending`, `available`, `empty`, `truncated`, `unavailable`,
`omitted` and `evicted`, with reasons. Binary bodies, multipart content, oversized
structured bodies, saturated queues and missing browser buffers are explicit;
missing POST data in the event is `not_in_event`. Redaction changes only necessary
JSON source ranges; it does not parse and reserialize numeric values. A truncated
result is not suitable for a JSON-pointer query.

Capture starts at enable time; earlier traffic cannot be reconstructed. Worker
and service-worker internal requests, WebSocket frames, SSE chunks, screenshots,
arbitrary response rewriting, cross-origin replay and CPU profiling are outside this version's scope.
Iframe setup can miss its earliest requests; coverage flags report setup failure
or target limits. Ordinary browsing adds no debug subscription or page reads.
Stopping cancels observation timers and pending browser body reads, removes the
manual observer, then saves the
final retained record. It does not disable CDP domains shared by existing tools;
browser buffers end with task detachment.


## Request rules and replay

The request detail view offers **Modify request**, **Mock response**, **Block request**
and **Edit & replay**. The **Request rules** panel shows definitions, hit counts,
failures and enable/disable/remove controls. The popup only adds an active-rule
count to its existing task card. Stopped history shows definitions and outcomes,
never execution controls. Rule/replay evidence is included in JSON export; importing
or reopening history does not activate anything.

Start capture first. Rules belong to that capture and its owned tab, including
attached iframe targets. Defaults are **one match**, **Fetch/XHR only**, and **first
matching rule wins** in creation order. URL matches require an absolute HTTP(S)
origin; `*` is supported in path/query, while `?` is literal. Optional `method` and
`resource_type` (`Fetch`, `XHR`, `Document`) narrow the match. `times: 0` lasts until
disabled or capture ends; 1..100 sets a total match budget. Re-enabling does not
reset the budget. Exhausted rules must be recreated. Cache/Service Worker handling
is unchanged, so inspect actual rule hits instead of assuming every page request
reached the interception layer. Early iframe traffic can precede target setup.

The agent sends a declarative rule once; the extension executes it locally without
an agent round trip per request. Interception is enabled only for the rule's URL
patterns and resource types. Disabling/removing a rule cancels its pending delayed
responses. Stop, release, disconnect and restart never restore active rules.
Pending mocks are aborted rather than falling through to the real server.

```sh
# Rename the live outgoing JSON field once; other fields remain intact.
bsk debug rule_add --session <id> --rule-file rename-rule.json
bsk debug rules --session <id>
bsk debug rule_disable <rule-id> --session <id>
bsk debug rule_enable <rule-id> --session <id>
bsk debug rule_remove <rule-id> --session <id>
```

`rename-rule.json`:

```json
{
  "name": "Send the expected nickname field",
  "match": {"url": "http://localhost:3000/api/profile", "method": "POST"},
  "effect": {"type": "modify", "json": {"rename": {"displayName": "name"}}},
  "times": 1
}
```

Effects:

- `{"type":"block"}`: fail the matching request with `BlockedByClient`.
- `modify`: optional same-origin `url`, `method`, `headers` (string values replace,
  `null` removes), and either a complete text `body` or `json` edits. JSON edits
  support top-level `set`, `remove`, and `rename`; missing rename sources or
  occupied destinations and duplicate top-level keys abort the request rather than guessing.
  Unchanged values retain their original numeric tokens. Unsafe numeric values in
  `set` are rejected; use a complete text `body` when supplying exact large numbers.
  Browser-managed
  headers are not editable. Binary/multipart body edits are unsupported.
- `mock`: required `status` and text `body`, optional response `headers` and
  `delay_ms` (0..10000). Defaults to JSON content type. Status is 200..599 excluding
  redirect statuses and 304; 204/205 require an empty body. HEAD responses omit
  the body. Cookie setting and encoded response bodies are unsupported.

Requests carry `intervention` with the rule ID, action, outcome and changed fields.
For successful modification, retained request details describe the effective
request. Rule failures/cancellation are explicitly labelled; a mock is never
presented as an actual server response. Redacted rule definitions survive stop,
but executable rule objects are discarded. Ordinary captures add no Fetch work.

### Replay

```sh
bsk debug replay <request-id> --session <id> --replay-file replay.json
```

```json
{"key":"nickname-attempt-1","body":"{\"name\":\"Bob\"}"}
```

`--rule` and `--replay` also accept inline JSON. DSH exposes these as JSON-string
`rule` / `replay` parameters on `browser_inspect(action: "debug")`, with the same
`debugAction` values. File input avoids putting large bodies in command arguments.

Replay sends a **new** request and may change server data. It uses a dedicated
isolated page context with the current page's cookies, never an extension-origin
proxy. Source request, destination and current page must share an HTTP(S) origin.
Cross-origin replay, redirects and binary/multipart bodies are rejected. Browser
controlled headers (including Cookie, Origin and Content-Length) are supplied by
the browser. Other captured headers are merged with explicit overrides; replace
redacted values or remove them with `null`. Reusing retained data requires
`integrity.url: "complete"`, complete request metadata and
`request_body.replay_safe: true`. The body flag means the complete stored body is
byte-for-byte unchanged as text; `available` alone only promises displayable evidence.
Missing, truncated, transformed or unverified bodies require an explicit complete
replacement. A truncated or transformed URL requires a complete same-origin `url`
replacement; replacing the URL does not override incomplete headers/metadata.
Older records lacking these markers remain readable, but require explicit URL/body
replacements. The replay editor leaves an unverified URL empty and never silently
submits an untouched evidence draft as a replacement. Redacted placeholders are never sent. Page
navigation/context loss can interrupt the attempt.

A caller-provided `key` is required. Reusing it within the same capture returns
that attempt, including its failure, without sending again. Retry an uncertain
call with the **same key**; create a new key only when deliberately sending a new
request. The result includes a replay ID and linked request ID when Chrome supplies
the initiator. Requests carry `replay_from` / `replay_id`; separate replays are not
joined into a page action's field chain. This does not invoke the original page
handler or guarantee a UI update. A completed replay means its network operation
completed, not that the application succeeded.
Active rules also apply to matching replay requests; both provenance markers are retained.

Limits: 32 rule definitions and 20 replay attempts per capture; 32 concurrent
rule handlers; 64 Ki characters per body; 80 KiB of input JSON. Replay has a
15-second request deadline and a 256 KiB response-read limit. Read the linked
request for HTTP status/body and omissions. Rules and replays require an active
capture in the original owning task. Already-exported history remains read-only.
