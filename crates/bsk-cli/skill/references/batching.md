# Known action batches

Use a batch when the current observation and task already determine the targets,
values and order of several actions. Examples include filling independent form
fields, selecting a known option value, and clicking an authorized submit button.
End the batch where a new observation or decision is needed: selecting a country
before discovering its region options requires two separate decisions.

Single actions remain the general fallback. Prefer them when the page changes
between steps, the latest observation has no `observation_id`, or one batch has
already failed on the current page. Do not repeatedly retry batching to finish a task.

## Submit a plan

Read the page with `bsk observe --session <id> --json` (or `snapshot`). Copy its
`observation_id` and DOM refs into a JSON file, using actual task inputs:

```json
{
  "observation_id": "<returned observation_id>",
  "steps": [
    { "action": "fill", "target": "@e1", "value": "Example company" },
    { "action": "fill", "target": "@e2", "value": "Alice" },
    { "action": "select", "target": "@e3", "values": ["software"] },
    { "action": "click", "target": "@e4" }
  ]
}
```

```sh
bsk batch --file plan.json --session <id> --request-id form-1 --json
```

The batch executes sequentially, on one tab, under one session command. Other
commands cannot interleave. Inputs use the existing action implementation,
including normal input checks, popup ownership and cancellation. Parameters and
all ref mappings are checked before input; each target is checked again before its
step. Unexpected navigation, ref replacement, tab changes or action errors stop
the remaining steps. The page itself can still change while a batch runs.

Supported actions are `fill`, `select`, `click`, `press`, `focus`, `blur`, `hover`
and `scroll_to`. Every step requires an observed DOM `target`. For selectors,
Canvas, file transfers, navigation or session/tab management, use the existing
single commands. Batches contain 1–20 steps and at most 64 KiB of input. The total
budget is 30s by default; `--timeout` accepts at most 120s.

Optional action parameters mirror the single-action wire format:

- `fill`: `clear_before` (defaults to clearing).
- `click`: `button`, `click_count` (1–3), `modifiers`.
- `press`: `key`, `modifiers`, `hold_ms` (0–5000).
- `select`: `values` are option values, not display labels.

## Inspect the result and recover

`status: completed` means all actions returned successfully, not that the business
task succeeded. Check `observation`, which contains one bounded final observation
and fresh refs. It is an immediate observation, not a wait for application readiness.
If `observation_error` is present, the actions may already be complete: observe
again instead of repeating them.

A failed execution exits nonzero. In JSON mode, `data.batch` retains the receipt,
including the final observation when available. Read each step's `status`:

| Status | Meaning |
| --- | --- |
| `completed` | The action returned; do not repeat it merely because a later step failed. |
| `failed` | Inspect its error and `effect_state`; an input may already have been sent. |
| `not_run` | This step was not dispatched. |
| `running` | Execution has not settled. Query status before issuing recovery actions. |

`effect_state: unknown` never means safe to retry. Prior actions are not rolled
back. Inspect the current page and complete the remaining work with single actions
and fresh refs; page changes can also alter values entered by successful steps.
If the user cancelled, stop until they resume the task.

For a connection loss or an interrupted command, query the receipt first:

```sh
bsk batch-status --session <id> --request-id form-1 --json
```

The request id is also printed to stderr before dispatch when automatically
generated. Reusing an existing id retrieves its receipt and never re-executes that
batch; an id cannot be reused for a different plan. Status reads work while the
session is busy and after a user interrupt. Wait for execution to settle before
recovery. A missing receipt means the outcome is unconfirmed: inspect the page,
especially any submission result, before acting again.
Receipt observations describe the page at completion and may now be stale. Take
a fresh observation before recovering from a queried or repeated receipt.

Receipts are in memory for the session lifetime, separate from optional operation
history. Up to 64 batches are retained per session; reaching this limit rejects new
batches before input and leaves all single commands available. Closing the session
or restarting the extension discards the receipts. Do not start a new session just
to replay unconfirmed work.

When the CLI, daemon or extension does not support batching, use the existing
single commands. Do not upgrade or restart shared components just to finish a task.
