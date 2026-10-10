# Known action batches

Use `browser_interact(action="batch")` when the latest observation and task already
determine several DOM interactions. Independent fields with known values are a
good fit. End a batch before a step that depends on new content or a new decision.

```text
browser_interact({
  action: "batch",
  session: "<id>",
  observationId: "<from observe or snapshot>",
  requestId: "form-1",
  steps: [
    { action: "fill", target: "@e1", value: "Example company" },
    { action: "fill", target: "@e2", value: "Alice" },
    { action: "select", target: "@e3", values: ["software"] },
    { action: "click", target: "@e4" }
  ]
})
```

Use actual refs and task inputs. Batches run sequentially on one tab, stop at the
first failure, and normally include one final observation. They accept 1–20 steps
and at most 64 KiB of input, with a 30s default total budget (`timeoutMs`, maximum
120000). Actions: `fill`, `select`, `click`, `press`, `focus`, `blur`, `hover`,
`scroll-to`. Step parameters retain the single-action names, including `noClear`,
`clickCount`, `modifiers`, and `holdMs` (maximum 5000). Targets must be observed DOM
refs; selectors and Canvas use existing single actions.

`completed` describes action execution, not business success. Check the final
`observation`. It is an immediate read, not a wait for application readiness.
If only `observation_error` is present, observe again instead of repeating actions.

On `stopped`, retain the completed steps, examine the failure and final page, and
finish with existing single actions using fresh refs. `not_run` steps were not
dispatched. A `failed` step with `effect_state: unknown` may already have changed
the page. Do not replay the whole batch or blindly resume at an index. After one
batch failure on a page, prefer single actions for recovery. User cancellation
requires stopping until the user resumes.

For an unconfirmed response, read the receipt before recovery:

```text
browser_interact({ action: "batch-status", session: "<id>", requestId: "form-1" })
```

Status reads never resume execution and remain available while the batch runs.
Do not start recovery actions while the receipt is `running`. Reusing an existing
request id returns the same receipt without replaying input. If the receipt is
unavailable, inspect the page and any submission result before further actions.
Cached receipt observations may be stale; observe again before recovering from one.
Receipts are session-scoped memory, not recordings; 64 are retained per session.

If the observation has no `observationId`, the connected components are older, or
batching is rejected, complete the task with existing single actions. Do not keep
retrying the optimization or change backends to finish the task.
