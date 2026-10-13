# Local browser pairing

Pair each browser profile with each local bsk home once. Restarting or upgrading
bsk or the extension keeps the pairing. Local pairing uses the same loopback
WebSocket port and adds mutual proof before browser registration or tool traffic.
Remote pairing uses a separate credential and protocol.

## Pair and verify

1. Start or reuse the intended daemon, with the same `BSK_HOME` used by your agent.
2. Run `bsk daemon pair` in a terminal on that computer.
3. Open the extension's connection settings and paste the complete link into
   **Pairing link**. Local and remote links select the appropriate tab automatically.
4. Save and wait for **Connected · Verified**, then run `bsk doctor`.

A local link looks like `ws://127.0.0.1:52800/#bsk-local.v1.…`. It includes the
port and a one-use secret. Share it only with the browser being paired; do not
put it in an issue, screenshot, log, command argument or public conversation.
Unused links expire after five minutes. Activation changes the key before the
browser becomes available, so the original link cannot open another connection.

The extension retains up to eight daemon identities. Independent `BSK_HOME`
directories have different identities and need separate pairings. Changing a
port does not change a daemon's identity. Keep the browser profile and the bsk
home private; access to their credential files can grant browser control.

## Maintain devices

```sh
bsk daemon devices
bsk daemon rotate DEVICE_ID
bsk daemon revoke DEVICE_ID
bsk daemon revoke --all
bsk daemon pair --replace BROWSER_ID
```

`devices` lists local and remote records without keys. `rotate` requests a key
change on the next authenticated connection. `revoke` accepts a local device ID
or its bound browser ID. Successful local revocation closes registered sockets,
settles pending calls and removes sessions before returning. `--all` also revokes
remote grants and unused links; already completed page actions cannot be undone.

An ordinary link cannot replace an existing pairing for the same browser
instance. On `already_paired`, keep the current connection, or explicitly create
a replacement link with `--replace` if replacement is intended. The popup warns
that successful replacement ends current tasks. It verifies the staged link on
a separate connection and keeps the active pairing until the replacement commits.
A `replace_mismatch` means the link targets another browser instance; use a normal
link for a new profile and revoke an unused old device separately.

Maintenance commands use the running daemon's IPC. When the daemon is absent,
they hold `daemon.lock` while editing persistent state. A locked but unavailable
daemon causes a bounded wait and an error; commands never fall back to editing
its live files. Do not edit `local-pairings.json` by hand.

## Connection problems

| Popup or CLI state | Action |
| --- | --- |
| Pairing required / `pairing_required` | Run `bsk daemon pair` in the intended home and paste the link into that profile. |
| Service failed verification | Run `bsk doctor`; check the port and whether the bsk home was reset. Use a new link only after confirming the intended service. |
| bsk too old | Run `bsk update`, restart a host-managed daemon through its owner, then retry. Existing pairings remain valid. |
| Device busy | Wait for the other verification attempt to finish, then retry. |
| `already_paired` | Keep the current pairing, or generate an explicit replacement link. |
| `replace_mismatch` | Use a normal link for a new profile; the old device has not been revoked. |

Authentication failures back off from 30 seconds to five minutes. **Retry** starts
an immediate attempt. Interrupted activation/rotation normally resumes with its
saved candidate key and a fresh connection. A verifier retains a candidate after
an ambiguous commit reply, because deleting it could lose a successful replacement.
Uncommitted staged records expire after ten minutes in the extension.

## Explicitly skipping verification

In the extension's **Advanced** settings, **Skip local verification** requires a
confirmation. The daemon must separately allow it with `bsk daemon trust-local on`.
This permits local programs to impersonate either endpoint. The popup keeps an
unverified warning visible; `bsk doctor` warns about trust-local mode. Skipping
retains stored pairings but does not use them or send an authentication probe.

Use **Restore verification** in the extension and run
`bsk daemon trust-local off` to restore both sides. The latter selects Required
mode immediately. Agents must not enable skipping or trust-local as an automatic
response to an authentication failure.

Switching from remote to local ends current tasks but retains the remote grant.
It is not renewed while local mode is selected. Before its displayed expiry,
you can switch back without a new link; after expiry, pair with the server again.

## Rollout and security boundaries

The CLI now defaults to **Required**. Unpaired legacy handshakes are rejected
with `pairing_required`, including peers claiming an official extension Origin.
A peer must prove its local key before registration or browser control. Explicit
TrustLocal mode remains available as a bypass; doctor reports it as unverified.

The earlier distribution stage used **Warn** to keep old extensions working.
An explicitly persisted Warn setting still accepts legacy peers and now produces
a doctor warning. Run `bsk daemon trust-local off` after pairing to require
verification. Origin checks alone do not authenticate a native local program.

Extension **0.4.1** retires migration compatibility. Startup and upgrade handling
clear the previous flag, and the authentication path cannot fall back even if
an old flag remains in storage. Without explicit skipping, an old daemon, a
`legacy_accepted` hint, an unknown identity or a dropped connection cannot cause
the extension to send a business handshake without verifying the server.
Update an older CLI and pair the browser to restore the connection.

Extension 0.4.0's temporary compatibility applied only to eligible, never-paired
upgrades from earlier versions. Its migration-only popup hints are removed in
0.4.1. Existing pairing keys, pending recovery transactions and the separate
explicit skip preference survive the upgrade. Stage D must follow distribution
of the Required-mode CLI, as detailed below.

Local pairing protects the connection, not the OS account or websites. It does
not defend against a process that can read the user's browser profile or bsk
home, or against an explicitly trusted server. Local and remote credentials are
not interchangeable; remote deployments still require TLS and device isolation.

The v1 handshake does not encrypt subsequent loopback traffic or prevent a
transparent relay from reading or changing it. An attacker with both the original
pairing link and its first handshake transcript can derive the next key. A stolen
unused link can also be activated first by someone else. Keep links private and
use them promptly; these limitations require a separately reviewed encrypted
record protocol and key exchange to address.

## Release prerequisites

These are separate release gates, not evidence that a store rollout has happened.

| Stage | Contents | Must be verified before advancing |
| --- | --- | --- |
| B | CLI pairing, Warn policy, maintenance and diagnostics | Current store extensions on Chrome/Edge × Windows/macOS/Linux; automatic-update handover. |
| A | Extension 0.4.0, popup, instructions | New pairing, eligible upgrades, independent CLI/extension upgrades, replacement and revocation; include Brave and a Flatpak browser. Publish to both stores. |
| C | Change CLI default to Required | Both live store versions support pairing; test unpaired, paired and explicit skip cases against Required mode. |
| D | Extension 0.4.1 retires migration | Stage C has been distributed, including automatic updates. |

The PRs for C and D can be reviewed in the stack but must not merge or release
before their respective prerequisites. Local tests and a build do not replace
these real-browser/platform checks.

For process-level integration tests, build the CLI and set `BSK_TEST_BINARY` to
its absolute path when running the extension's `local-auth-daemon.test.ts` test.
Set `BSK_TEST_OLD_BINARY` to a pre-pairing executable for the legacy compatibility
test. Tests use temporary homes and random ports; never point them at a user's
running daemon or reuse the user's browser profile.
