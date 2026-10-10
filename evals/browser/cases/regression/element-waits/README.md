# Element wait browser comparison

This fixture compares caller-side `evaluate` + `wait-ms` polling with
`wait-for-element` through the actual CLI, daemon and built extension. Every run
owns its browser profile, local fixture server, Agent Window and private daemon.
Use a disposable test environment: the daemon retains its normal startup skill
synchronization. It never borrows an existing browser tab or stops a shared daemon.

Use Node 22 and a Chromium/Chrome for Testing executable supporting unpacked
extensions. From the repository root, build the CLI and extension from this branch:

```bash
cargo build -p bsk --locked
pnpm install --frozen-lockfile
BSK_DAEMON_WS_URL=ws://127.0.0.1:52907 pnpm ext:build
BSK_WAIT_CHROME=/path/to/chromium \
  node evals/browser/cases/regression/element-waits/run.mjs > /tmp/element-waits.json
```

Choose an unused port with `BSK_WAIT_PORT` and build the extension with the same
`BSK_DAEMON_WS_URL`. The script rejects a build using the normal daemon port.
`BSK_WAIT_CLI` and `BSK_WAIT_EXTENSION` override the built artifact paths;
`BSK_WAIT_REPEATS` defaults to 10 repetitions per method/state/tab condition.
The output contains all 80 trial rows plus grouped summaries. Processes, session,
profile and private daemon files are cleaned up on both success and failure.

The page's Start button adds a loading mask and, after a 350ms page timer, replaces
it with a visible result. Each method waits for either the result to be `visible`
or the mask to be `detached`, with a 3s timeout and 100ms polling interval. Method
order alternates per repetition. The script also verifies that an unsatisfied
100ms CLI wait returns normally with `satisfied: false` (exit code 0).

Measurements:

- `success`: the wait reports success and the fixture confirms the transition.
- `elapsed_ms`: caller wall time from the start of waiting through its result,
  including CLI startup/IPC and any caller-side sleeps.
- `trigger_wait_ms`: time from before the click command through the wait result;
  recorded separately because the click command consumes some of the fixture delay.
- `reported_elapsed_ms`: the extension's wait budget measurement, only for
  `wait-for-element`. It excludes process startup and IPC.
- `cli_calls`: actual CLI process invocations during the waiting stage, counting
  both `evaluate` and `wait-ms` for the caller loop. Setup, clicks, evidence reads,
  and cleanup are excluded equally. This is not a count of every internal IPC,
  WebSocket or CDP message.

Foreground/background means the target tab is selected/unselected, asserted
before and after every trial. The production extension deliberately keeps controlled
background pages runnable; therefore `document.visibilityState` may remain
`visible` and is recorded separately. This is the product's normal background
execution policy, not a measurement of native background timer throttling.
The separate `waits.browser.test.ts` regression also exercises the wait handler
against a truly hidden document without the dispatcher's visibility override. It
covers masks hidden in place or removed (the two Element UI loading lifecycles),
initial absence, and scoping a selector when another table's mask is already hidden:

```bash
BSK_CLICK_CHROME=/path/to/chromium pnpm --filter @browser-skill/extension \
  exec vitest run src/tools/__tests__/waits.browser.test.ts
```

The comparison measures deterministic browser orchestration, not Agent end-to-end
latency. No model, planning turn or new observation is timed. Agent speedup needs a
separate benchmark that includes those costs; do not infer it from fewer RPCs.

## Recorded run

2026-10-10, macOS arm64, Chrome for Testing 149.0.7827.55, Node 22.23.2,
headless, development CLI build. All 80 trials succeeded. Page-timer completion
was 350–583ms; each trial records its actual delay.

| Tab | State | Method | Success | Wait median / p95 (ms) | Mean trigger + wait (ms) | Mean CLI calls |
| --- | --- | --- | --- | --- | --- | --- |
| Foreground | visible | caller-poll | 10/10 | 274.1 / 333.8 | 420.5 | 5 |
| Foreground | visible | wait-for-element | 10/10 | 342.1 / 356.2 | 470.6 | 1 |
| Foreground | detached | caller-poll | 10/10 | 264.5 / 416.1 | 425.5 | 5 |
| Foreground | detached | wait-for-element | 10/10 | 335.4 / 347 | 460 | 1 |
| Background | visible | caller-poll | 10/10 | 268 / 380.7 | 414.5 | 5.2 |
| Background | visible | wait-for-element | 10/10 | 340.8 / 348.8 | 491.3 | 1 |
| Background | detached | caller-poll | 10/10 | 271.4 / 385.5 | 425.6 | 5.2 |
| Background | detached | wait-for-element | 10/10 | 339.7 / 353.6 | 501.4 | 1 |

The extension wait used fewer caller invocations but did not finish faster in
this short-delay sample. Poll scheduling, per-probe CDP work and time already
spent in the click command affect latency. These results do not establish Agent
speedup or a general latency advantage.
