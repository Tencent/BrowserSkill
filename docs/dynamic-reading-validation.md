# Dynamic DOM read validation — 2026-11-06

This record distinguishes the published 0.4.2 failure baseline from the protocol
1.9 development implementation. Tests used isolated browser profiles, daemons and
sessions; the regular browser extension and shared daemon were not replaced.
See [the query contract and safety boundaries](dynamic-reading.md).

## Published baseline and real-site comparison

Published CLI, daemon and extension: 0.4.2, protocol 1.8, target policy.
Website: https://www.oceanengine.com/ . Every trial started with a fresh sync.

| Condition | Observed result |
| --- | --- |
| Immediately evaluate the title and carousel state | 1/1 succeeded |
| Wait 5.5 seconds, confirm autoplay changed the active slide, then evaluate | 0/2 succeeded: permission_denied / observation_changed / observation / none |
| Development build: wait 5.5 seconds across autoplay, read, decide, click with expect, read the result | 3/3 completed; slide indices 0→1→3, 3→4→6, 6→7→0 |
| Reuse a pre-transition pagination ref | 3/3 refused before input: target_detached / target / none |

The development trials reused one target control context. Arbitrary evaluate still
refused its stale strict observation. No autoplay pause, site modification,
whitelist, sync/action retry loop or JavaScript fallback enabled these successes.

An additional Agent workflow ran across separate tool calls, with the Agent
reading the returned data before choosing its action. Two samples were 24.928
seconds apart: the active slide changed from index 0 to 5. The Agent chose the
observed “Go to slide 3” selector, protected its literal aria-label with expect,
and used the original context without another sync. The result was index 2;
a later read observed autoplay at index 0. This browser did not use the runner's
background timer throttling override.

Read-only MutationObserver instrumentation in an isolated world recorded removal
and reconstruction of the entire pagination set. All nine original nodes became
disconnected. CDP sometimes still resolves a detached node and sometimes has
already collected it; both cases now report target_detached. Other CDP errors
remain target_unavailable. The precise timing of the original reported selector
failure cannot be reconstructed from its historical record alone.

## Deterministic browser boundaries

The local fixture continuously updates text, carousel DOM/class/style, Canvas
paint, video poster attributes and an advertising iframe. CLI, MCP and DSH each
complete a delayed read → decision → input → result workflow. Regression checks
cover these observable boundaries:

- Native DOM reads remain correct when the main world overrides input.value,
  Element.getAttribute and Object.prototype.toJSON; immediate and deferred side
  effect counters remain zero. Expressions, callbacks and readonly flags are not
  accepted as read capabilities.
- Prices, reused record IDs and changed button meaning fail explicit conditions.
  A mouseover price change after the initial check is caught before the press;
  preparation's possible effects retain an unknown outcome, without replay.
- Removed/replaced targets, disabled/hidden targets, occlusion, stale contexts,
  main SPA away-and-back routes, iframe replacement and sensitive values retain
  their identity, readiness, authority and redaction checks.
- Same-origin, cross-origin and nested iframe refs and shadow refs are read in
  their own document/session. Failed child documents do not block a main read;
  failed main documents still block cooperation.
- A supplementary read does not renew strict evidence. A two-step plan stops
  when its first step changes a fact required by its second step. No later step
  or uncertain input is replayed.

Read collection does not invoke caller code or await page promises. Node/field/
byte limits and current attachment/document checks constrain results. Native
browser queries cannot be preempted inside a single DOM call; renderer/transport
cancellation remains the outer deadline.

## Automated checks

The original completed full checks on the 0.4.2-based implementation were:

- Rust workspace: 1036 passed, 1 ignored; formatting and clippy passed.
- Extension: 3731 passed, 425 conditional skips; TypeScript passed.
- DSH: 714 passed, 10 conditional skips; TypeScript passed.
- VOM: 160 passed; opt-in native Chrome live-text/extraction tests: 46 passed.
- Eval harness: 12 cases / 21 routes validated, 46 tests passed.
- Full headful cooperation suite: passed, including native human intervention,
  editing versus scrolling/focus, navigation invalidation, stop/closure,
  deferred scripts, file operations and uncertain outcomes.
- Latest failed-frame read scenarios: passed under target and strict policies.

The first complete headless cooperation run timed out waiting for the fixture's
resize text after mobile emulation: matchMedia already reported a narrow screen
while its resize-event-updated text still said wide. This failure was retained.
The isolated headless compatibility subset subsequently passed for both the
published baseline and the development build; the full headful suite also passed.
This does not establish that all headless resize scheduling issues are resolved.

After integrating main at 9d40afa7 (including plan), PR preparation reran:

- Rust workspace: 1052 passed, 1 ignored; clippy and formatting passed.
- Extension: 3731 passed, 425 conditional skips; TypeScript passed.
- Repository Biome, canonical skill/package and bilingual changelog checks passed.
- The delayed CLI/MCP/DSH browser workflow and the same CLI's plan passed again.
  OceanEngine crossed autoplay in all three trials and completed each selected
  pagination action; all three old pagination refs were refused before input.

Raw local captures include website traffic and are not published with the source;
the regression runner emits command arguments, results and errors for reproduction.

## Reproduce

Build the CLI and DSH plugin, then build the extension with
BSK_DAEMON_WS_URL=ws://127.0.0.1:52923. Set BSK_COOP_CHROME to a Chromium executable
and run `pnpm eval:browser:dynamic-read`. BSK_DYNAMIC_OCEAN=1 includes the real site;
BSK_DYNAMIC_ARTIFACTS chooses a new evidence directory. The runner owns cleanup
and tests the same CLI's plan by default; BSK_DYNAMIC_PLAN_CLI can override it.
The standard cooperation runner separately exercises native human/lifecycle cases.

## Limits

This is DOM sampling, not arbitrary safe JavaScript execution or a server-side
transaction. Conditions protect declared facts, not inferred business meaning or
an uninterrupted value history. Iframe input guards remain conservative when
collected frame documents change. Canvas pixel semantics and actual video decoding
were not validated end to end; poster/DOM changes are distinct from video playback.
There is no claim that every dynamic website is covered.
