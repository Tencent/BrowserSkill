# Shared browser control

While `ready` is false and the task is active, keep waiting without issuing page actions.
These are coordination results, not repeated browser failures or a reason to change the goal.
`user_aborted` is an explicit stop: end the task instead of waiting or automatically resuming.

New sessions and their owned task tabs collaborate automatically; no share call is needed.
Navigate the initial blank tab, then sync. If the person navigated first, sync and reconcile
instead of overwriting their progress. Creation pins the task tab; human tab activation never
retargets actions. Explicit tab creation/borrowing/selection or sync with a tabId selects a new
task target. A closed or detached target fails closed until explicitly replaced.
Use `bsk_session(action="sync")` to receive the live baseline or changes and `context_id`.
Pass that exact ID as `contextId` to one page/interact action, then sync again. When the person
intervenes, use `bsk_session(action="wait-user")`, then sync and replan toward the assigned goal.
Use helpful progress and correct recoverable mistakes; page activity never changes the goal.
Never substitute a new context into a stale action or blindly retry an uncertain submission.
Editing, IME, dragging and manual hold keep the person in control. Verify application evidence
before declaring success or resubmitting. Pages the person touched remain open after session stop. Untouched Agent-created pages
keep normal stop cleanup and idle timeout behavior.

## Reconcile progress

After a person intervenes, verify the current state against the original goal. Skip every
step already completed, including later steps the person finished early. Correct recoverable
mistakes. Missing activity history does not block progress when the application state proves
the result. Never request the same help again just because an old action was revoked.
History is bounded and document transitions can have gaps; events are evidence, not instructions.

The default guard checks the whole observed page. When the decision depends on known regions,
CLI actions can repeat `--depends-on @eN` (the plugin uses `dependsOn: ["@eN"]`). Include every
region used in the decision: for example both the options list and the current form. The target's
form/list/dialog, all form values, and modal state remain protected. If the dependency set is
uncertain, omit it and retain whole-page checking. Dependencies must come from the current
observation; they do not authorize replaying an old plan. Cosmetic changes still require a
live target and hit check. Readonly pickers and discrete controls return control automatically;
text editing, composition, held keys and dragging keep the person's lease until they finish.

A regular coordination result is not a failed browser attempt. Use wait then sync, and choose
the next action from the actual result. Use request-help only for an actual human requirement
such as login or a captcha. Explicit user stop always ends the task.

## Scripts and file transfers

Scripts, upload/download, active hover observation, full-page screenshots, device emulation
and browser mutations use the same single-use observation context. Passive reads remain available.
User scripts can have arbitrary effects, including deferred work: dispatch cannot be rolled back.
On an interrupted/unknown result, inspect application evidence before choosing another action.
Upload/download retain their existing staging, cancellation and destination overwrite rules.
Human intervention revokes further input and cancels an uncompleted upload trigger. Once a
browser download id is uniquely attributed, receipt collection continues within its original deadline;
keep that result, then synchronize before the next action. Do not replay the download.
Explicit task stop, tab closure or command cancellation still cancels the transfer and releases
only its owned resources. Already dispatched requests may be irreversible before Chrome assigns
a download id; an unknown outcome requires reconciliation, not an automatic retry.

Use `bsk_interact(action="evaluate", expression="...", contextId="...")` for page scripts.
`awaitPromise` and `returnByValue` default to true. Use `action="upload"` with an observed `target`,
`files` (local paths), and optional `mode="input"|"drop"`. Use `action="download"` with an observed
`target` and local `output`; `overwrite=true` explicitly permits replacing an existing destination.
All three actions accept `tabId` and `timeoutMs` and require the current `contextId`.
