# BrowserSkill in a sandboxed agent

Some agent environments end a command by terminating its child processes,
including detached daemons. Linux WorkBuddy users reported this with its
bubblewrap-based Bash sandbox in [issue #214](https://github.com/Tencent/BrowserSkill/issues/214).
In such an environment, keep the daemon in a persistent host execution context
and run browser commands inside the sandbox over shared local IPC.

Ordinary local use still auto-starts the daemon. No sandbox detection, service
installation or global change to home-directory resolution is required.

## 1. Choose one accessible directory

Choose a dedicated, persistent directory owned by the user running the daemon.
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

## 2. Start the daemon in the owning host environment

From the user's normal host terminal, outside the per-command sandbox:

```bash
BSK_HOME=/absolute/shared/bsk bsk daemon start
```

If the agent host provides a persistent background-task facility, let that task
own the foreground daemon instead:

```bash
BSK_HOME=/absolute/shared/bsk bsk daemon start --foreground
```

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

## 3. Connect from every sandboxed command

Set both variables on each shell invocation, or use the host's documented
persistent environment configuration. A previous `export` may not carry over
to the next shell tool call.

```bash
BSK_HOME=/absolute/shared/bsk BSK_AUTO_START=0 bsk doctor
BSK_HOME=/absolute/shared/bsk BSK_AUTO_START=0 bsk session start
```

Retain the session ID. In a separate shell invocation, replace `SESSION_ID`:

```bash
BSK_HOME=/absolute/shared/bsk BSK_AUTO_START=0 bsk navigate https://example.com --session SESSION_ID
BSK_HOME=/absolute/shared/bsk BSK_AUTO_START=0 bsk snapshot --session SESSION_ID
BSK_HOME=/absolute/shared/bsk BSK_AUTO_START=0 bsk session stop SESSION_ID
```

`BSK_AUTO_START=0` disables **implicit** startup by browser commands and doctor.
It still connects to a working daemon. When discovery is missing or no endpoint
is listening, it reports the problem and asks for host-side startup. It does not
spawn a replacement or remove runtime files. Only the value `0` opts out;
leaving the variable unset or setting it to `1` retains normal automatic startup.
Explicit `bsk daemon start`, `stop`, `restart`, and update operations retain their
existing management behavior; the variable is not a prohibition on those commands.
Doctor retains its existing directory preparation and skill checks.

## Diagnostics and recovery

- **Automatic startup disabled:** start the daemon in its owning host environment
  using the same `BSK_HOME`, then retry the browser command. Do not repeatedly
  start a daemon inside a sandbox that will reap it.
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

1. Start the daemon outside the command sandbox and confirm `bsk status` works
   from inside it with the two variables above.
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
