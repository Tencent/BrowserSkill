# Native JavaScript dialogs

The agent decides native alert, confirm, prompt, and beforeunload dialogs from
the user's workflow. A `dialog_pending` tool error includes the pending dialog
and original operation id; **do not repeat the original action**. Use
`browser_assist` actions `dialog-status`, `dialog-accept`, or `dialog-dismiss` with
`dialogId` and optional prompt `text` (an empty string is intentional). Then call
`operation-await` with the original `operationId` to retrieve its result. Another
pending dialog keeps that operation id and needs another decision. Completed
results contain `state` and `result`; failed ones contain `error`. Use
`operation-cancel` for cancellation. A dismissed beforeunload keeps the page.
Do not turn a native browser dialog into human request-help by default.
Protocol 1.4 is required; unanswered dialogs reject after 60 seconds, and
cancellation does not undo already-dispatched page effects.
