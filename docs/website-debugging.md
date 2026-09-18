# Website debugging

BrowserSkill lets a developer's agent investigate their own website through the
same owned browser task. It records browser evidence for people and agents to inspect later:

- **Request details:** stable request IDs, URL/method/status, headers, POST body,
  response body, initiator, timing, failure, redirect and cache metadata.
- **Operation evidence:** agent and manual inputs grouped with immediate and delayed
  requests, source-labelled console messages, field values and visible page changes.
- **History:** browser-local recordings with page-load context, all retained console
  entries, and portable JSON export, independent of the original task lifecycle.

The extension records evidence and can execute explicitly configured, task-local HTTP rules and replays. Analysis and comparison belong to the
user or their agent; project discovery and source-code repair are outside this feature. This is independent of persistent operation audit.

## Entry points

The popup preserves connection settings, browser automation preferences and
existing Quick Actions. A current-task card links to a separate evidence page.
Quick Actions → Website debugging starts/stops capture for an existing task and
opens its evidence. Without a task, it provides a prompt to give the agent.
The evidence page opens both live and historical records, with a timeline, requests,
body/header/timing details, Console, and page context. History is reachable through
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
bsk debug export --session <id> > website-debug.json
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
96 scalar fields and 256 characters per value. Full retained bodies remain available
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

Changed captures are checkpointed at most once per two seconds, with an immediate
save at start and stop. A crash can lose changes since the last checkpoint; recovered
records explicitly identify interruption and unavailable pending bodies. Storage
failures are displayed; live data remains exportable while retained in memory.

History keeps recent stopped records for 30 days, up to 50 records / 50 MiB total,
evicting the oldest stopped records first. Active captures are protected within
these limits. The existing per-capture limits still apply: history preserves the
retained evidence, not an unlimited archive of all traffic. Export important records
before automatic expiration. Lists read only metadata; bodies are fetched on demand.

The JSON document contains `version: 1`, `saved_at`, `run`, `requests` (including
retained headers and bodies), `operations`, `console` and `pages`. Optional fields preserve manual/agent source,
field snapshots, later observations, extension version and browser user agent.
Older history remains readable and does not gain invented fields. Stable IDs link
operations to requests and console entries. Capacity counters, omissions and stop
reasons are preserved. Exporting an active capture produces a point-in-time snapshot.

`bsk debug export` writes this document directly to stdout while the owning task is
alive; stop capture before exporting a final record. After task teardown, use the
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
| Requests / operations / console entries | 200 / 64 / 100 per capture |
| Retained request + response text | 512 Ki UTF-16 code units per capture |
| Individual body | 64 Ki code units, with explicit truncation/omission |
| Response acquisition | 4 concurrent jobs, 32 queued, 2.5 s command deadline |
| Browser response buffers | 2 MiB per target, 256 KiB per resource |
| Attached capture targets | Root + up to 16 existing/new iframe targets |
| Header retention | 4 Ki characters per header set; pending ExtraInfo bounded separately |

Known credential headers, URL parameters, JSON keys, form fields and common text
assignments are redacted before storage. This is not a guarantee that arbitrary
application data contains no secrets. Evidence is saved in browser-local history and returned when requested by the
owning agent or extension UI; it is not added to audit storage.

Body states distinguish `pending`, `available`, `empty`, `truncated`, `unavailable`,
`omitted` and `evicted`, with reasons. Binary bodies, multipart content, oversized
structured bodies, saturated queues and missing browser buffers are explicit;
missing POST data in the event is `not_in_event`. Bounded redacted JSON can be
reformatted; a truncated result is not suitable for a JSON-pointer query.

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
  occupied destinations abort the request rather than guessing. Browser-managed
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
redacted values or remove them with `null`. Missing/truncated bodies require an
explicit complete replacement. Redacted placeholders are never sent. Page
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
