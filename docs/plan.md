# Plans: several decided actions in one call

`plan` runs several input actions that one observation already decided, then returns
the synchronized state. Filling a form or setting a report's filters takes one model
turn instead of one per action.

| Entry point | Name |
| --- | --- |
| CLI | `bsk plan` |
| MCP | `bsk_plan` |
| Wire protocol | None; the client sends each step's existing `tool.*` request |

## Usage

```sh
bsk plan --session abcd --context CURRENT --until-visible '#summary' --steps '[
  {"action":"select","ref":"@e45","values":["east"]},
  {"action":"select","ref":"@e46","values":["done"]},
  {"action":"click","ref":"@e49"}
]'
```

A step is an `action` beside the fields that action's `bsk step --params` takes, and
optional `expect`. Actions are `click`, `fill`, `select`, `press`, `hover`, `scroll-to`,
`wheel` and `drag`, plus `wait-for-element` (`ref` or `selector`, `state`, `timeout_ms`)
for a condition that later steps need. `_` and `-` are interchangeable in these names.
A plan holds 1 to 20 steps.

## Reply

```json
{"ok":false,"completed":1,"total":3,
 "stopped":{"index":1,"action":"select","effect_state":"none","error":{"message":"..."}},
 "not_run":[2],"post":{"context_id":"...","observation":{"text":"..."}},"elapsed_ms":412}
```

- `completed` counts the steps that finished, always the first ones in order.
- `stopped` names the step that ended the plan. `effect_state` is `none`, `committed` or
  `unknown`, and is `unknown` whenever the failure carries no evidence that nothing was sent.
- `notes` holds receipt details the final state cannot show, such as handled dialogs.
- `post` is the same read-only sync as `bsk step`. It also follows a refused or failed step,
  so the caller can replan without another call. It is omitted after a stop request, a
  native dialog, a timeout or a lost connection, and a human hold returns no context.
- `readiness` holds the `--until-visible` wait, which runs only after every step completed.
  Exit status and `isError` follow `ok`.

## Guarantees

The client sends the same request each step's own command would, so the extension checks
control, the target and `expect` immediately before every input. Human input between two
steps refuses the next step. All steps stay on the plan's tab, even if a click opens another.

A plan is not a transaction. Completed steps stay done, and nothing is retried or rolled
back. It removes the model between actions, so it must not be used where a later action
depends on what an earlier one reveals. An irreversible action such as submit or pay
belongs in its own call after reading the state, unless `expect` protects its facts.

## Limits

- Steps share one control context, which requires target policy and daemon protocol 1.8.
  Under strict policy a context authorizes one action, so a plan stops after its first step.
- A strict observation authorizes one action on the page as observed, so only the first
  step may be untargeted, and it needs `--observation`.
- `navigate` and `evaluate` run on their own: navigation retires the context, and a
  script's result usually decides what comes next.
- The 120-second budget is checked between steps. A step in flight finishes under its own
  timeout, because cutting it short would turn a clean result into an unknown effect.
