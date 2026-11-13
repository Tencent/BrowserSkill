# Reading changing pages

Use `bsk read` (MCP: `bsk_inspect` action `read`) for current DOM facts.
`evaluate` remains arbitrary page execution, including writes and deferred work.
A script that states nothing keeps its strict observation requirement, so repeated
sync/evaluate on a carousel is the wrong data path. Read the current facts, decide from those facts,
and protect the decision with `expect` before DOM input.

```sh
bsk cooperate sync --session SID
# Model/scheduler delay and unrelated animation may happen here.
bsk read --session SID --selector '.swiper-slide-active' \
  --fields-json '[{"key":"index","read":"attribute","attribute":"data-swiper-slide-index"},{"key":"text","read":"text"}]'
bsk click @e3 --session SID --context CONTEXT \
  --expect '[{"target":"@e3","field":"attribute","attribute":"aria-label","equals":"Go to slide 3"}]'
```

Use actual returned refs, context and values. A read is a current sample, not a
new control context, strict observation or authorization to replay an action.
An old context supplied to a read is still rejected. Reads without context can
inspect the current page after control changes; subsequent input must synchronize.

| Operation | Evidence and validation |
| --- | --- |
| read, snapshot, HTML, bounded extraction | Current document/attachment and exact node identity; no historical whole-page comparison. No page input. |
| Target-policy DOM input | Reusable control context, exact pinned node, readiness, pointer hit/focus and explicit business `expect` facts immediately before input. |
| Arbitrary evaluate | Scripts are opaque even if they look read-only, and dispatch cannot be rolled back. In order of preference: stated facts (`expect` without `observation_id` under target policy, `depends_on` regions under strict) are checked and the rest of the page may change; with `observation_id`, a single-use strict observation of the whole page; `unverified` compares nothing about the page, keeps control and main-document checks, and returns `verified: false`. |
| Visual input, untargeted keys, displacement-only drag | Strict observation and existing geometry/focus guards; a DOM read cannot refresh them. |
| Strict-policy input | Existing single-use whole-page contract. read/extract do not renew it. |

`evaluate --unverified` requires daemon and extension protocol 1.9 or later compatible 1.x;
peers below 1.9 are rejected before dispatch. The version gate cannot distinguish earlier
1.9 development builds, so update the CLI, restart its daemon and reload the matching extension
together. Strict contexts still authorize only one action, including an unverified script.

Unrelated clocks, counts, carousel DOM replacement/reordering, class/style changes,
video state, Canvas drawing and unrelated child navigations can occur during data
gathering. `read` returns DOM facts; it does not interpret Canvas pixels, video
frames, application JS objects or data not loaded in the DOM. Use screenshots
for visual evidence and `extract` for normalized table/list data. Transform JSON
on the host when arbitrary computation is needed.

Target removal/replacement must not redirect an old ref. Hidden/disabled/read-only
targets wait only within their action budget; missing targets and failed business
conditions fail without replay. A ref identifies a node, not a record. Protect
recycled row IDs, button meaning, price, recipient and input values with `expect`.
Check all facts needed for a comparison, not just one chosen candidate. Restored
values can match again; this is a value check, not a promise of unbroken history.

Main document navigation and SPA route changes invalidate old refs and context,
including away-and-back and hash routes. Child-frame reads use that ref's exact
frame/session and current document identity. A changed or unavailable target
document fails; unrelated unavailable frames need not make a main-document read
stale. Selectors search the main document; use refs for nested frames and shadow
nodes. Fields cannot silently search another frame. Cross-frame operations are
separate samples, not an atomic snapshot. Control-state collection can race child navigation after its document inventory.
It recollects once only if the browser proves all failed child documents retired
and the main document stayed identical. Active unobservable documents and further
churn still fail closed; this never retries an input action. Existing iframe action guards remain
conservative after collected frame documents change; a fresh sync may be required
even for an iframe target unaffected by another frame's navigation.

Human editing, takeover, stop, tab closure, disconnect and cancellation keep their
existing control/lifecycle rules. Passive reads do not acquire control or cancel a
stop request. Focus/caret movement and scrolling are not equivalent to a completed
click/edit. After `effect_state: unknown`, inspect application records before any
decision to repeat. Preparation can itself trigger page handlers, so conservative
unknown results must not be relabeled as no effect merely because no click receipt
was returned. No automatic retry or script fallback is used by read.

## Query and security boundary

Parameters are JSON data: optional main-document selector **or** exact DOM ref;
1–32 fields with a key, one of text/attribute/value/checked/exists, optional relative
selector (at most one match), and an attribute name only for attribute reads.
No functions, arbitrary property paths, expressions, promises or `readonly` flag
are accepted. A missing top-level selector returns no items. A missing field is
null (`exists` is false). Text is exact `textContent`, including hidden DOM and
whitespace. Sensitive controls and ancestor text containing them return null with
the field named in `redacted`. A relative selector is scoped to the item's light
DOM; use an observed ref to a shadow node instead of inventing a piercing selector.

The extension sends **its own fixed function source** and supplies the validated
options through CDP arguments. It runs synchronously in an isolated world with
native DOM accessors. Main-world getters, prototype overrides, `toJSON` hooks and
page functions are not consulted. It contains no eval, Function construction,
input dispatch, DOM writes, event dispatch, network access, timer, callback,
Promise or awaited page result. User strings are never interpolated into code.
There is consequently no accepted capability that can schedule a later write.
This does not prevent the website's own independent activity or promise an atomic
transaction with its server.

The node cap is 100 by default (1–1000), fields default to text, JSON bytes default
to 262144 (1024–1048576), and the collector checks a 3000ms work budget (100–10000).
Native browser queries are finite but not interruptible between budget checks;
the CDP read/transport cancellation deadline remains the outer bound. Node limits
set `truncated`; byte overflow, invalid selectors and ambiguous fields fail rather
than returning a plausible partial value. Document identity and attachment are
rechecked before publishing results/refs; output byte bounds also cover metadata.

## Clients and compatibility

| Client | Fields and limits |
| --- | --- |
| CLI | `bsk read --selector CSS` or `--ref @eN`; `--fields-json` array, `--max-nodes`, `--max-bytes`, `--timeout-ms` |
| MCP | `bsk_inspect({action:"read", session, selector/ref, read_fields:[...], max_nodes, max_bytes, timeout_ms})` |

The result has tab/frame identity, page/frame URLs, title, capture time, `scope:
current_dom`, item refs/values/redactions and `truncated`. Machine errors retain
reason/phase/effect_state/recovery; query failures have `phase: read` and no effect.
New CLI/MCP require daemon protocol 1.9; the daemon checks extension protocol 1.9.
Unsupported peers fail before forwarding this method. Compatible older 1.x clients
retain existing action behavior; they cannot request a new method unknowingly.
There is no downgrade to evaluate, no whitelist and no implicit resync/replay.

`bsk plan` is not part of the 0.4.2 release. The plan client on main is
tested against this daemon: each action reaches the same extension guards;
a supplementary read never supplies a replacement context or weakens `expect`.
No plan implementation is copied into this fix.

For measured results and untested boundaries, see the
[validation record](dynamic-reading-validation.md).

## Reproduction

Build the extension with `BSK_DAEMON_WS_URL=ws://127.0.0.1:52923` and build the CLI,
then run `evals/browser/cases/regression/cooperation/dynamic-read.mjs`
with `BSK_TEST_CHROME` set to a Chromium executable (and optional `BSK_TEST_CLI`
defaulting to `target/debug/bsk`). It owns an isolated profile,
daemon and sessions. `BSK_DYNAMIC_OCEAN=1` adds real OceanEngine autoplay trials;
`BSK_DYNAMIC_PLAN_CLI` optionally selects another plan binary; by default the
runner exercises plan using the same CLI.
`BSK_DYNAMIC_ARTIFACTS` chooses the evidence directory. No shared daemon or user
profile is restarted. The standard cooperation suite separately covers native
human input, interruption, navigation and lifecycle behavior.
