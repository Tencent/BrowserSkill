# One action, several decided actions, and a reusable observation

Use `step` when one action is already decided from current evidence. It invokes
that action exactly once, optionally waits for a known main-document selector to
be visible, then synchronizes. It uses the session's negotiated guard policy;
target policy requires compatible protocol 1.x peers at version 1.8 or later. With a current CLI
and an older extension, pass `--policy strict` on every step for its post-action sync. Choose
strict with an explicit sync before the action; a post-sync failure does not undo a completed action.

```sh
bsk step --session SID --context CURRENT --action click \
  --params '{"ref":"e3"}' --until-visible '#details-panel' \
  --wait-timeout-ms 5000 --save-full /absolute/new-step.json
```

Replace every example ref/selector with actual observed evidence. `--params` uses
existing protocol fields: `ref` or `selector`; `key` for press; `value` for fill;
`values` for select; `source`, `target`/`delta`, `mode` for drag; `url` for navigate.
Supported actions are click, press, fill, hover, select, drag, scroll-to, wheel and
navigate. No shell or script is executed. Session, tab, context, `--observation` and
`--expect` are CLI flags; `--depends-on` is for strict policy only. Unknown fields and conflicting targets fail before the action.
Each command authorizes one action, never a sequence of decisions.

Read `action`, `readiness`, and `post` separately. `post.context_id` is the current
control context; it remains reusable for target-policy DOM actions. `post.observation_id`
identifies the strict baseline and `post.observation` is the resulting VOM. `ok` means the
requested stages completed, not that a reservation/order succeeded. Verify the
actual form/values before declaring completion. With no `--until-visible`, the
returned state can still be intermediate; no readiness is claimed.

Use a positive signal that was not already visible, such as a known newly opened
panel. The selector's visibility is not a transition detector, and the existing
wait API checks its first match. Do not use a broad selector that can match an
unrelated visible node. A missing target consumes only the bounded wait budget
(1–25000 ms), then returns the latest state with `ok:false` and a nonzero exit;
inspect it for an unexpected login/error dialog. Do not repeat the action because
the wait timed out. Action errors, including unknown effects, stop the step and
are preserved without retry or follow-up input. Cancellation/user stop during
waiting ends the step. Sync alone can recover up to three times using the existing
readonly `--settle` rules. A human hold returns no context and is not success.

The wait and sync stay on the action's actual tab. Popup/new-tab workflows require
explicit inspection and selection; `step` does not follow an arbitrary active tab.
A saved step contains its action result even if a later wait/sync fails. Output
paths are checked before action; a publish failure is reported alongside the
action result, never as evidence that the action did not occur.

## Several decided actions

Under target policy, send supported actions already decided from one sync, such as
a form's fields or a report's filters, together with `plan` when they can share one
context. `plan` runs them in order and then synchronizes, so one model turn replaces
one turn per action. Use separate calls in the cases below.

```sh
bsk plan --session SID --context CURRENT --until-visible '#summary' --steps '[
  {"action":"fill","ref":"e3","value":"Ada"},
  {"action":"select","ref":"e4","values":["ZJ"]},
  {"action":"wait-for-element","selector":"#city option[value=HZ]","state":"attached"},
  {"action":"select","ref":"e5","values":["HZ"],"expect":[{"target":"@e4","field":"value","equals":"ZJ"}]},
  {"action":"click","ref":"e6"}
]'
```

A step is `action` plus the fields `step --params` takes for it, and optional `expect`.
Actions are click, fill, select, press, hover, scroll-to, wheel and drag, plus
`wait-for-element` (`ref` or `selector`, `state`, `timeout_ms`) for a condition later steps
need. A plan holds up to 20 steps; split longer sequences into batches and inspect
each batch's returned state before continuing. Every step passes the same control,
target and `expect` checks as its own command, immediately before its input.

- Include only what is already decided. A step that depends on what an earlier step
  reveals, or on a page that an earlier step replaces, belongs in the next call.
- The first step that does not complete stops the plan, nothing is retried, and completed
  steps stay done: a plan is not a transaction. Read `completed`, `stopped` (with its
  `effect_state`) and `not_run`, then replan from `post`, which is omitted after a stop
  request, a native dialog, a timeout or a lost connection. Never repeat a step whose
  `effect_state` is `unknown`, or that reported `dialog_pending`.
- Send an irreversible action such as submit or pay in its own call after reading the
  state, unless `expect` on that step protects the facts it depends on.
- Only the first step may be untargeted, and it needs `--observation`. Before another
  untargeted action, sync and inspect the page again. Navigation, scripts and actions
  not supported by `plan` (such as focus and blur) run in separate calls.
- Under strict policy, use one action followed by sync; do not batch inputs into a
  plan, because each context authorizes only one action.

## View existing evidence locally

Save the complete reply before display folding. The optional `--match-text` on
`step` or `cooperate sync` only folds plain stateless numbered fallback buttons
outside matching windows; business text, named/stateful controls and complete
forms/dialogs remain visible. Use `view --find` for general literal text search,
or read a different portion without another browser capture or a new ref map:

```sh
bsk view /absolute/new-step.json --find 'known label' --line-count 80
bsk view /absolute/new-step.json --start-line 200 --line-count 80
```

`view` performs zero browser calls. It marks output `historical:true`, reports
all literal matching line numbers (including duplicates), the shown line range,
local omissions and original truncation. It returns `source_context_id`, never
an actionable `context_id`. A no-match is not proof of absence from the live page.
A cache cannot recover content missing from the original capture. Prefer an
uncapped capture for large pages, then local views; raising a later sync's token
budget does not force an unchanged page to be recaptured.

To carry a saved baseline through an unchanged sync:

```sh
bsk cooperate sync --session SID --baseline /absolute/new-step.json \
  --save-full /absolute/new-sync.json
```

`step` accepts the same `--baseline`. Reuse requires an exact predecessor context,
the same session and tab, complete activity history, `kind:unchanged` and no field
changes. The CLI adds the existing VOM to that reply and marks its original capture
context with `observation_origin.kind:reused`. The newly issued context still comes
only from the live sync. Mismatches, field deltas, filtered files and missing history
do not reuse the cached text; inspect the returned state. A new baseline always wins.

Under target policy a sync may also answer `kind:delta` with `observation_patch.lines`
when the only page activity since the predecessor replaced visible text in place.
`changes` then lists each `kind:text` replacement with its `previous_value`, `value`
and the 1-based VOM `lines` it touched, and `previous_observation_id` names the exact
version the patch applies to. With `--baseline` pointing at that version the CLI applies
the patch, saves the merged observation through `--save-full`
(`observation_origin.kind:merged`, `cache_reuse.reason:exact_text_delta_predecessor`)
and leaves the page text out of stdout (`cache_reuse.observation:saved`); read it with
`view`. Chain the next sync from the newly saved file. Without the exact predecessor
nothing is merged: apply the line patch yourself or sync again for a baseline.

Anything the extension cannot express as such a patch returns a fresh `baseline` with
a `baseline_reason`, for example `structure_changed`, `refs_replaced`, `frame_replaced`,
`focus_changed`, `human_activity`, `text_log_gap`, `text_outside_observation`,
`text_ambiguous`, `token_budget_changed` or `token_budget_shift`. Keep the same
`--max-tokens` across syncs you want patched. Pages with child frames, and text inside
controls, headings, labels, form fields, table rows or list items, always take the
baseline path.

For readonly date pickers, click to open the picker instead of filling it. If VOM
exposes only a containing control, inspect that observed ref with `get-html --ref`
and use an unambiguous selector found there. Read another part of an existing file
before capturing the page again. These are general control patterns, not site rules.

For performance comparisons, count tool invocations, underlying RPCs and full
baseline returns separately. `step.rpc_calls` includes action/wait/sync, while
`view.browser_calls` is zero. Guard-internal captures are not measured by these
counts. Include recovery and model/tool round trips in wall time; report setup,
compilation, diagnostic export and human waiting separately.
