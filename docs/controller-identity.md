# Identify the agent controlling a browser session

Pass display labels when starting a session:

```sh
bsk session start --agent-name Codex --project "Search service" --controller-color '#2563eb' --json
bsk session start --agent-name Claude --project "Payments" --json
bsk session list
bsk status --json
```

The collaboration overlay shows the agent name, project label, session ID and a
color marker. Pause/resume controls name the agent. Without `--agent-name`, the
overlay keeps the BrowserSkill title and still shows the session ID. An omitted
color is selected from a palette seeded by the session ID, avoiding colors already
used by live sessions. Colors can repeat after the six-color palette is exhausted
or when explicitly requested, so text labels and session IDs always remain visible.

`--project` and `--controller-color` require `--agent-name`. Agent names accept
1–80 Unicode code points; project labels accept 1–120. Blank labels and control
characters are rejected. Explicit colors must be six-digit hex (`#RRGGBB`). Quote
hex colors in shells where `#` starts a comment. Labels are rendered as text.
They are caller-supplied display information, not authenticated identities or
permissions. Avoid putting secrets or private filesystem paths in these labels.

The MCP `bsk_session` tool's `start` action accepts `agent_name`, `project`, and
`controller_color` with the same meaning. Other clients can send an optional
`controller: { name, project?, color? }` in `session.start` / `tool.session_start`.
The daemon includes it in each session entry returned by `session.list`,
`system.status`, and recoverable request status. Retrying a tracked start with
different metadata is rejected under the existing request-id rules.

Install the updated CLI/daemon and extension together to see the labels. The
metadata is additive: older clients can omit it, and older extensions may ignore
it. Session ownership, tab borrowing and the stop button keep their existing
behavior. Returning a tab or releasing a session clears its overlay identity;
navigation and overlay reinitialization obtain the current identity from the
extension's session registry. The feature adds no identity persistence across
terminated sessions or extension worker restarts.

Chrome/Edge's native debugger banner uses the installed extension's name and
cannot be customized per session. Identity is shown in BrowserSkill's own overlay.
The feature does not rewrite page/window titles or introduce control preemption.

## Run the isolated browser regression

Build the CLI (`cargo build -p bsk --locked`) and extension with
`BSK_DAEMON_WS_URL=ws://127.0.0.1:52836 pnpm ext:build`. Set `BSK_TEST_CLI`
(defaults to `target/debug/bsk`) and `BSK_TEST_CHROME` to a Chromium executable that
supports unpacked extension loading through CDP, then run:

```sh
node evals/browser/cases/regression/controller-identity/run.mjs
```

The regression owns a temporary profile and daemon home. It checks independent
identities, status metadata, legacy clients, navigation, narrow viewports, long
labels, and session cleanup. Screenshots and a JSON result are saved under
`evals/browser/results/controller-identity/`. Override `BSK_IDENTITY_PORT` together
with the build-time daemon URL if port 52836 is in use.
