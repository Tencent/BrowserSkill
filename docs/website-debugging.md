# Website debugging

BrowserSkill lets a developer's agent investigate their own website through the
same owned browser task. Three complementary views are available:

- **Request details:** stable request IDs, URL/method/status, headers, POST body,
  response body, initiator, timing, failure, redirect and cache metadata.
- **Operation evidence:** agent inputs linked by time window to network activity,
  console messages/exceptions and main-page text before/after.
- **Verification:** compare two operations, inspect business response fields and
  visible results, and let the agent explain its conclusion using evidence IDs.

The extension does not run another model. The existing agent investigates using
structured, bounded evidence. This is independent of persistent operation audit.

## Entry points

The popup preserves connection settings, browser automation preferences and
existing Quick Actions. A current-task card links to a separate evidence page.
Quick Actions → Website debugging starts/stops capture for an existing task and
opens its evidence. Without a task, it provides a prompt to give the agent.
The evidence page includes a timeline, requests, body/header/timing details and
comparison between operations in retained captures from the same task.

Capture must be started **before** navigation or reproduction. It targets exactly
one task-created or borrowed tab per task. Opening a user tab or placing it in an
Agent Window does not authorize capture. Returning/closing that tab, ending its
task, disconnecting or restarting the extension removes its evidence. Stopping
capture alone retains evidence until one of those lifecycle events or eviction.

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
# Fix the project, repeat the same inputs, then inspect the new operation.
bsk debug compare --session <id> --before <operation-id> --after <operation-id>
bsk debug stop --session <id>
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

Operations record supported navigation, click, fill, select, press, hover,
wheel, scroll-to, focus, blur and evaluation calls. An operation's evidence
window starts just before input and ends 1.5 seconds after completion or when
another operation starts. Request association uses request start time, not
completion time. Slow responses can finish later; asynchronous requests starting
outside that window remain in `requests`. A temporal association is not causality.

Page observations use main-frame accessibility text (headings, static text,
alerts and status), bounded to 6000 characters/100 lines. Input values are not
captured. The before-read has a 600 ms deadline; the after-read is asynchronous.
A next action can provide the previous action's post-state within that window.
This is a text observation, not a screenshot or complete DOM diff. Unavailable
observations stay explicit. Console repeats coalesce only within the same action.

Comparison returns each side's evidence and `same_target`; it does not produce a
`fixed` verdict. Matching method/label/selector does not prove equal inputs. Verify
identical inputs, relevant response fields and the intended visible outcome.

## Bounds and lifecycle

| Resource | Bound |
| --- | --- |
| Retained captures | 4 across the extension; oldest stopped capture evicted first |
| Requests / operations / console entries | 200 / 64 / 100 per capture |
| Retained request + response text | 512 Ki UTF-16 code units per capture |
| Individual body | 64 Ki code units, with explicit truncation/omission |
| Response acquisition | 4 concurrent jobs, 32 queued, 2.5 s command deadline |
| Browser response buffers | 2 MiB per target, 256 KiB per resource |
| Attached capture targets | Root + up to 16 existing/new iframe targets |
| Header retention | 4 Ki characters per header set; pending ExtraInfo bounded separately |

Known credential headers, URL parameters, JSON keys, form fields and common text
assignments are redacted before storage. This is not a guarantee that arbitrary
application data contains no secrets. Evidence stays in extension memory until
requested by the agent or extension UI; it is not added to audit storage.

Body states distinguish `pending`, `available`, `empty`, `truncated`, `unavailable`,
`omitted` and `evicted`, with reasons. Binary bodies, multipart content, oversized
structured bodies, saturated queues and missing browser buffers are explicit;
missing POST data in the event is `not_in_event`. Bounded redacted JSON can be
reformatted; a truncated result is not suitable for a JSON-pointer query.

Capture starts at enable time; earlier traffic cannot be reconstructed. Worker
and service-worker internal requests, WebSocket frames, SSE chunks, screenshots,
request interception/replay and CPU profiling are outside this version's scope.
Iframe setup can miss its earliest requests; coverage flags report setup failure
or target limits. Ordinary browsing adds no debug subscription or page reads.
Stopping cancels observation timers and pending evidence writes, without disabling
CDP domains shared by existing tools; browser buffers end with task detachment.
