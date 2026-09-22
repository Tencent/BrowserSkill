# Website debugging

Use `debug` to investigate a website failure, unexpected request or performance
problem, or to save evidence of a reproduction. Ordinary browsing and isolated
console/network reads do not require capture. Debugging records browser evidence;
it does not discover a source repository or repair code.

## Capture, reproduce, inspect, save

1. Use the session and task-created or borrowed tab from the main workflow. For a
   specific tab, pass its actual `--tab-id` to `debug start` and navigation/actions.
   Start **before** navigation or reproduction; earlier traffic is not recovered:

   ```sh
   bsk debug capabilities --session <id>
   bsk debug start --session <id> --name "<issue>"
   bsk navigate <url> --session <id>
   ```

   If the page is already open, start capture before the next reproduction; reload
   only if that is part of the intended investigation. One tab can be captured per
   task. Startup has a 10-second total deadline; cancellation stops collection.
2. Reproduce once with fresh observed controls, or let the user reproduce manually
   in that tab. Read `bsk debug operations --session <id>`, then
   `bsk debug operation <operation-id> --session <id>` for an operation's requests,
   console, page changes and field-value chain. Manual capture covers the main frame.
3. Inspect returned evidence IDs with the commands below. Separate observations
   from hypotheses and state what is missing. Do not infer business success from
   HTTP 200 or causation from a shared time window. Delayed links are tentative;
   do not match differently named fields merely because their values are equal.
4. Stop and save before normal session cleanup:

   ```sh
   bsk debug stop --session <id>
   bsk debug export --session <id> --output <new-file.json>
   ```

   Export uses a new filename and includes all retained evidence, not lost data.
   Stopping or ending the task preserves browser-local history; users can view and
   export it through Website debugging → History. A new task cannot read an ended
   task's history; use a user-provided export. Keeping a session open still follows
   the main workflow's cleanup rule.

## Read the evidence

Every command below also needs `--session <id>`. Use `--run-id <capture-id>` to
select an earlier recording belonging to the current task; otherwise the latest
matching capture is selected. Use returned IDs, not guessed ones.

| Need | Command |
| --- | --- |
| Capture list/state | `bsk debug status` |
| Requests, including outside operation windows | `bsk debug requests --kind business --url /api/` |
| Response or submitted body | `bsk debug request <request-id> --part response` or `--part request` |
| Headers or timing | `bsk debug request <request-id> --part headers` or `--part timing` |
| Exact JSON field | `bsk debug request <request-id> --part response --pointer /path/to/field` |
| All retained console entries / page-load context | `bsk debug console` / `bsk debug pages` |

Lists omit body text. Body states `pending`, `unavailable`, `omitted`, `truncated`
and `evicted` describe missing evidence, not empty responses. JSON pointers need a
complete body. `payload_partial` means a field scan was incomplete: inspect the
body directly rather than assuming a unique field match.
Attribute errors using their recorded website/extension/browser
source. Common credentials are redacted before retention; free-form data can still
be sensitive. Never request secrets or send evidence elsewhere without authorization.

`capabilities --session <id>` reports actual browser actions, limits and builds;
without a session it reports only the CLI schema. Use these limits and command help
rather than guessing. Query output defaults to 64 KiB (`--budget` 4096..262144 bytes);
`--limit` is 1..100. Requests accept URL substring, exact method/resource type/status/
state, traffic kind and optional comma-separated `--fields` projections.

Follow `next_since` with `--since` for requests/operations and merge updates by ID.
For body slices, use the body's `next_offset` with `--offset`; console/pages,
performance and analysis use top-level `next_offset`. Inspect `output.omitted`/`output.truncated`
for output loss and `run.storage`/`run.coverage` for capture/storage gaps. Increase
the budget, narrow the read or export; never treat a partial record as no event.

`pin <request-id>` protects a completed request from that capture's capacity
eviction; `unpin` reverses it. Limits are 2000 requests / 8 MiB per capture and
20 pins. Whole-record expiry/deletion still applies (30 days / 50 records / 50 MiB).
Restart recovery uses the last checkpoint and marks interruption; recent data may
be missing.

Keep browser commands serial per task. A `session_busy` command was not dispatched.
Read `bsk debug activity --session <id>` or wait without resending:
`bsk debug wait --session <id> --command-id <returned-id> --wait-ms 10000`.
Omit the command ID to wait for idle; `--wait-ms` is 0..60000. Completion means no
longer running, not success: inspect the original result. Cancelling a waiter does
not cancel the original command.

## Performance and request analysis

- `bsk debug performance --session <id>`: main-frame navigation, FCP/LCP/CLS and
  long tasks. Check metric states/reasons and visibility; hidden, late, interrupted
  or unsupported samples are not final Core Web Vitals. INP/CPU profiles are absent.
- `bsk debug aggregate --session <id> --url /api/ --slow-ms 1000`: groups method and
  origin/path with timing samples, P95, errors, slow counts and source request IDs.
- `bsk debug duplicates --session <id> --window-ms 1000`: suspected equal
  method/URL/body/frame/document bursts; legitimate retries and polling can match.

Both request analyses default to business traffic and exclude rules/replays;
`--include-controlled` includes them. Inspect referenced requests and gaps. Use
`--offset`/`next_offset`; stop capture for stable pagination. Summaries cover only
retained evidence and do not determine root cause.

## Explicit network experiments

Observing a problem does not itself authorize extra submissions or changed traffic.
Use controls only within the user's requested experiment, on an active capture.
Inspect the actual request first; use task-local rules instead of page monkey patches.

`bsk debug rule_add --session <id> --rule-file <path>` accepts a rule such as:

```json
{"match":{"url":"http://localhost:3000/api/profile","method":"POST"},"effect":{"type":"modify","json":{"rename":{"displayName":"name"}}},"times":1}
```

Replace the endpoint and fields with observed ones. Rules match absolute HTTP(S)
URLs (`*` in path/query), default to one Fetch/XHR match, and use the first match.
Effects are `block`, `modify` or `mock`. Modify supports same-origin URL, method,
headers (`null` removes), complete text body, or top-level JSON set/remove/rename.
Use exact text body replacement for unsafe numeric values; never guess field mappings.
Mock supplies status/body and optional headers/delay; it does not call the endpoint.
Use `capabilities` and the rule schema for limits and unsupported options.

Read `rules` for hit counts/state; `rule_enable`, `rule_disable`, `rule_remove`
take a rule ID. `times: 0` lasts until disabled or capture ends. Rules execute
locally without agent polling. Stop clears controls and cancels delayed mocks.
Active rules also apply to matching replays.
Keep modified/mocked/blocked evidence distinct; mock success does not prove a fix.

Replay sends a **new request** and may change server data:
`bsk debug replay <request-id> --session <id> --replay-file <path>`.
The file contains `{"key":"unique-attempt","body":"{\"name\":\"Bob\"}"}`;
optional URL/method/headers/body override the source. Same-origin only, using current
page cookies; redirects and binary/multipart replay are unsupported.

Implicit reuse requires `integrity.url: "complete"`, complete request metadata and
`request_body.replay_safe: true`. `available` means displayable, not replay-safe.
`integrity.metadata` covers the request; `integrity.response_headers` is independent
and does not restrict replay.
Supply complete replacements for changed, truncated, missing or unverified URL/body,
including older records without these markers. Replace/remove redacted headers;
never send placeholders. Replacing the URL does not repair incomplete metadata.
Reuse the same key after an uncertain result; a new key is a deliberate new attempt.
Inspect the linked request/response. Replay does not repeat the page event handler
or guarantee a UI update. Historical evidence never activates rules or replays.
