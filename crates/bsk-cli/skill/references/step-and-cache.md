# One action and a reusable observation

Use `step` when one action is already decided from current evidence. It invokes
that action exactly once, optionally waits for a known main-document selector to
be visible, then synchronizes. All operations use the existing guard and protocol;
this CLI orchestration does not require an extension upgrade.

```sh
bsk step --session SID --context CURRENT --action click \
  --params '{"ref":"e3"}' --until-visible '#details-panel' \
  --wait-timeout-ms 5000 --save-full /absolute/new-step.json
```

Replace every example ref/selector with actual observed evidence. `--params` uses
existing protocol fields: `ref` or `selector`; `key` for press; `value` for fill;
`values` for select; `source`, `target`/`delta`, `mode` for drag; `url` for navigate.
Supported actions are click, press, fill, hover, select, drag, scroll-to, wheel and
navigate. No shell or script is executed. Session, tab, context and `--depends-on`
are CLI flags. Unknown fields and conflicting targets fail before the action.
Each command authorizes one action, never a sequence of decisions.

Read `action`, `readiness`, and `post` separately. `post.context_id` is the next
single-use action context; `post.observation` is the resulting VOM. `ok` means the
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
only from the live sync. Mismatches, deltas, filtered files and missing history do
not reuse the cached text; inspect the returned state. A new baseline always wins.

For readonly date pickers, click to open the picker instead of filling it. If VOM
exposes only a containing control, inspect that observed ref with `get-html --ref`
and use an unambiguous selector found there. Read another part of an existing file
before capturing the page again. These are general control patterns, not site rules.

For performance comparisons, count tool invocations, underlying RPCs and full
baseline returns separately. `step.rpc_calls` includes action/wait/sync, while
`view.browser_calls` is zero. Guard-internal captures are not measured by these
counts. Include recovery and model/tool round trips in wall time; report setup,
compilation, diagnostic export and human waiting separately.
