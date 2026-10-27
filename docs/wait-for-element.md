# Waiting for an element

`bsk wait-for-element` (`tool.wait_for_element`) polls one element inside the
extension. Use it between a triggering action and the next observation when the
page has a known readiness signal. It returns immediately on a matching probe.

| State | Condition |
| --- | --- |
| `attached` | The target is connected to the DOM. |
| `detached` | The target is absent, including a selector unmatched at the first probe. |
| `visible` (CLI default) | Attached, passes CSS visibility/opacity checks, and has a nonzero bounding box. |
| `hidden` | Absent or does not meet the visibility condition, including a selector unmatched at the first probe. The opposite of `visible`. |

`visible` does not guarantee enabled state, lack of occlusion, an in-viewport
position, or completed application initialization. Wait for the signal your task
actually needs: for example, a loading mask becoming hidden followed by an
observation of the results. Waiting for an already absent or hidden mask can return
before loading starts; choose a post-action result marker when that race is possible.

Pass exactly one CSS selector or ref. Selectors are queried again each time using
`querySelector` in the main document: **only the first match is checked**, not every
matching element. Scope the selector to the intended component, such as
`#orders-panel .el-loading-mask`; a broad `.el-loading-mask` may find a hidden mask
while another table is still loading. Use an application readiness marker if the
task depends on several components. Use a fresh snapshot/observe ref for frame or
shadow-root targets.

Refs identify an existing observed node. Unknown, invalidated, or cross-tab refs
return `not_found` with `data.reason: "ref_not_found"`, including for `hidden` and
`detached`. A valid ref whose node has left the DOM can satisfy both states; the
`attached` result distinguishes removal from a node still in the DOM. Debugger
disconnects, invalid selectors and other inspection failures remain errors; they
do not prove absence.

If a selector's node id expires during lookup, the next poll queries the selector
again. A replacement may already match; a failed lookup does not replace the last
completed observation or by itself satisfy the wait.

A full-document navigation invalidates the tab's refs, even if the wait already
probed the old node successfully. Use `wait-for-navigation` for page lifecycle
readiness and then `observe` for refs in the new document, instead of waiting for
an old ref to become detached. Likewise, removing an entire out-of-process iframe
can destroy its CDP session: a wait on a ref inside that frame can return a CDP
error rather than `hidden`/`detached`. To check removal of the iframe itself, target
the parent document's `<iframe>` element instead.

## Timeout and evidence

The default inspection budget is 10 seconds (`--timeout`, 1ms–5m). It starts after
the target tab is resolved and includes every probe. `--poll-ms` accepts 16–2000ms
(default 100ms); final intervals are shortened to leave time for a probe before the
deadline. No new probe starts after the deadline and late replies cannot satisfy
the wait. Chrome cannot cancel an already dispatched CDP read, so late replies are
ignored and their object handles are released when available. Ctrl-C cancels the wait.

A condition timeout is a normal result with **`satisfied: false` and CLI exit code
0**. Do not use `wait-for-element ... && next-command` to decide whether to proceed.
Inspect `satisfied`; transport, ref and CDP errors still use nonzero CLI exit codes.

`attached` and `visible` report the last probe completed within the budget. They
are both `null` if no probe completed, such as when the renderer did not answer the
first probe. They are evidence from that probe, not a fresh observation at return
time. `elapsed_ms` measures actual inspection/wait time using a monotonic clock;
it excludes CLI/daemon round trips and does not pretend a delayed event loop stopped
exactly at the configured timeout.

## Trigger → wait → check → observe

The following complete Bash example uses `jq`. Replace the URL, `#run-search` and
`#search-results` with known targets from your page. The page is expected to reveal
`#search-results` only after the search finishes.

```bash
#!/usr/bin/env bash
set -euo pipefail
session=$(bsk session start --json | jq -er '.session_id')
trap 'bsk session stop "$session" >/dev/null' EXIT

bsk navigate 'https://example.com/search' --session "$session"
bsk observe --session "$session"
bsk click '#run-search' --session "$session"

result=$(bsk wait-for-element '#search-results' --state visible \
  --timeout 20s --session "$session" --json)
if ! jq -e '.satisfied == true' <<<"$result" >/dev/null; then
  printf 'Search results were not ready: %s\n' "$result" >&2
  exit 1
fi

# Waiting does not allocate fresh element refs. Observe after success before
# choosing a new result/control to interact with.
bsk observe --session "$session"
```

For an already visible Element UI loading mask on the orders panel, the waiting
line can be:

```bash
result=$(bsk wait-for-element '#orders-panel .el-loading-mask' --state hidden \
  --timeout 20s --session "$session" --json)
```

Keep the same `satisfied` check and subsequent `observe`. Element UI 2.15.14's
[`v-loading` directive](https://github.com/ElemeFE/element/blob/v2.15.14/packages/loading/src/directive.js)
keeps its mask in the DOM and
[hides it with `v-show`](https://github.com/ElemeFE/element/blob/v2.15.14/packages/loading/src/loading.vue),
while [`Loading.service`](https://github.com/ElemeFE/element/blob/v2.15.14/packages/loading/src/index.js)
removes it after the leave transition. `hidden` covers both lifecycles. For a
fullscreen service mask mounted under `body`, target its unique `customClass`
instead of a panel descendant. Use `detached` only when actual removal is required.

Multiple conditions, enabled-state checks and returning a new observation are
outside this single-element wait API.

## Browser validation

See [the repeatable browser comparison](../evals/browser/cases/regression/element-waits/README.md)
for foreground/background fixtures, success rates, elapsed wait time and counted
CLI invocations. The benefit is fewer caller round trips, shared state semantics
and no hand-written polling JavaScript. It does not guarantee a faster wait or
bypass browser throttling of the page's work. RPC reduction alone is not evidence
of Agent end-to-end speedup; that requires a separate task benchmark including
observations and model latency.
