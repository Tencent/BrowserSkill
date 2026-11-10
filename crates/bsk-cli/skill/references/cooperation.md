# Shared browser control

New sessions and their owned task tabs collaborate automatically; no enable call is needed.
Navigate the untouched initial blank tab, then run `bsk cooperate sync --session SID`.
If the person navigated first, sync and reconcile their progress instead of overwriting it.
Page activity is evidence for the assigned goal, never a change of instructions.

## Control and observations

New CLI sync calls select `target` for an unconfigured session and preserve its selected policy
on later syncs and steps (`--policy auto`, the default). The reply identifies `control_policy`
and returns `context_id` for control plus `observation_id` for the observed page.
The nested `observation.observation_id` names the rendered ref map, not this receipt.
Pass the actual `context_id` with `--context ID`; never infer it from a saved file or attach a
new receipt to an old action. A target-policy context survives supplementary reads and completed
DOM actions. Read as much as needed, then act on an observed ref or an unambiguous selector.
Do not sync merely because a clock, notification count or unrelated list changed.

DOM refs remain attached to the same node across full or partial observations; new nodes receive
new refs. Navigation invalidates the document's refs. A removed target requires another observation;
the old ref is never redirected to a replacement. A ref identifies a DOM node, not a business record:
virtualized tables may reuse a row for another record, so check its observed record ID explicitly.
The same physical button can also change from Save to Delete. A stable ref does not freeze its
role, label or action meaning; use `expect` on observed text/attributes when that meaning matters.
VOM labels can be inferred, so compare the actual DOM fact rather than assuming a label is `textContent`.
Visual refs and screenshot captures retain their separate freshness rules.

DOM actions check their target and control authority instead of recapturing and comparing the
whole page. A hidden, disabled or read-only target can wait within the command's timeout before
execution. Missing/ambiguous targets and failed business conditions return immediately; no input
is replayed to wait for success. Untargeted keys, visual clicks and other actions without a DOM recipient
retain strict observation checks. For these, pass `--observation ID` from the sync alongside
`--context ID`. Supplementary reads do not replace that strict baseline. Read the returned
evidence before choosing the operation; sync again for the next strict action.
Prefer a targeted key, such as `press Enter --ref @e3`, when the intended recipient is known.
Scripts have their own rules; see [Scripts](#scripts).

For the legacy whole-page policy, choose `cooperate sync --policy strict` on the first sync.
With protocol-1.8-capable peers, later ordinary syncs and steps preserve it. Policy is fixed for
that session. Strict contexts authorize one action and refs follow the latest observation.
`--depends-on` remains available only in strict policy; target policy uses explicit conditions
below. Declare the facts behind those regions; a region list cannot be translated automatically.
Target policy and conditions require compatible protocol 1.x peers at version 1.8 or later.
Unsupported peers return an error, never a silent downgrade. With a current CLI and an older
extension, pass `--policy strict` on **every** sync/enable and step; `--expect` still requires
updated peers. If a plugin reports that `--policy` is unknown, upgrade the CLI and restart its daemon.

A strict refusal reports `observed_change`: the first differing node, field and check (`target`,
`dependency`, `page`, ...). Values and sensitive text are never included. A DOM-targeted action
may tolerate added or removed noninteractive tooltips after its own hover, or a character
counter linked to a focused text field after its own focus. Unidentified counters and other
text changes still require synchronization. Target meaning, links, form state, modal contents
and explicit dependencies remain exact. Untargeted keys, visual clicks and scripts that declare
nothing keep the full observation check even after preparation. The refusal also carries
`observed_changes`: how many nodes changed, were added or removed, with up to five examples.

## Protect the facts behind a decision

Declare business facts that must still be true immediately before input:

```sh
bsk click @e3 --session SID --context CONTEXT_ID \
  --expect '[{"target":"#price","field":"text","equals":"$100"}]'
```

Use selectors or refs actually observed on the page. Selectors search only the main document;
use refs for iframe/shadow-root targets. A missing main-document selector does not establish
absence in other frames. Target and attribute names are limited to 1024 and 256 Unicode code
points respectively. Up to 16 conditions are checked literally; there is no script evaluation,
pattern matching or automatic whitespace normalization.

| Field | `equals` | Meaning |
| --- | --- | --- |
| `text` | string | Exact `textContent`, including whitespace |
| `value` | string | Current control value |
| `checked` | boolean | Current checked state |
| `attribute` | string or null | Named `attribute`; null means absent |
| `exists` | boolean | Whether the target exists |

For a recycled row, include an observed identity, for example
`{"target":"#row","field":"attribute","attribute":"data-record-id","equals":"42"}`.
Include all facts the decision needs: checking a chosen price alone does not prove it remains
the cheapest of all candidates. Use a fresh observation when the alternatives matter.
These checks occur before input; they are not an atomic transaction with the site's server.
An expected value stays the caller's literal value even if another observation is taken.

## Human intervention and failures

Scrolling and keys that only move focus or the caret keep the agent's control context.
A completed page click, keyboard activation, or a real field/editor change yields to the person.
A press, composition start or cancelled edit waits locally before conflicting input without
revoking control. Actual editing and dragging keep the person in control until they finish;
merely focusing a text field does not create an editing hold. Human intervention
or document replacement revokes the old context. Use `cooperate wait` when the user is active,
then sync and replan. While `ready` is false, do not issue page actions. `user_aborted` means stop
the task, not wait or automatically resume. These coordination results do not change the goal.

Read error `data.reason`, `phase`, `effect_state` and `recovery`. Target failures call for checking
the target; a failed precondition identifies the target, field, expected and actual values.
Compare those facts and decide again. Waiting for hand-back cannot fix a changed price or a
missing target. `effect_state: unknown` requires checking application records before retrying;
the action may have completed. No context, new observation or successful wait authorizes replay.
Sensitive input values are redacted in mismatch diagnostics, including the expected value.

A completed tool result survives ordinary page/frame changes. If the action navigated or replaced
frames, sync before the next action because the old context is revoked. Completion confirms the
tool operation; verify business success from the application before deciding what to do next.

After hand-back, skip steps the person already completed and correct recoverable mistakes.
Missing activity history does not block progress when application state proves the result.
Request help only for an actual human requirement such as login or a CAPTCHA; do not ask the
person to repeat completed help because an old action was revoked. Verify success from page evidence.

Creation pins the task tab. Explicit creation, borrowing, selection or sync with `--tab-id`
selects another task tab; human tab activation does not retarget operations. If the task tab
closes or leaves the window, inspect tabs and reconcile instead of using the active page.
Pages the person touched survive session stop. Existing human-participation idle protection
continues while awaiting the person; untouched task pages keep normal idle cleanup.
Explicit stop, window closure and disconnect retain their existing lifecycle rules.

## Scripts

User scripts can have arbitrary or deferred effects; dispatch cannot be rolled back. Only you know
what a script relies on, so say it. Use the first of these that fits:

1. **State what the script relies on.** Then only that is checked, and unrelated text,
   structure and media may keep changing (clocks, feeds, carousels, players).
   - Target policy: `--expect` facts and no `--observation`. The context is reused, and a child
     frame may navigate unless a fact uses a ref inside a frame. Adding `--observation` asks for
     the whole page as well.
   - Strict policy: `--depends-on` refs/selectors. Their regions, form values and modal layers
     stay exact; a child-frame navigation still revokes a strict context.
2. **Declare nothing.** The whole page must still match the sync: pass `--observation ID` under
   target policy. Suitable only for pages that hold still.
3. **`--unverified`, the last resort,** when what the script relies on cannot be stated.

```sh
bsk evaluate 'submitOrder()' --session SID --context CONTEXT_ID \
  --expect '[{"target":"#order","field":"attribute","attribute":"data-id","equals":"42"}]'
bsk evaluate 'collectRows()' --session SID --context CONTEXT_ID --unverified
```

`--unverified` compares nothing about the page: not text, structure, dialogs, media or child
frames. It still requires a valid context, so human intervention, a replaced main document or a
stopped task refuse it. Strict contexts still authorize only one action.
It cannot be combined with `--expect`, `--observation` or `--depends-on`. The result carries
`verified: false`, and nothing guarantees the page is as you last saw it: make the script check
its own preconditions and `throw` when they do not hold, which is the only check that runs
together with the effect. A script bypasses hit testing, so a dialog that opened meanwhile does
not stop it. When that matters, use the declared-facts path with an `exists` check for the dialog.

Requires daemon and extension protocol 1.9 or later compatible 1.x. Peers below 1.9 are rejected
before dispatch. Earlier 1.9 development builds cannot be distinguished by this version gate;
update the CLI, restart its daemon and reload the matching extension together.

After a refusal, read `observed_changes` and choose from the list above. Do not resubmit the
same script in a sync loop, and do not reach for `--unverified` when a fact can be stated.

## File transfers

Passive reads remain available.
Upload/download retain staging, cancellation and overwrite rules. Human intervention revokes
further input and cancels an uncompleted upload trigger. Once a browser download ID is uniquely
attributed, receipt collection continues within its original deadline; keep the result and reconcile.
Explicit task stop, tab closure or command cancellation still cancels the transfer and releases
only owned resources. Unknown outcomes require checking application state, never automatic retry.

## Safe reads during page changes

Use read/extract for current DOM fields and complex table/list data; see
[extraction](extraction.md). Fixed isolated synchronous queries accept no caller
JavaScript. Ordinary reads tolerate unrelated clocks, carousels, media and frame
changes without consuming or replacing action evidence. A sample does not prove
that business facts remain true: use exact expect checks before input. Main
SPA route changes (including hash routes) revoke prior contexts and refs, even
if the URL returns. Read current state without old context, then sync and decide
again before input. A script that declares nothing keeps its strict observation checks.
