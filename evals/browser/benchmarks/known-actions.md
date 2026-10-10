# Known-action batching: measurements and design decision

Measured on 2026-10-10, macOS arm64, Node 26.6.0 and Google Chrome for Testing
149.0.7827.55, using a release CLI, a separate daemon/home directory and a fresh
browser profile with the real MV3 extension. Only local synthetic data was used.

## Method and boundaries

The `/form` corpus fixture supplies four already-observed controls: fill a text
input, fill a textarea, select an option and click Submit. Timing starts with a
fresh observation already available and ends when the final observation contains
the expected result. The server must receive **exactly one** submission containing
all three expected values. Session creation, navigation and initial observation
are setup and excluded equally. CLI startup, IPC, extension/browser work, final
observation and any extra observation are included. The original native variant
also includes writing and removing its private plan file.

Each variant gets one discarded warmup and 20 measured trials. Order rotates each
round. Median averages the two middle samples; p95 uses nearest rank. Audit is
disabled during timing and verified separately. The initial comparison uses PR
head `2721a20a`, based on `ee13a46e`; the revised comparison uses runtime commit `63b907d9`, after merging main
`5590e48c` (#407). Only documentation was edited during that final run. [Original samples](data/known-actions-before.csv) and
[revised samples](data/known-actions-after.csv) include every measured trial.

These are **local execution timings, not an agent/LLM latency experiment**. Tool
call counts below describe the required public calls for this known plan. They do
not include model thinking, provider latency or transport overhead. No artificial
model delay was added. More websites, platforms, remote-daemon links and live-agent trials are needed
before claiming an end-to-end latency improvement.

## R1: three-way comparison of the original implementation

| Path | Public calls | CLI processes | Median | p95 | Correct submissions |
| --- | ---: | ---: | ---: | ---: | ---: |
| Separate single actions + observe | 5 | 5 | 279.2 ms | 296.4 ms | 20/20 |
| One shell call with `&&` + observe | 1 | 5 | 288.7 ms | 302.8 ms | 20/20 |
| Native batch, including final observe | 1 | 1 | 259.7 ms | 270.2 ms | 20/20 |

Native batching saved **29.1 ms (10.1%)** against the shell chain on this fixture.
That absolute saving does not justify an additional extension executor, protocol
methods and receipt subsystem. CLI chaining already provides the public-call
reduction. The native row assumes plan creation and invocation occur in the same
tool call; a separate file-writing tool would add a call. All 60 final observations
were ready without another observe, which is a property of this fast local fixture,
not a general readiness guarantee.

## R2: final layering and the two user paths

- **CLI:** document an existing `&&` chain using an explicit session and observed
  tab. It stops on failure. No new command, protocol, plan file or speed claim.
- **DSH:** add `browser_interact(action="batch", tabId, steps)` that holds the
  existing plugin session queue and invokes the existing single-action runtime.
  The four actions and final observation take one public tool call instead of
  five. This captures the harness benefit without an extension-side executor.

| Revised path | Public calls | CLI processes | Median | p95 | Correct submissions |
| --- | ---: | ---: | ---: | ---: | ---: |
| Separate single actions + observe | 5 | 5 | 284.3 ms | 381.9 ms | 20/20 |
| One shell `&&` chain + observe | 1 | 5 | 294.8 ms | 535.5 ms | 20/20 |
| DSH batch through existing commands | 1 | 5 | 281.5 ms | 400.1 ms | 20/20 |

The final run shows substantial tail variation; no outliers were discarded and
no p95 improvement is claimed. The two tables were separate runs on different
main revisions, not a controlled before/after speedup experiment.

The harness loop has roughly the same local median execution cost as single commands;
its benefit is removing four opportunities for agent/tool round trips. Plans that
need intermediate observations or decisions must still use individual calls. It does
not make individual browser actions faster. This also works with older backends
that already implement the individual actions.

A batch pins an observed tab, accepts 1..20 DOM-ref steps (64 KiB maximum), and
validates its structure before dispatch. Existing single-action handlers remain
the authority for page validation. The plugin prevents its own observations and
other commands from interleaving; this is **not a transaction or a cross-client
lock**. Do not use the same session concurrently from another client. End a plan
before navigation or a new decision. The successful final observation is an
immediate read, not a condition wait; use the existing observe/wait tools if the
result is still loading. In all failure cases the agent can observe afresh and
continue with the original single actions.

## R3–R5: simpler failure handling, intact audit, bounded impact

- Removed native `tool.batch`, `tool.batch_status`, request IDs, receipt caching,
  the 64-receipt limit and the special daemon queue bypass. Results are synchronous:
  completed / failed / not_run, with effect_state. The first failed action stops
  the sequence, including the final read. Unknown effects require observation,
  never automatic replay. Cancellation must settle before releasing the queue.
- Every dispatched step uses the original daemon audit path. It records the
  action, ref, cached element name and outcome with the existing localized UI and
  redaction. There is no aggregate method to translate or duck-type. Unstarted
  steps are reported to the caller, not invented as audit operations.
- Removed observation IDs from the protocol, JSON and human-readable results.
  Ref-store generations remain internal; no new stability contract is introduced.
  Restored the original general skill guidance. Each entry only adds a batching trigger
  to its existing interaction-details routing row; detailed instructions are lazy.
- The DSH schema adds only `steps` and one action value. Serializing each public
  tool's `{name, description, parameters}` with `JSON.stringify` gives **15,581 →
  16,496 UTF-8 bytes** across six tools (+915, **5.9%**); browser_interact is 2,509 →
  3,424 bytes. These are bytes, not tokenizer estimates. The extra typed schema is
  accepted to retain discoverability and normal argument validation; a test bounds
  the steps schema below 900 bytes. No additional public tool or default browser CI
  job is added. Single-action parameters and observation rendering are unchanged.

## Recovery and validation

A real browser test removes the dropdown after the second fill. The next select
fails; the final click is not sent and the server sees no submission. After a new
observation and restoration of the synthetic control, single select/click commands
complete the task. Both filled values remain and the server records one submission.
The audit API returns two fills, the failed select, the recovery select and click,
with refs, names and statuses; the synthetic private input is absent from the audit.
The audit page renders every target name using its existing localized action labels.

Unit coverage exercises pre-dispatch validation, session queuing, partial
results, uncertain effects, cancellation, total-budget settlement, CLI argument
mapping and single-action recovery. Existing DSH tests and type checking pass.
The real browser run also passes all six `core` cases and generated-form seeds
4, 7 and 14. Skill bundle and package checks are included in validation.

## Reproduce

Install workspace dependencies with the lockfile and provide a Chrome for Testing
binary that supports loading unpacked extensions. From the repository root:

```sh
cargo build --release -p bsk
BSK_BATCH_CHROME="$BSK_TEST_CHROME" \
BSK_BATCH_CLI="$PWD/target/release/bsk" \
BSK_BATCH_SAMPLES=20 BSK_BATCH_SMOKE=1 \
BSK_BATCH_OUT=/tmp/known-actions-after.json \
pnpm --filter @wxg-prc-cpg/browser-skill-dsh-plugin exec vitest run \
  tests/batch.browser.test.ts --reporter verbose
```

The opt-in test creates its own daemon, browser profile and sessions and cleans
those resources on exit. Omit BSK_BATCH_SMOKE to skip the additional corpus runs.
Without BSK_BATCH_CHROME the browser test is skipped in ordinary unit-test runs.

To reproduce the historical native comparison, prepare a separate checkout at
`2721a20a`, install its dependencies and build its release CLI. Run the current
benchmark script pointing at that checkout (no source modifications needed):

```sh
node evals/browser/benchmarks/known-actions.mjs \
  --root /tmp/bsk-native-413 --bsk /tmp/bsk-native-413/target/release/bsk \
  --chrome "$BSK_TEST_CHROME" --samples 20 --out /tmp/known-actions-before.json
```

Both runners write JSON metadata, summaries and raw rows. The checked-in CSVs are
those rows, without rounding or dropped samples. Readiness retries increase both
duration and reported call counts. A failed command or oracle fails the run rather
than being silently excluded from statistics.
