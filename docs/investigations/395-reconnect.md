# Investigation: extension reconnect silence after a daemon restart

Status on 2026-10-17: **not reproduced; root cause unconfirmed**. Related issue: [#395](https://github.com/Tencent/BrowserSkill/issues/395). The investigation and optional extension-side diagnostics are intended to advance the diagnosis and eventual fix of #395. Their immediate purpose is to capture the missing extension-side evidence during a real failure so a targeted fix can be developed and verified. The current contribution does not yet resolve the reported failure.

## Reported failure and remaining environment differences

The reporter measured a daemon-ready to browser-connected gap of approximately 11 minutes on Windows with bsk 0.3.2 and the official Edge extension. Connection resumed after the popup connection setting was toggled. The daemon was reachable, and its logs had no browser-connected event during the gap. These daemon logs do not establish the extension's worker, alarm or physical socket state.

The reporter's setup used the Edge store extension, Windows build 26300.9550, Edge 155.0.4283.45, a weeks-old default daemon home and a persistent foreground daemon host. Local tests used an unpacked official 0.3.2 ZIP and isolated test data. Local Windows/Edge builds changed during the investigation. The exact store-extension build and existing extension state have not been replicated.

The host's Job Object breakaway refusal (`os error 5`) is a separate daemon auto-start issue. Tests below started the daemon explicitly; they do not validate client-triggered auto-start on that host.

## Real Windows daemon and sleep cycles

All six local cycles reconnected automatically, with no active test session and without opening the extension popup or worker DevTools during the observation window.

| Condition | Daemon ready to first browser connection |
|---|---:|
| Awake, measured stop/restart interval about 73 seconds | 1.579 s |
| Awake, interval about 45 seconds | 0.251 s |
| Awake, interval about 120 seconds | 8.462 s |
| Daemon stopped before short sleep, about 10m26s sleep | 2.071 s |
| Connected before about 10 minutes sleep; daemon exited after resume and was restarted | 3.943 s |
| Connected before about 10h13m sleep; daemon exited after resume and was restarted | 0.061 s |

The overnight cycle was **not** an equivalent overnight daemon outage: its daemon exited after resume, approximately 75 seconds before ready. Sleep duration, time without log lines and actual process downtime are different measurements. It does not isolate the reporter's inferred 13.5-hour interval. Earlier local builds were Edge 155.0.4283.45 / Windows 26200.9457; later tests used Edge 155.0.4283.60 / Windows 26200.9711.

## Controlled physical and application handshake faults

A loopback protocol peer accepted connections from the actual installed extension worker. It replied to the application handshake and observed heartbeat frames; it did not issue browser-operation commands. This was a test peer, **not the real daemon**. Popup and worker DevTools remained closed during fault observation.

| Fault injected once | Official 0.3.2 worker | Diagnostic 0.3.2 worker |
|---|---|---|
| HTTP Upgrade withheld; later attempts allowed | Close at 240.004 s; new handshake replied at 242.014 s | Close at 240.001 s; new handshake replied at 242.009 s |
| Application handshake reply withheld | Client close at 10.006 s; recovery at 11.015 s | Client close at 10.004 s; recovery at 11.017 s |

Each recovered connection produced continuing heartbeats. These faults did not reproduce the reported prolonged failure. A normal-page WebSocket experiment had similar timing but was kept separate from the actual MV3 worker evidence.

During the diagnostic worker's physical wait, persistent events showed eight actual alarm callbacks roughly 30 seconds apart. Each was followed by a controller request with `state=connecting`, `gate=transport-state`, `transition=false`, and `cleanupNeeded=false`. There was one socket attempt in that window, followed by native error/close and a scheduled retry. One additional controller request lacked an adjacent alarm event; its source was not identified.

This explains one local silent-endpoint window: the worker was active and checking, while an existing physical attempt prevented concurrent connections. It does **not** explain the reporter's 11-minute gap.

## Diagnostic persistence and observation limits

The user exported two local diagnostic snapshots around a real extension reload. The first contained 189 events; the second contained 203, retaining every first-export event exactly and adding a new worker boot identity. Reported storage failures and dropped events were zero. Five paired internal/endpoint events aligned within 1 ms. This validates the experimental recorder in that scenario, not every worker eviction or crash path.

The experimental build was separately named, always recorded and used fresh extension storage. The proposed general feature is default-off and uses normal build provenance. No successful run establishes that recording has no scheduling effect. New unpacked IDs, old store state, unavailable storage and natural idle termination remain relevant differences. An empty/stale diagnostic snapshot cannot prove inactivity.

## Cleanup-chain hypothesis

External probes used the actual controller, transport, session manager and session-stop functions, replacing only storage/socket/Chrome boundaries. They advanced **11 minutes of simulated time**, with 22 callbacks through the actual registered alarm handler; no real user tabs or windows were manipulated.

- With zero local sessions, session browser cleanup APIs were not called and reconnection completed.
- With one local session, holding `windows.get`, `tabs.move`, `tabs.remove`, `tabs.query`, or `windows.remove` pending blocked cleanup and reconnect. The popup connection toggle did not bypass that pending transition. Completing the same original API promise then allowed cleanup and recovery.
- The actual Chromium CDP wrapper already bounded a pending native debugger detach with its 1000 ms cleanup wait.
- A rejected window removal remained retryable; the next alarm retried cleanup and recovered.

Eight characterization probes and 115 related existing tests passed. Injecting a pending API proves a conditional blocking path, not that Edge actually hung there. No daemon session does not prove an empty local extension session list. Nevertheless, this simple pending-cleanup hypothesis does not match toggle-based recovery and is not sufficient justification to skip safe cleanup or add an arbitrary timeout.

## Next evidence and contribution scope

Before repeating ordinary restart/sleep cycles, capture extension-side boot, alarm, socket and gate events during a real failure and correlate them with daemon logs. Preserve the current installation/state where possible. Avoid opening DevTools or toggling the connection until stored observations have been exported.

To advance #395 toward a verified fix, the contribution provides [optional bounded diagnostics](../connection-diagnostics.md), regression coverage for the recorder/control lifecycle, and this investigation record. The next step is to correlate events from a real failure with daemon logs, identify the cause, and add a targeted regression test and fix. Retry delays, handshake deadlines, cleanup ordering and keepalive policy remain unchanged at this diagnostic stage. Keep #395 open until the reported failure has been addressed and the fix verified.
