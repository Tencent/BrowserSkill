# Pinning the extension allow-list

By default the daemon accepts any WebSocket upgrade whose `Origin` looks
like a Chrome extension origin: `chrome-extension://` followed by exactly
32 characters in `a`–`p`.

That is a **shape check, not an identity check**. Any extension on the same
machine can present a well-formed origin, so on a shared or lightly managed
host a side-loaded extension only has to guess the loopback port to reach the
daemon. The popup remains the consent surface for a *session*, but it is not
a gate on *reaching the daemon at all*.

`--allowed-extension-id` closes that gap by pinning the endpoint to specific
ids.

## Pin the list

```bash
bsk daemon restart --allowed-extension-id <id> --allowed-extension-id <id-2>
```

The flag is repeatable. Each value must be a Chrome extension id — 32
characters drawn from `a` to `p`. Malformed ids are rejected at parse time so
a typo cannot produce a daemon that runs but that no extension can reach.

For hosts where the daemon is started by a supervisor and CLI flags are
awkward, use the environment instead:

```bash
BSK_ALLOWED_EXTENSION_IDS=<id>,<id-2>
```

Explicit flags win over the environment, so an inherited variable never
silently widens an invocation you typed by hand. Blank entries are ignored; a
value with no usable id is treated as "no pinned list" rather than "reject
everything", so an empty variable cannot lock you out of your own daemon.

## Find your extension id

The id is shown in the extension's popup, and in `chrome://extensions` with
developer mode enabled. It is not a secret — it ships in the extension
manifest — so pinning it adds no key-management burden.

## Behaviour

| Configuration | Origin gate |
|---|---|
| No flag, no env | Any well-formed `chrome-extension://` origin |
| One or more ids pinned | Only the pinned ids |
| Pinned list + `--insecure-origin` | Any origin (escape hatch wins) |

The escape hatch is deliberate: `--insecure-origin` is an explicit local
debugging switch, and having a pinned list silently override it would strand
an operator mid-diagnosis.

## Scope

The list applies to the local endpoint and to the remote gateway's upgrade
check, which share one predicate. In remote mode the device credential remains
the primary gate — the allow-list is an additional restriction, not a
replacement for it. A remote daemon with a pinned list accepts only the pinned
extension ids **and** a valid device credential.

## Verify it

A pinned daemon admits the listed id and refuses a different, well-formed one.
`crates/bsk-cli/tests/extension_id_allowlist.rs` covers both directions plus the
unpinned default, and `daemon::ws` unit tests cover the predicate directly.
