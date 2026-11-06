# Local browser pairing

Local pairing is optional. Fresh installs, existing users and independent CLI or
extension upgrades can keep using an unpaired local connection. The popup shows
**Connected · Unpaired**, explains the identity risk and offers **Pair**. Its
circled warning icon opens the [official security overview](https://browserskill.weixin.qq.com/#security).
There is no migration deadline or required upgrade order for unpaired local use.

## Why pair?

An unpaired connection does not prove who is at the other end. Malicious local
software may impersonate a daemon or browser peer. Pairing adds mutual identity
proof before browser registration or tool traffic. It is an optional security
improvement; leaving it off retains the impersonation risk.

An existing pairing never falls back automatically when verification fails,
including when a peer claims to be an old daemon. Saved candidate keys are also
verified because the daemon may already have committed the pairing. A failed or
expired unused link does not disable an otherwise unpaired connection.

## Pair and verify

1. Run `bsk daemon pair` with the same `BSK_HOME` used by your agent. It reuses the
   running daemon or starts one through the normal auto-start path. If your host
   sets `BSK_AUTO_START=0`, start the host-managed daemon first; the command reports
   that requirement instead of printing an unusable link.
2. Open the extension's connection settings and paste the complete link into
   **Pairing link**. Local and remote links select the appropriate tab automatically.
3. Save and wait for **Connected · Verified**. Normal restarts and upgrades retain
   the pairing. You do not need to pair before every task.

Trying to pair uses a separate verification connection; a rejected or expired
link leaves the existing connection available. Successful pairing switches to the
verified connection. If either component predates pairing, update it when you
choose to pair; ordinary unpaired use does not require that update. An old
extension keeps working but cannot show the new popup warning until updated.

A local link looks like `ws://127.0.0.1:52800/#bsk-local.v1.…`. It includes the
port and a one-use secret. Keep it private. Unused links expire after five minutes.
Activation changes the key before the browser becomes available, so the original
link cannot open another connection.

The extension retains up to eight daemon identities. Independent `BSK_HOME`
directories have different identities and need separate pairings. Changing a
port does not change a daemon's identity. Once the browser has an active pairing,
connecting it to another daemon requires pairing with that daemon or explicitly
skipping verification; an unknown peer cannot turn verification off.

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
daemon causes a bounded wait and an error. Do not edit `local-pairings.json` by hand.
When a pre-pairing daemon rejects these IPC methods, existing remote server
management continues through its separate, file-locked remote grant store. If
local pairings also exist, use a current daemon for `revoke --all`.

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
Staged links without a saved candidate expire after ten minutes in the extension.
Once a candidate is saved, both keys survive cleanup and startup until authenticated
recovery succeeds; elapsed time cannot prove whether the daemon committed it.
If the daemon never committed the interrupted pairing and its link expired, paste
a fresh link from the same daemon. The extension retains the earlier candidate
until a new pairing has committed. If the daemon reports `already_paired`, retry
the original link to recover its candidate or issue an explicit replacement.

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

## Compatibility and security boundaries

The CLI defaults to **Warn**: unpaired local connections remain available without
an authentication probe. The extension uses the same rule for fresh installs and
upgrades. Eligibility flags, previous versions and compatibility deadlines do not
control whether an unpaired browser can connect.

After activation, an unverified connection cannot claim that paired browser's
identity, including after its key is revoked. This does not force unrelated old
extensions to pair. Explicit TrustLocal mode bypasses this protection; the daemon
and extension both retain their separately confirmed bypass controls.

Users who want to reject every unpaired connection can explicitly run
`bsk daemon trust-local off`, which selects **Required**. Neither installing nor
pairing a browser automatically enables that policy for other browsers.

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

## Release validation

Extension 0.4.3 introduces optional pairing and removes obsolete migration state
while retaining unpaired access. CLI and extension updates can arrive independently.

Before release, verify new and upgraded profiles against both pre-pairing and
current daemons, plus paired reconnect, candidate recovery, revocation and explicit
Required/TrustLocal modes. Validate the Chrome and Edge store builds on supported
platforms. Publishing a store version is not evidence that every user has updated;
there is no automatic enforcement stage in this plan.

For process-level integration tests, build the CLI and set `BSK_TEST_BINARY` to
its absolute path when running the extension's `local-auth-daemon.test.ts` test.
Set `BSK_TEST_OLD_BINARY` to a pre-pairing executable for the legacy compatibility
test. Tests use temporary homes and random ports; never point them at a user's
running daemon or reuse the user's browser profile.
