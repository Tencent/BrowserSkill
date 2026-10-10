# DSH element waits: real-model validation

This comparison measures the existing DSH path on main against the optional
`browser_page(action="wait-for-element")` action. Both arms use the same CLI,
daemon and extension containing #407; the candidate only changes the DSH adapter
and its instructions. Waiting remains optional and existing single actions remain
available after a timeout or unsupported command.

**Status:** functional and recovery checks passed. End-to-end latency
non-regression is not established, so this remains a draft for review.

## Method for the original comparison

- Baseline: main `5590e48cd6442a74aeb19d4e8658d5502dfa55b0`.
- Measured candidate runtime: `fdab6be073f2d4544a394de58a942a653a20d2e6`.
- DSH 0.2.0-rc.2 with the locally configured `deepseek-official / deepseek-flash`,
  `reasoningEffort: high`, `maxTokens: 256000`. The token cap is not actual usage.
- macOS arm64, Node 26.6.0, Chrome for Testing 149.0.7827.55, real release CLI,
  daemon and MV3 extension. The experiment owns an isolated browser profile and
  daemon. Browser startup/build time is outside each task; session start/stop is
  inside it. This is the headless DSH agent loop, not Web UI rendering latency.
- Three workloads, ten trials per arm per workload. Main/candidate order alternates
  each round. Conversations, workspaces and browser sessions are fresh; the shared
  browser/daemon and provider caching remain enabled.
- Identical ordinary prompts between arms apart from opaque run IDs. The model
  discovers refs and chooses its actions. No forced wait, fixed tool plan, replayed
  response, simulated inference delay or assumption that one tool call equals one
  model request is used in the performance trials.
- Session-title generation, unrelated filesystem skill discovery and the observation
  UI are disabled equally. The built-in skill remains lazy-loaded. The configured
  model credentials are reused without copying them into the experiment.

`static` submits the existing corpus form and verifies all three values. `results`
waits for a hidden confirmation button to appear after processing. `enabled` starts
with that button visible but disabled, so visibility alone cannot prove readiness.
The two dynamic workloads cycle through application delays of 6000, 1500 and
10000 ms, identically within each pair. These are fixture work durations, not model
latency. No selectors or refs are supplied in the ordinary task prompt.

A pass requires the server to record exactly one start and one ready confirmation
(or exactly one correct form submission), a browser tool result showing the
correct final page, a correct final answer, and the model stopping its session.
The runner also cleans owned sessions after each task. Model success claims alone
cannot pass the test. Completed slow/error samples are retained.

Task time is DSH `turn_start` through its final answer; process time additionally
includes DSH launch/shutdown. Actual model HTTP requests are passively counted
through Node diagnostics and cross-checked against persisted DSH assistant
attempts. HTTP time includes provider/network/inference time through response
stream close. DSH normally aborts a completed SSE stream; that close is not itself
an inference failure. Tool time is the union of tool-call/result intervals, so
concurrent calls are not double-counted. These clocks need not sum exactly.

## Original comparison

| Workload | Passes, main / candidate | Median seconds | Mean seconds | p95 seconds | Mean actual model requests | Candidate faster in paired trials |
| --- | --- | --- | --- | --- | --- | --- |
| static | 10/10 / 10/10 | 10.29 → 11.04 | 10.58 → 10.84 | 12.15 → 11.74 | 9.4 → 9.3 | 5/10 |
| results | 10/10 / 10/10 | 21.05 → 19.70 | 20.99 → 19.30 | 31.41 → 24.04 | 14.2 → 13.9 | 7/10 |
| enabled | 10/10 / 10/10 | 22.88 → 26.15 | 29.45 → 24.50 | 64.55 → 31.76 | 13.8 → 13.3 | 8/10 |

All 60 tasks passed. The 739 actual model HTTP requests matched persisted assistant
attempts, with HTTP 200 responses. Static candidate tasks made no element waits and
had no tool errors. Dynamic candidate tasks used the wait in 19/20 trials; all
19 waits matched their conditions. One candidate results trial made an unsuccessful
local web-fetch request and recovered. One main enabled trial had a screenshot
error. Both samples remain in the table.

The results are mixed, not a general speed guarantee. Static mean time increased
by 0.26 seconds and median by 0.76 seconds; five pairs were faster and five slower.
For results, the median paired saving was 1.13 seconds. For enabled, eight pairs
were faster (median paired saving 0.88 seconds), but the aggregate candidate median
was 3.27 seconds slower. Pairwise differences and differences between group medians
are different statistics. Small samples, mixed fixture delays and shared browser
state prevent claiming latency non-inferiority.

The enabled comparison also includes a timing change in ordinary clicks: starting
with round 4's candidate, both arms' subsequent clicks took about 5.17 seconds
rather than 0.17 seconds. Main's slowest sample included a 30-second screenshot
call. These are recorded observations, not proof of an underlying cause. No time
is subtracted and no sample is excluded; the mean/tail improvement should not be
attributed entirely to the new wait action.

Per-trial data: [60 performance trials](data/dsh-element-waits-final.csv),
[9 recovery trials](data/dsh-element-waits-recovery.csv),
[15 initial trials](data/dsh-element-waits-initial.csv).
[Run metadata and recovery evidence](data/dsh-element-waits-evidence.json) retain
binary hashes, model configuration and post-failure action sequences.

## Recovery

| Condition | Passed | Observed recovery |
| --- | --- | --- |
| 100 ms timeout | 3/3 | Received satisfied=false, observed the page, waited longer, then completed |
| CLI lacks wait-for-element | 3/3 | One rejected wait, then existing tools completed the task |
| Ref invalidated by navigation | 3/3 | Surfaced the stale-node/ref error, observed fresh refs, then completed |

Every recovery task started processing once, confirmed a ready result once and
closed its session. Eight of nine observed before the first post-failure click.
One unsupported-command trial clicked ineffectively first, then observed and
completed; this is retained rather than counted as perfect instruction following.
Fallback is model-directed, not an automatic retry or replay of a triggering action.

Recovery prompts explicitly request the condition being tested and are excluded
from performance comparisons. Timeout tests use a 100 ms first wait against a
16000 ms operation. Unsupported-command tests place a shim in front of the real
CLI that rejects only `wait-for-element`; this tests compatibility recovery, not
an installation of every historic release. Stale-ref tests navigate to a new
document during a wait on the observed loading indicator. All other browser
operations and model responses are real.

## Compatibility after updating main

Main advanced to `63c16570ae4d6be54df386098ed14119cc3115b8` during the experiment,
adding video support and changing the DSH tool/skill entry. After merging it,
candidate `32cd37f4e5bb659c7885663bd538ef8a47a2cfc4` was rebuilt and compared
against that main revision, using the same newly rebuilt CLI/extension in both arms.
The entry guidance was shortened to retain the existing 4500-byte budget.

This independent follow-up has three trials per arm/workload and uses the same
method and delay sequence. It is a compatibility check, not a replacement for the
original cohort or a pooled performance estimate.

| Workload | Passes, main / candidate | Median seconds | Mean seconds | Total actual model requests |
| --- | --- | --- | --- | --- |
| static | 3/3 / 3/3 | 10.00 → 11.86 | 10.27 → 11.92 | 27 → 28 |
| results | 3/3 / 3/3 | 17.54 → 15.77 | 18.28 → 17.55 | 38 → 40 |
| enabled | 3/3 / 3/3 | 28.73 → 20.17 | 25.03 → 18.90 | 42 → 40 |

All 18 tasks passed, with no tool errors and 215 verified model HTTP requests.
The candidate used six successful waits across its six dynamic tasks and none
in its three static tasks. Static mean time nevertheless increased by 1.64 seconds.
That observed slowdown cannot be dismissed as noise or attributed to a specific
component from this sample. Functional compatibility passed; absence of an
end-to-end latency regression has not been established.

The same three recovery conditions were each exercised three more times on the
merged branch: 9/9 tasks passed, with 124 verified model requests. All nine
observed before their next click, started processing once, confirmed once and
stopped their sessions. The first timeout returned satisfied=false in every
timeout trial; all unsupported/stale trials surfaced their intended errors.

Data: [18 current-main trials](data/dsh-element-waits-latest.csv),
[9 current-main recovery trials](data/dsh-element-waits-latest-recovery.csv).

## Build and regression checks

The merged branch passed repository lint (including type checking), 494 DSH tests,
15 evaluation-framework tests and evaluation corpus validation. The release CLI
build passed. The real-browser run passed all nine cases and all three matrix
seeds (4, 7, 14), with 100% fully verified outcomes and no execution errors.
The npm package check confirmed all seven skill resources resolve outside the
repository. These checks exercise the actual packaged plugin and browser path;
Web UI rendering latency was not measured.

## Scope and early findings

An initial candidate run (`f1c388d7`) was stopped after 15 completed static tasks:
all completed, but three of its eight candidate tasks tried unsupported `text=...`
locators, adding an error and an extra model round trip. The final instructions
explicitly limit selectors to CSS and require observation after the triggering
action, skipping waits on an already-ready page. The initial completed samples
are retained separately; they are not pooled with the changed candidate.

A single model and three synthetic workloads cannot establish a universal latency
or reliability guarantee. Each arm/workload has only ten samples, so nearest-rank
p95 is its slowest sample. Adoption, end-to-end time, error recovery and correctness
must be considered together. This PR exposes an existing browser capability; it
does not replace the model or add browser-side execution machinery.

## Reproduce

Build both plugin versions with the repository's locked dependencies. Keep the
main plugin and skill resources in a separate checkout of the pinned baseline.
From the candidate checkout:

```sh
pnpm install --frozen-lockfile
cargo build --release -p bsk --locked
pnpm --filter @wxg-prc-cpg/browser-skill-dsh-plugin build
node evals/browser/benchmarks/dsh-element-waits.mjs \
  --chrome "$BSK_TEST_CHROME" \
  --baseline "$BASELINE_ROOT/packages/dsh-plugin-browserskill/lib/index.mjs" \
  --out /tmp/bsk-element-waits-measured-new --samples 10
```

The runner requires a working local `dsh headless` profile and `zstd`; `--profile`
selects another existing profile. `--cli` optionally selects another release CLI.
The output directory must be empty. It writes full local events, prompts, HTTP
timing, compressed sessions, server oracles, results and binary hashes. It never
installs a global plugin or changes the user's model settings. Raw transcripts
remain local; the public evidence contains sanitized timings and recovery actions.

For recovery, use a different empty output directory and add
`--modes candidate --cases timeout,unsupported,stale --samples 3`. `--smoke` also
runs all browser cases and matrix seeds 4, 7 and 14 before the model tasks.
