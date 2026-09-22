# Website debugging

Use `browser_inspect` with `action: "debug"` to record and investigate a website
problem. Keep ordinary browsing capture-free. All examples use the owning
`session`; use returned IDs and the owned `tabId` when targeting a specific tab.
Read loaded schemas for parameters; `debugAction: "capabilities"` reports supported
actions, limits, filters and build information.

## Capture, reproduce, inspect, save

1. Record the problem and expected result. Start a session or borrow the user's tab
   following [tabs and profiles](tabs-and-profiles.md). Start capture **before**
   navigating or reproducing; earlier traffic cannot be recovered.

   ```text
   browser_inspect({ action: "debug", debugAction: "start", session: "<id>", name: "Nickname does not persist" })
   browser_page({ action: "navigate", session: "<id>", url: "https://example.com/profile" })
   browser_inspect({ action: "observe", session: "<id>" })
   ```

2. Retain the returned run ID; pass it as `runId` for subsequent reads. Reproduce
   with ordinary interaction tools, or let the user act (manual capture covers the
   main frame). Observe the outcome; allow expected delayed work to finish.
3. Read `operations`, then `operation` with its `id` to inspect associated requests,
   console messages, field values and later page changes. Use `requests`, then
   `request` with its `id` and `part: "request"` or `"response"` for body text;
   metadata is the default. `console` and `pages` expose other retained context.
4. Use `stop` to save the final record, then export before stopping the session:

   ```text
   browser_inspect({ action: "debug", debugAction: "stop", session: "<id>" })
   browser_inspect({ action: "debug", debugAction: "export", session: "<id>", runId: "<run-id>", output: "<new-file.json>" })
   browser_session({ action: "stop", session: "<id>" })
   ```

`export` writes a new file without overwriting and returns its path/size. Exporting
while capturing gives a point-in-time record. Browser-local history survives task
completion within retention limits; inspect/export it through the extension after
session teardown. A new session cannot read another task's history. Give exported
JSON to an agent for analysis/comparison; there is no repair or comparison action.
`pin`/`unpin` with a completed request `id` protect it from capacity eviction,
not record expiry.

## Decide whether the evidence supports a conclusion

Operation links are time associations, not proof of causation. Distinguish original,
submitted, response and later page values only where recorded; do not invent missing
steps. HTTP 200 is not business success. Console source labels distinguish website,
extension, browser and unknown errors.

Check `run.coverage`, `run.storage`, body states/reasons and `output.omitted`.
Late start, unsupported capture, pending work, truncation, eviction and storage
failure can leave gaps: missing evidence does not mean an event did not happen.
State the supported finding and the specific gap preventing a stronger conclusion.
Evidence may be redacted; never treat displayable text as an exact original request.

## Read within a budget; wait without repeating commands

Default output budget is 64 KiB; `budget` accepts 4096..262144 bytes, export exempt.
For `requests`, filter with `url`, `method`, `resourceType`, `status`, `state` or
`kind`; `kind: "business"` reduces resource noise. Use a comma-separated `fields`
string from capabilities for optional projections. `limit` is 1..100. Requests/operations return `next_since`:
pass it as `since` and merge updates by ID. Body slices return the body's
`next_offset`; console/pages, performance and analysis return top-level `next_offset`. Pass it
as `offset`. Body reads also accept `maxChars` and a JSON `pointer` for complete bodies.
Pagination does not imply completeness: inspect omissions and availability flags.

When busy, read `activity`; use `wait` with `commandId` from activity or
`session_busy`, and optional `waitMs` up to 60000. Omitting `commandId` waits for
idle. Waiting neither resends nor cancels a command; completion is not success.
Inspect the result/page before retrying an operation with uncertain effects.

## Performance and request summaries

`performance` reports main-frame navigation/paint, CLS and long tasks, not INP or
CPU profiles. Read each metric's state/reason and visibility history; hidden-page
or late-start metrics may be invalid.
`aggregate` groups method/path with latency percentiles, errors and slow counts
(`slowMs`). `duplicates` reports suspected equal URL/body/document bursts
(`windowMs`); valid retries or polling can look repetitive. Both default to business
traffic and exclude rule/replay experiments; `includeControlled: true` includes them.
Follow linked request IDs and coverage gaps. Stop capture for stable summary
pagination, using `offset`/`next_offset`, not `since`.

## Explicit network experiments

Capture alone does not alter traffic. Use rules/replay only within the user's
requested experiment: they can block or change live requests and server data.
They require active capture in the original owning task; history never reactivates controls.

`rule_add` takes a **JSON-string** `rule` containing `match`, `effect` and optional
`times`. Match an absolute URL; `*` matches path/query. Effects are `block`,
`modify` (same-origin URL, method, headers, text body or top-level JSON edits) and
`mock` (status, text body, optional headers/delay). Default: one Fetch/XHR match;
first matching rule wins. `times: 0` lasts until disabled/capture ends. Read `rules`
for IDs, hits and failures; `rule_enable`, `rule_disable`, `rule_remove` take `id`.
Capture end clears execution. Check recorded `intervention`; a mock is not a server
response. Active rules also apply to matching replays.

`replay` takes the source request `id` and a **JSON-string** `replay`, for example
`"{\"key\":\"attempt-1\"}"`; add explicit `url`/`body` replacements when needed.
It sends a new request using current cookies. Source, destination and current page
must share an HTTP(S) origin; redirects, cross-origin and binary/multipart replay
are unsupported. Reuse the **same key** after an uncertain result to avoid sending
again; a new key deliberately creates a new attempt. Inspect the linked request
for outcome; replay does not invoke the original page handler or guarantee UI updates.

Reusing retained values requires `integrity.url: "complete"`, complete metadata
and `request_body.replay_safe: true`. Body `available` only means displayable.
Changed, truncated or unverified URL/body require explicit complete replacements;
old records without these markers do too. Never copy a truncated evidence draft as
its replacement. Replacing URL/body cannot fix incomplete metadata. Replace known
redacted headers with authorized values or remove them with `null`; never send
redacted placeholders or guess secrets. Preserve exact numeric tokens when supplying
text bodies; JSON edits must not round large numeric IDs.
