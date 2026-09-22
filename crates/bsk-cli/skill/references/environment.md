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

Local commands normally auto-start the daemon. If the host terminates background
children after each shell call, including on Windows, complete these steps first:

1. Reuse the host daemon's existing `BSK_HOME` (or its default if unset). Set
   `BSK_AUTO_START=0` and run `bsk status --json`. Reuse a working daemon; an empty
   `browsers` list means the extension still needs connecting. Permission errors,
   timeouts or invalid replies do not prove the daemon is absent.
2. Only if the check reports a missing daemon and no host task is already starting
   it, run `bsk daemon start --foreground` with the same `BSK_HOME` in the host's
   approved persistent background task outside the per-command sandbox. Keep that
   task alive; `--foreground` alone cannot prevent host cleanup. The
   [sandbox guide](https://github.com/Tencent/BrowserSkill/blob/main/docs/sandboxed-agents.md)
   covers the normal host-terminal alternative and PowerShell examples.
3. After launching, or if a host task is already starting the daemon, run
   `bsk status --json` in a **separate shell tool call** with the same `BSK_HOME`
   and `BSK_AUTO_START=0`. While startup is pending, make at most five
   checks with one-second pauses for missing-endpoint or transient startup errors;
   stop on permission/protocol errors. Proceed only after a successful status
   response. If the host task exits (including a lock error) or readiness never
   succeeds, inspect its output and `bsk logs`, then recheck status for another
   daemon before deciding whether startup is still needed. Report unresolved
   errors; do not loop on launches, delete runtime files or restart a shared daemon.

Use the same `BSK_HOME` and `BSK_AUTO_START=0` on EVERY sandboxed command;
environment settings may not persist between shell calls. Keep browser commands
sandboxed. For other startup failures, retry once, then use `bsk doctor`.
A local process identity warning permits browser commands when IPC works.

## Extension connection

If the intended extension is still disconnected after the applicable setup above,
run `bsk doctor` on the Agent's machine using the same daemon environment and
follow its failure hints. A disconnected extension does not prove it is missing.
If installation or browser-side connection steps are needed, direct the user to
the [extension setup guide](https://github.com/Tencent/BrowserSkill/blob/main/AGENT_INSTALL.md#4-connect-the-browser-extension).
After setup or repair, rerun `bsk doctor` with the same environment and address
any remaining `fail` checks before starting a session.
