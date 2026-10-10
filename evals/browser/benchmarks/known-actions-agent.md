# Known actions with a real DSH model

This experiment measures a real model driving the real browser through DSH. It is
separate from the [local execution benchmark](known-actions.md), which made **zero
LLM requests**. Five public tool calls do not necessarily mean five model requests:
a model can return several calls in one response.

## Results

All **30/30** scheduled tasks submitted the correct values exactly once, confirmed
the visible result, and stopped their browser session. Every HTTP request count
matches the persisted DSH assistant-attempt count. [All samples](data/known-actions-agent.csv)
and [per-request and per-tool timing evidence](data/known-actions-agent.json) are included.

| DSH path | Task median | Task mean | Task p95 | Actual model requests, 10 tasks | Batch adoption |
| --- | ---: | ---: | ---: | ---: | ---: |
| Main, ordinary prompt | 10.93 s | 10.53 s | 11.44 s | 92 | unavailable |
| PR, ordinary prompt | 9.76 s | 9.63 s | 11.57 s | 79 | 10/10 |
| PR, batch requested | 8.97 s | 11.91 s | 38.50 s | 67 | 10/10 |

The ordinary-prompt median improves by **1.16 s (10.7%)**; explicitly requesting
batch improves the median by **1.96 s (17.9%)**. Against the same-round main trial,
ordinary-prompt PR is faster in 7/10 pairs and requested batch in 8/10 pairs.
This is a modest end-to-end improvement in a small, single-task experiment, not
evidence that every task becomes faster.

One requested-batch trial chose `browser_page(navigate, waitUntil="networkidle")`.
Navigation waited **30.031 s**, returning `reached: timeout`, before the first
observation or batch. The later batch took **295 ms** and succeeded. The complete
task took **38.500 s**. This sample remains in every aggregate: requested batch's
**mean is worse than main and its p95 is worse**. With ten observations per arm,
nearest-rank p95 is the maximum sample; no tail-latency improvement is established.

| DSH path | Model HTTP time, median | Tool time, median | Model requests per task, median | Action phase, median | Model requests in action phase, median |
| --- | ---: | ---: | ---: | ---: | ---: |
| Main | 8.67 s | 1.88 s | 9 | 3.433 s | 3 |
| PR, ordinary prompt | 7.52 s | 1.86 s | 7.5 | 2.640 s | 2 |
| PR, batch requested | 7.03 s | 1.86 s | 7 | 1.811 s | 1 |

The **action phase** runs from the initial form observation's durable tool-result
timestamp to the first tool result containing the correct visible submission.
It is a diagnostic slice of the same runs, not a separately optimized task. Its
median decreases **23.1%** with the ordinary prompt and **47.2%** when batch is
requested. The full task retains all setup, cleanup, and final-answer costs.
An even-sized sample's median request count can be fractional; no individual
request count is fractional.

The model sometimes emits multiple single-action calls in one response. Thus the
baseline action phase actually took a median **3 model requests**, not five.
Ordinary-prompt PR used batch in all ten trials, but only five included Submit:
the other five batched the three form-field actions and then clicked and observed
separately. All ten requested-batch trials included Submit last. This distinction
explains why availability alone does not realize the entire potential reduction.

These results support the DSH orchestration layer's benefit for already-known
actions. They do not establish additional value for a native protocol/extension
batch executor: both can reduce model round trips. CLI agents already have a
single-shell-call `&&` path; this experiment does not measure a real-model CLI
comparison or claim an additional CLI speedup.

Model/provider variation, caching, other websites, long tasks, remote daemons,
and Web UI overhead remain outside the conclusion. Default-prompt performance
and recovery should continue to be measured rather than assumed from tool counts.

## Real-model recovery

Three additional fault-injection tasks all passed. The fixture replaced its
dropdown node after the second fill, making the batch's select ref stale. Each
batch returned `completed, completed, failed, not_run`; the failed select's effect
was `unknown`, so the model inspected the current page before continuing. In all
three runs, it used **single select and click actions**, retained both filled
values, did not replay either fill, confirmed the result, and stopped the session.
Each server run recorded exactly one correct submission. [Recovery timing and
action evidence](data/known-actions-agent-recovery.json) is separate from the 30
performance trials. This validates recovery in this controlled DOM-change case,
not every possible model error, cancellation, or transport failure.

## Environment and task

The experiment uses DSH 0.2.0-rc.2 headless with the locally configured
`deepseek-official / deepseek-flash`, `reasoningEffort: high`, `maxTokens: 256000`.
The provider reports usage, including cache reads; provider caching remains enabled.
No artificial model delay, fixed action plan, replayed response, or tool-call
count inferred from a prompt is used.

The release CLI and freshly built MV3 extension run with an isolated daemon and
Chrome for Testing 149.0.7827.55 on macOS arm64. DSH uses the same existing local
credentials in all arms. The isolated browser profile and browser process are shared
within the experiment; browser sessions, conversation history, and working
directories are new for each task. No personal browser tabs or website accounts are involved.

All tasks ask the model, in Chinese, to open the corpus `/form` page, fill Text
input with `benchmark`, fill Textarea with `known actions`, choose Two (the prompt
provides its value `two`), click Submit, verify `Received!` and all values, close
the browser session, and give a short final answer. The model receives the URL
with an opaque random run ID; it must discover all DOM refs itself. The server
must receive exactly one correct submission, and the model's tool results must
contain the correct visible result. A claimed success alone cannot pass.

## Comparison and timing

Three arms run ten times each, in rotating order, with fresh DSH conversations:

- **Main:** DSH plugin built from `5590e48c`, without batch. No instruction forces
  one tool call per model response or unnecessary intermediate observations.
- **PR, ordinary prompt:** plugin runtime `e68ffeec`; exactly the same task text
  as main, apart from the opaque fixture URL. The model decides whether to batch.
- **PR, batch requested:** same runtime and task, with one additional sentence
  asking it to batch already-observed actions that need no intermediate decision,
  and to recover with single actions if batching fails. This arm measures use of
  the capability, not its default adoption rate.

The runtime revision includes a fix found during pilot testing: DSH's text
renderer discarded the existing `tabId`, although batch requires it. The model
made an extra tabs-list call, or first tried an invalid tab ID. The renderer now
includes `tabId` in observe/snapshot output. No CLI, daemon, extension, generation,
or observation-ID contract changes are involved.

DSH's skill remains lazy-loaded. Session-title model generation and unrelated
filesystem skill discovery are disabled equally; the built-in browser skill,
ordinary model loop, tool validation, and cancellation paths remain intact.
The headless plugin's observation UI is disabled equally. Pilot and instrumentation
validation runs precede the measured set and are not included. Every scheduled
measured run is retained; no latency outliers are removed.

- **Task time:** DSH `turn_start` to receipt of its final answer. Includes model
  planning, skill loading, session start, navigation, observation, actions,
  verification, session stop, and final answer generation.
- **Process time:** launch of `dsh` through process exit, additionally including
  startup and shutdown. Neither time includes building the extension or starting
  the shared isolated browser/daemon. Web UI delivery and rendering are unmeasured.
- **Model requests and time:** passive Node HTTP diagnostics count actual model
  POST requests and time each from request creation until its response stream
  closes. Headers and bodies are never inspected. DSH closes a successfully
  completed SSE stream with an AbortError, so this transport close is not itself
  a failed inference; HTTP status and completed DSH attempts are cross-checked.
  Network, provider queueing, and inference are included, not separately inferred.
- **Tool time:** the union of intervals between DSH JSON `tool_call` and
  `tool_result` events, timestamped on receipt. Overlapping intervals count once.
  It includes plugin/CLI/browser work and any tool queueing. Per-call durations
  are retained as well. Rounding, serialization, prompt preparation, and lifecycle
  overhead mean model and tool times need not sum exactly to task time.

Only synthetic task data goes to the configured model. Public evidence contains
timings, usage, and action names; full local transcripts and persisted sessions
are not checked in.

## Reproduce

Build the main plugin separately, keeping the PR runtime fixed:

```sh
# From the repository root; choose a new empty baseline directory.
mkdir -p "$BASELINE_ROOT"
git archive 5590e48cd6442a74aeb19d4e8658d5502dfa55b0 | tar -x -C "$BASELINE_ROOT"
ln -s "$PWD/node_modules" "$BASELINE_ROOT/node_modules"
ln -s "$PWD/packages/dsh-plugin-browserskill/node_modules" \
  "$BASELINE_ROOT/packages/dsh-plugin-browserskill/node_modules"
(cd "$BASELINE_ROOT/packages/dsh-plugin-browserskill" && \
  node scripts/build-client-css.mjs && node scripts/build-skill-content.mjs && \
  node_modules/.bin/tsdown)

cargo build --release -p bsk
pnpm --filter @wxg-prc-cpg/browser-skill-dsh-plugin build
node evals/browser/benchmarks/known-actions-agent.mjs \
  --chrome "$BSK_TEST_CHROME" \
  --baseline "$BASELINE_ROOT/packages/dsh-plugin-browserskill/lib/index.mjs" \
  --out /tmp/bsk-model-measured-new --samples 10
```

The runner requires the local `dsh headless` profile with a working model, `zstd`,
and installed repository dependencies. It uses that profile's model settings and
credentials rather than copying secrets. `--out` must be empty. The runner writes
the prompt, timestamped DSH events, HTTP timing, compressed session log, results,
and binary hashes locally. It stops owned browser sessions after every task and
removes its temporary browser/daemon state. It does not install a global plugin
or change the user's default model.

To test recovery separately, use an empty output directory with
`--modes batch --samples 3 --recovery`. This replaces the dropdown DOM node once
after input to the textarea, invalidating its observed ref mid-plan. The two
filled fields remain intact, and a new observation can find the replacement.
The model is not told which control changes. Successful recovery requires one
correct submission; inspect the recorded partial batch results and subsequent
single actions to verify that completed steps were not replayed. These deliberate
fault runs are not latency samples.
