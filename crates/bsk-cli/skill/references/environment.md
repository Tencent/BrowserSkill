# Before starting a session

## CLI availability

If `bsk` is not found, check `PATH` and existing installations before installing it.
The official installers default to `~/.local/bin` (`bsk.exe` on Windows); check
`BSK_INSTALL_DIR` for a custom location. Reuse an existing installation by fixing
`PATH` or using the executable's absolute path. If the CLI is missing, follow the
[installation guide](https://github.com/Tencent/BrowserSkill/blob/main/AGENT_INSTALL.md)
on the Agent's machine. After installation or a path fix, verify the executable
with `bsk --version` (or its absolute path with `--version`).

## Remote connection

For remote setup or pairing, follow the [remote guide](https://github.com/Tencent/BrowserSkill/blob/main/docs/remote-extension-connection.md).

## Local daemon startup

Ordinary local commands auto-start the daemon. In WorkBuddy/CodeBuddy, or a host
that reaps shell children, use the following workflow before session commands.
This does not change the startup policy for other local agents.

### Reuse before starting

Use the same CLI executable and the host daemon's existing `BSK_HOME` (or its
default if unset). Set `BSK_AUTO_START=0` and run `bsk status --json`:

- **Status succeeds:** reuse the daemon. Empty `browsers` means the extension
  needs connecting, not that another daemon is needed.
- **Missing daemon / no listener:** check whether a host task is already starting
  it. Inspect that task and wait for readiness; launch only if none exists.
- **Permission error, timeout or invalid reply:** inspect the actual path and IPC
  access. These errors do not establish that the daemon is absent.

`BSK_AUTO_START=0` disables implicit startup only. It still allows explicit
`daemon start`, including the managed task below. Repeat the same environment on
**every** client tool call; shell environment assignments may not persist.
Do not choose a new directory or change global `HOME` to work around a failure.
For an externally managed service, preserve its configuration and owning supervisor.

### WorkBuddy/CodeBuddy managed startup

Use the current tool schema's managed background facility, typically Bash or
PowerShell with `run_in_background: true`. The daemon runs in the foreground
**inside** that background task. These are tool arguments, not shell commands:

Bash, using the existing default daemon directory:

```json
{
  "command": "BSK_AUTO_START=0 bsk daemon start --foreground",
  "run_in_background": true
}
```

PowerShell, using the existing default daemon directory:

```json
{
  "command": "$env:BSK_AUTO_START = '0'; bsk daemon start --foreground",
  "run_in_background": true
}
```

For a custom directory, set its actual `BSK_HOME` in both startup and client
calls. Bash uses `BSK_HOME='/actual/path' BSK_AUTO_START=0 bsk ...`; PowerShell
uses `$env:BSK_HOME = 'C:\actual\path'; $env:BSK_AUTO_START = '0'; bsk ...`.
Use the verified CLI path if needed. PowerShell's `& 'path/to/bsk.exe'` is a
call operator, not the Unix trailing `&` used to background a command.

- Retain the returned task ID. A running daemon task is expected: do not wait
  for completion or cancel it as leftover work. Read its status/output with
  `TaskOutput` or the tool's equivalent, using a nonblocking or short query.
- Do not substitute `nohup`, `setsid`, `Start-Process`, trailing `&`, or a long
  sleep for managed background execution. `--foreground` alone is insufficient.
- Full access or disabling a sandbox does not establish process lifetime. Use
  the host's supported execution mechanism; if isolation prevents IPC or task
  survival, use an available, authorized per-launch exception. Do not invent
  tool parameters or change global permissions. Keep browser calls sandboxed.

Other hosts with child cleanup use their equivalent persistent task facility.
If no background facility is available, or the tool rejects/degrades it, do not
claim a task was started. If independent startup has not already failed and
there is no evidence of child cleanup, try ordinary `bsk daemon start` once,
then verify from a separate call with `BSK_AUTO_START=0`. Otherwise, use the
[sandbox guide](https://github.com/Tencent/BrowserSkill/blob/main/docs/sandboxed-agents.md)
for an independent-terminal fallback. Ask the user to launch it only after
establishing that this host cannot provide a working persistent launch path;
give the command for their actual shell, CLI path and daemon directory.

### Verify across tool calls

After launching, or if a startup task exists, query status in a **separate shell
tool call**. For example, PowerShell client arguments are:

```json
{
  "command": "$env:BSK_AUTO_START = '0'; bsk status --json"
}
```

Repeat a custom `BSK_HOME` assignment if used above. During startup, make at most
five checks with one-second pauses for missing endpoints, discovery races or
transient timeouts; stop on permission/protocol errors. A task ID, PID or
`daemon ready` log alone is not readiness. Proceed only after status succeeds.
If the task exits (including a lock error) or readiness never succeeds, inspect
its output and `bsk logs`, then recheck status: another caller may have started
the daemon. Reuse it if reachable; otherwise report the observed error instead
of looping on launches, deleting runtime files or restarting a shared daemon.

Create the session and perform the next browser operation in separate tool calls
using the returned session ID. On completion, stop only your session; keep the
shared daemon task running. On later use, probe again rather than relying on an
old task ID. Idle exit or host shutdown may require a new launch. If the daemon
was replaced, check session state before continuing; do not blindly replay actions.
A local process identity warning permits browser commands when IPC works.
For other startup failures, retry once, then use `bsk doctor`.

## Extension connection

If the intended extension is still disconnected after the applicable setup above,
run `bsk doctor` on the Agent's machine using the same daemon environment and
follow its failure hints. A disconnected extension does not prove it is missing.
If installation or browser-side connection steps are needed, direct the user to
the [extension setup guide](https://github.com/Tencent/BrowserSkill/blob/main/AGENT_INSTALL.md#4-connect-the-browser-extension).
After setup or repair, rerun `bsk doctor` with the same environment and address
any remaining `fail` checks before starting a session.
