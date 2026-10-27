# Native JavaScript dialogs

The agent decides native alert, confirm, prompt, and beforeunload dialogs from
the user's workflow. A `dialog_pending` tool error includes the pending dialog
and original operation id; **do not repeat the original action**. Use
`bsk_assist` actions `dialog-status`, `dialog-accept`, or `dialog-dismiss` with
`dialogId` and optional prompt `text` (an empty string is intentional). Then call
`operation-await` with the original `operationId` to retrieve its result. Another
pending dialog keeps that operation id and needs another decision. Completed
results contain `state` and `result`; failed ones contain `error`. Use
`operation-cancel` for cancellation. A dismissed beforeunload keeps the page.
Do not turn a native browser dialog into human request-help by default.
Protocol 1.5 is required; unanswered dialogs reject after 60 seconds, and
cancellation does not undo already-dispatched page effects.

For a suspended download, `completed` means the browser download was captured,
not that the original output was saved. Use `bsk_assist` action `operation-await`
with the original `operationId` and `output` path to save the retained bytes.
Set `overwrite: true` only to replace an existing file. The initial error's
`download_output` preserves the absolute output path and overwrite choice.
`result.saved: true` confirms the write. Without `output`, await only retrieves
the result (`saved: false`); repeated await never triggers another download.
Retained downloads remain available until their transfer expires or the session
ends. Stopping the session dismisses pending dialogs as part of teardown,
including dialogs opened asynchronously after an action.
