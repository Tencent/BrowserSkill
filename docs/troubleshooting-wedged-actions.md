# When actions time out but everything looks connected

A connection state that is easy to misread: `bsk browsers` lists the browser,
`bsk doctor` reports every line `ok`, metadata commands like `bsk tab list`
still answer — but anything that actually drives the page times out.

```sh
$ bsk session start
error: session creation timed out waiting for extension
$ bsk evaluate "1+1" --session <id>
error: operation timed out
details: tool RPC timed out after 30s
```

The instinct is to blame the extension, because "connected" is the only state
the CLI shows you. It is worth checking the daemon log before you start
reloading things.

## The log signature

```sh
bsk logs | tail -40
```

Look for a handshake first-frame timeout paired with a climbing `generation`
for a **single** `instance_id`:

```json
{"message":"browser connected","id":"23841dec","generation":5}
{"message":"client did not send handshake in time; dropping connection","timeout_secs":5}
{"message":"ws connection error","error":"handshake first-frame timeout"}
{"message":"browser reconnect: replacing previous registration","old_generation":9,"new_generation":10}
{"message":"browser connected","id":"23841dec","generation":10}
```

This is one extension control plane failing to speak in time and being dropped,
then reconnecting into the same slot — not two browsers racing for one id.
`id` staying constant while `generation` increments is the tell.

The 5-second deadline is `HANDSHAKE_FIRST_FRAME_TIMEOUT` in
`crates/bsk-cli/src/daemon/ws.rs`. It exists so a client that completes the
WebSocket upgrade and then goes silent cannot pin a task and a socket forever.
A service-worker cold start under load can miss it. The extension then
reconnects with exponential backoff (`DEFAULT_INITIAL_DELAY_MS` 1s rising to
`DEFAULT_MAX_DELAY_MS` 5s in `apps/extension/src/transport/ws-transport.ts`).

Because each successful reconnect replaces the registered `BrowserClient` under
the same `instance_id`, an action RPC issued while the control plane is cycling
can be waiting on a connection that is already being replaced. That is why the
failure looks like a timeout rather than a clean "disconnected" error — the
registry has a live entry the whole time, so nothing reports a lost connection.

## What this is not

- **Not the daemon.** `bsk daemon restart` does not change the outcome, and
  starting a second daemon is not a fix — a stale published endpoint shows up
  in `bsk doctor` as a port/endpoint problem instead, which looks different.
- **Not necessarily another browser.** This signature is produced by one
  `instance_id`. If you see two different ids in the log, that is the separate
  multi-instance situation tracked in
  [#272](https://github.com/Tencent/BrowserSkill/issues/272) and
  [#246](https://github.com/Tencent/BrowserSkill/issues/246).
- **Not a stuck CDP session.** That failure returns `browser rejected the
  underlying CDP call` / `Debugger is not attached to the tab`, which is
  [#272](https://github.com/Tencent/BrowserSkill/issues/272). A plain
  `operation timed out` with no CDP error is this document instead.

## What to try

In rough order of cost:

1. **Check load.** Close unrelated heavy tabs and processes, then retry once.
   The deadline is five seconds; anything starving the browser process makes a
   missed handshake more likely.
2. **Reload the extension** on `chrome://extensions`, then re-run `bsk doctor`.
3. **Restart the browser** if reloading does not settle it, and confirm
   `generation` stops climbing in `bsk logs`.
4. **Keep metadata commands out of the critical path** while diagnosing:
   `bsk status` and `bsk browsers` read registry state, so they keep working
   during the window and are not evidence that actions work.

If `generation` keeps climbing after a browser restart on an otherwise idle
machine, that is worth reporting. Include the `bsk logs` slice above, the
browser name and version, and whether the extension is installed in more than
one profile of that browser.

## Why this page exists

Every state the CLI prints — `connected`, `doctor: ok`, `browsers: 1` — can be
true while actions are unusable, so the symptom points at the extension by
default. The log line that actually distinguishes this case is not surfaced in
the summary output. Until it is, this is the thing to check first.
