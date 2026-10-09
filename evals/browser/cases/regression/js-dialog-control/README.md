# Agent-controlled JavaScript dialogs

This opt-in regression uses a real, visible Chrome for Testing window with the
production MV3 extension installed. Every answer is sent through the actual
`bsk` CLI → daemon IPC → extension WebSocket → `chrome.debugger` path. The remote
CDP connection only starts/discovers the isolated browser. It never answers a
dialog. No personal Chrome profile or shared daemon is used.

## Run

From the repository root, install the locked dependencies and build matching
protocol 1.4 components. The extension's port must match the private test daemon:

```sh
cargo build --locked -p bsk --bin bsk
BSK_DAEMON_WS_URL=ws://127.0.0.1:52837 pnpm --filter @browser-skill/extension build
BSK_DIALOG_CHROME='/absolute/path/to/Chrome for Testing' \
  BSK_DIALOG_TEST_TIMEOUT=1 \
  node evals/browser/cases/regression/js-dialog-control/run.mjs
```

Set `BSK_DIALOG_BSK` and `BSK_DIALOG_EXTENSION` to override the default binary and
build paths. `BSK_DIALOG_OUTPUT` defaults to the ignored
`evals/browser/results/js-dialog-control` directory. `BSK_DIALOG_TEST_TIMEOUT=1`
adds the real 60-second unanswered-dialog test; omit it for the shorter run.

On macOS, optional screenshots use `BSK_DIALOG_SCREENSHOT_HELPER` pointing to the
Codex screenshot skill's `take_screenshot.py`, after granting Screen Recording.
It captures only the owned Chrome for Testing window titled
`BrowserSkill Dialog Control`. Screenshots are raw window captures.

The runner writes the complete CLI transcript, browser version, test timestamp,
tested revision (`BSK_DIALOG_REVISION`), a debug export, and any screenshots.
Debug capture remains enabled during decisions, exercising the control path
while renderer-dependent debug hooks would otherwise block.

## Assertions

| Scenario | Checked result |
| --- | --- |
| Confirm dismissed after evaluate | Original value `false`; action counter stays at one even after retrieving the result twice |
| Confirm accepted after a real click | The click runs once and changes the page's test state |
| Prompt accepted with text | Original value `"Agent-selected name"` |
| Prompt accepted with empty text / dismissed | Exact empty string / `null` |
| Prompt accepted without text | Keeps the native default, including a 10,000-character default despite the bounded status preview |
| Alert | Requires an explicit acknowledgement |
| Confirm followed by prompt | One operation id; two distinct dialog ids; stale first id is refused; action runs once |
| Beforeunload dismissed / accepted | Navigation fails with `cancelled` and retains the original URL / completes at the destination |
| Operation cancelled | Original failure is retrievable and pending modal is cleared |
| Another session | Cannot see, answer, or retrieve the first session's dialog |
| Asynchronous prompt | Status discovers it; a new ordinary action is rejected with `dispatched: false` and has no side effects |
| Unanswered dialog | Rejects at its 60-second deadline; original operation fails; no implicit confirmation or replay |

This is an executable regression with agent-selected test answers. It verifies
that the agent has the controls to decide; it does not benchmark how an LLM
chooses an answer on arbitrary websites. DSH model-facing action routing and
preservation of receipt identities have separate plugin tests.

## Decision example

After a click/evaluation opens a native prompt, the initial call returns exit 6:

```json
{
  "code": "dialog_pending",
  "data": {
    "dispatched": true,
    "operation_id": "op-original",
    "dialog": { "id": "dialog-current", "type": "prompt", "message": "Choose a display name", "default_prompt": "anonymous" }
  }
}
```

The agent supplies an answer and retrieves the original result without repeating
the click/evaluation:

```sh
bsk dialog accept dialog-current --session SESSION --text 'Agent-selected name' --json
bsk operation await op-original --session SESSION --json
```

The second command returns `state: completed` with the original value, or
`state: failed` with the original error. `running` means continue waiting. Another
pending dialog keeps the same operation id. An asynchronous modal can instead
be found through `dialog status`; a refused action with `dispatched: false` has
not executed. The live IDs and actual results are in the evidence transcript.
