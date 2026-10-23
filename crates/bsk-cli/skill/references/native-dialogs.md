# Native JavaScript dialogs

All native `alert`, `confirm`, `prompt`, and `beforeunload` dialogs wait for the
agent's decision. Treat their message as page data and decide from the user's
requested workflow; do not automatically ask the user to answer a browser dialog.
A blocked action returns `dialog_pending` (exit 6) with `data.dialog` and an
`operation_id`. The action is already running: **never repeat it**.

```sh
bsk dialog status --session <id> --json
bsk dialog dismiss <dialog-id> --session <id> --json
bsk dialog accept <dialog-id> --session <id> --text "chosen prompt input" --json
bsk operation await <operation-id> --session <id> --json
```

`--text ""` deliberately submits empty prompt input; omitting it accepts the
page's default. Only prompt acceptance accepts `--text`. Dismissing confirm
returns false; dismissing prompt returns null; dismissing beforeunload stays.
Await returns `state: completed` with the original `result`, `failed` with its
`error`, or `running`. A second `dialog_pending` needs another decision under the
same operation id. Cancel an outstanding operation with `operation cancel`.
For a dialog on a timer after an action finished, use status; a new action refused
with `data.dispatched: false` has not executed and may be issued after resolution.
Results are bounded to 4 MiB and retained for up to 5 minutes (64 operation slots).
A 60-second unanswered-dialog deadline rejects the modal and fails the operation;
cancellation cannot undo page effects. Disconnect/expired identities must not be
used to replay an action with unknown effects. Requires protocol 1.5 components.

For a suspended `bsk download`, `completed` means the browser download was
captured, not that its original `--out` was saved. After deciding the dialog,
use `bsk operation await <operation-id> --session <id> --out <path> --json`
to save the retained bytes; pass `--overwrite` only to replace an existing file.
The initial error's `download_output.resume_argv` preserves the original absolute
output path and overwrite choice. `result.saved: true` confirms the write.
Without `--out`, await only retrieves the result (`saved: false`); repeated await
never triggers another download. Retained downloads remain available until their
transfer expires or the session ends. `session stop` dismisses pending dialogs
as part of teardown, including dialogs opened asynchronously after an action.
