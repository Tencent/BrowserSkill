# BrowserSkill in a sandboxed agent

Some agent environments end a command by terminating its child processes,
including detached daemons. Linux WorkBuddy users reported this with its
bubblewrap-based Bash sandbox in [issue #214](https://github.com/Tencent/BrowserSkill/issues/214).
In such an environment, keep the daemon in a persistent host execution context
and run browser commands inside the sandbox over shared local IPC.
The same setup applies to Windows agents whose shell tasks terminate child processes.

Ordinary local use still auto-starts the daemon. No sandbox detection, service
installation or global change to home-directory resolution is required.

## Windows background startup

On Windows, background startup inherits only dedicated standard handles and
requests breakaway from the launching process's Job Object. The daemon is
resumed only after verifying it belongs to no Job, including outer Jobs in a
nested hierarchy. The command returns success after verifying local IPC; its
captured stdout and stderr can reach EOF independently of the daemon lifetime.

A host that prohibits breakaway cannot launch an independent background daemon
through this path. `bsk daemon start` and implicit startup return a bounded
error with setup instructions instead of retrying as a host-owned background
process. An already reachable daemon is still reused, even from a restrictive
Job. Use the persistent host setup below when breakaway is unavailable.

`--foreground` deliberately remains owned by its host task. Run that task
outside the per-command Job and keep it alive; the flag does not bypass Job
termination. Breakaway is also not a guarantee against an explicit process-tree
kill or host shutdown. Windows Job termination does not give a daemon an
opportunity to log a shutdown reason.

Query commands retain their existing automatic-start behavior. Set
`BSK_AUTO_START=0` for probes that must not start a daemon, regardless of whether
stdout is a terminal or a pipe.

The startup deadline limits how long the initiating command waits. It does not
cancel a running daemon: another caller may already be using that service, or
it may finish publishing immediately after the deadline. Initialization errors
exit in the daemon itself; use `bsk daemon stop` for an explicit shutdown.

## 1. Reuse or choose the daemon directory

For an existing daemon, reuse its `BSK_HOME` and OS user, or its default directory
if the variable was unset. Do not choose a new directory to work around a failed
status check or an occupied lock. For a new setup, choose a dedicated, persistent
directory owned by the user running the daemon.
Replace `/absolute/shared/bsk` below with its actual absolute path. It does not
have to be under the user's home directory.

The host and sandbox must see the same underlying directory at the path used
by the daemon, including `daemon.json` and `run/daemon.sock` on Unix. Matching
environment-variable text alone is insufficient if the mounts differ. Configure
the host's filesystem and IPC access rules to allow the sandbox to reach it;
retain the directory's private permissions rather than making it world-writable.
This is a local IPC arrangement, not a connection to a separate remote machine.

`BSK_HOME` overrides the default daemon directory. Without a non-empty override,
bsk keeps using the platform's normal home-directory lookup. On Unix, an unset
or empty `HOME` may fall back to the current UID's account record; it does not
necessarily select the directory that the agent's user expects. Configure
`BSK_HOME` explicitly on both sides instead of guessing a username or changing
the process's global `HOME`.

## 2. Check for an existing daemon

From the agent's command environment, disable implicit startup and check the
existing directory before launching anything:

```bash
BSK_HOME=/absolute/shared/bsk BSK_AUTO_START=0 bsk status --json
```

For PowerShell, replace `C:\path\to\shared\bsk` with that same actual directory:

```powershell
$env:BSK_HOME = 'C:\path\to\shared\bsk'
$env:BSK_AUTO_START = '0'
bsk status --json
```

- **Status succeeds:** reuse this daemon. An empty `browsers` list means IPC is
  ready but the extension has not connected; it does not call for another daemon.
- **Daemon missing / automatic startup disabled:** check whether a host task is
  already starting it. If so, follow the readiness check below; otherwise start
  one using Step 3.
- **Permission error, timeout or invalid reply:** inspect the reported path,
  host task and IPC access. These errors do not establish that the daemon is absent.

Keep the same directory and `BSK_AUTO_START=0` in all later client calls. A
successful check lets you skip Step 3 and continue with Step 4.

## 3. Start only when needed, then verify readiness

If the agent host provides a persistent background-task facility, let that task
own the foreground daemon outside the per-command sandbox, using the directory
checked above:

```bash
BSK_HOME=/absolute/shared/bsk bsk daemon start --foreground
```

For Windows hosts using PowerShell, set the same directory in that host task:

```powershell
$env:BSK_HOME = 'C:\path\to\shared\bsk'
bsk daemon start --foreground
```

Keep the host task running across subsequent browser commands. `--foreground`
keeps the daemon attached to that task; it does not make an ordinary short-lived
shell persistent. If no persistent task facility is available, the user can
instead start the daemon from a normal host terminal:

```bash
BSK_HOME=/absolute/shared/bsk bsk daemon start
```

In PowerShell, set `BSK_HOME` as above and run `bsk daemon start`.

**Verify readiness in a separate shell tool call.** Repeat Step 2's status check
from the agent environment. During startup, allow at most five checks with
one-second pauses for a missing endpoint, a discovery race or a transient timeout.
Stop on permission or protocol errors. Continue only after a successful status
response; creating a background task or seeing its process ID is not proof that
IPC is listening.

If the host task exits or the checks never succeed, inspect its output and run
`bsk logs` with the same `BSK_HOME`. Recheck status with `BSK_AUTO_START=0` before
considering another launch: a second foreground process can fail to acquire the
lock while another daemon is healthy. Unlike ordinary `daemon start`, foreground
startup does not reuse a discovered daemon. Reuse it if the recheck succeeds;
otherwise resolve or report the observed error instead of repeatedly launching.
Keep runtime files and shared daemons intact.

Use the host's approved mechanism for that launch to run outside the sandbox.
CodeBuddy's [tool reference](https://www.codebuddy.ai/docs/cli/tools-reference)
documents background tasks and per-command sandbox exceptions; availability
depends on the host's settings. Do not turn off sandbox protection for all
browser commands. Verify that the chosen host task survives subsequent shell
commands. Cancelling that task or shutting down its host can still stop the
daemon; bsk cannot make a process outlive the environment that owns it.

Start and stop the shared daemon in this owning environment. Browser task
cleanup is `bsk session stop`, which leaves other sessions and the daemon alone.
The daemon's existing idle-exit behavior is unchanged: with no connected
browsers, active sessions or IPC clients, its default idle timeout is 10 minutes.
If the host workflow needs a longer idle window, pass the existing `--daemon-idle`
option when starting it, for example `--daemon-idle 2h`. After an idle exit, start
it again from the host before the next sandboxed command.

## 4. Connect from every sandboxed command

Set both variables on each shell invocation, or use the host's documented
persistent environment configuration. A previous `export` may not carry over
to the next shell tool call.

```bash
BSK_HOME=/absolute/shared/bsk BSK_AUTO_START=0 bsk doctor
BSK_HOME=/absolute/shared/bsk BSK_AUTO_START=0 bsk session start
```

In PowerShell, set the same directory and disable implicit startup in every
shell invocation, or configure both variables persistently in the agent host:

```powershell
$env:BSK_HOME = 'C:\path\to\shared\bsk'
$env:BSK_AUTO_START = '0'
bsk doctor
bsk session start
```

Retain the session ID. In a separate shell invocation, replace `SESSION_ID`:

```bash
BSK_HOME=/absolute/shared/bsk BSK_AUTO_START=0 bsk navigate https://example.com --session SESSION_ID
BSK_HOME=/absolute/shared/bsk BSK_AUTO_START=0 bsk snapshot --session SESSION_ID
BSK_HOME=/absolute/shared/bsk BSK_AUTO_START=0 bsk session stop SESSION_ID
```

In PowerShell, repeat the two environment assignments before the same `bsk`
commands; do not use the Unix `NAME=value command` syntax.

`BSK_AUTO_START=0` disables **implicit** startup by browser commands and doctor.
It still connects to a working daemon. When discovery is missing or no endpoint
is listening, it reports the problem and asks for host-side startup. It does not
spawn a replacement or remove runtime files. Only the value `0` opts out;
leaving the variable unset or setting it to `1` retains normal automatic startup.
Explicit `bsk daemon start`, `stop`, `restart`, and update operations retain their
existing management behavior; the variable is not a prohibition on those commands.
Doctor retains its existing directory preparation and skill checks.

## Diagnostics and recovery

- **Automatic startup disabled:** check any existing host startup task, then
  follow Steps 2–3 with the same `BSK_HOME`. Do not repeatedly start a daemon
  inside a sandbox that will reap it.
- **Directory or permission error:** check the exact resolved path and operation
  in the error. Configure `BSK_HOME` and the host's access rules for that directory
  and its IPC endpoint. There is no automatic fallback to a guessed user directory.
- **IPC available, local process identity unverified:** browser/session commands
  can continue. Another PID namespace or unavailable peer-identity information
  may prevent local signal-based management. Run daemon management commands in
  the environment that owns it. This warning does not itself fail doctor.
- **IPC timeout or invalid reply:** inspect the daemon from its owning environment.
  These errors do not authorize another automatic startup. Keep runtime files.

An RPC shutdown mechanism is not part of this setup. Do not disable PID identity
checks or delete lock files to work around a refused stop.

## Verify the host integration

1. Reuse an existing daemon, or start one outside the command sandbox after the
   checks above. Confirm status works from a separate sandboxed tool call with
   the same `BSK_HOME` and `BSK_AUTO_START=0`.
2. Create a browser session, let that shell invocation finish, then navigate and
   take a snapshot in another invocation using the same session ID. Confirm the
   daemon instance in `daemon.json` has not changed.
3. Stop only that session. Confirm another status call still reaches the daemon.
4. In a controlled setup with no other active sessions, stop the daemon from its
   owning environment. The next sandboxed command must report it unavailable
   without starting a new daemon. Restart it from the host when needed.

This check validates the host's actual process lifetime and IPC permissions.
Successful local CLI tests alone do not establish that a particular WorkBuddy
version or configuration keeps its background tasks alive.
