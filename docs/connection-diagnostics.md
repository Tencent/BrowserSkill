# Extension connection diagnostics

Connection diagnostics support the investigation and eventual fix of [#395](https://github.com/Tencent/BrowserSkill/issues/395). The goal is to capture extension-side evidence during a real reconnect failure, correlate it with daemon logs, and identify the cause before choosing a fix. Recorded events can help distinguish worker/alarm delivery gaps, an outstanding socket attempt, and reconnect requests skipped by the connection controller, subject to the storage and scheduling limits below. Recording is **off by default**. The reported failure remains unreproduced locally; this diagnostic step does not yet resolve it or change retry policy.

## Capture a failure

1. Open the BrowserSkill extension's **Details → Extension options** page.
2. Select **Start recording** before the observation period. Close the options page and use the browser normally. Keep the extension installed and leave its connection setting unchanged.
3. If a failure occurs, note its time. Before toggling the connection or opening worker DevTools, open the options page and select **Export JSON**. Preserve daemon logs for the same time window.
4. Use **Stop recording** when finished. It preserves the existing log. **Clear and stop** disables recording and removes only the diagnostic events.

Opening, refreshing or exporting this page reads stored data without asking the worker for a live response. Start, stop and clear are explicit control actions and may wake the worker. No diagnostic data is uploaded automatically.

## Recorded data

The extension retains at most 2048 events in local storage. Events include UTC and monotonic timestamps, worker boot identity, build provenance, a sequence number, socket generation and lifecycle, controller gates, cleanup and application-handshake outcomes, alarm delivery, and heartbeat send failures. A full ring drops its oldest entries and counts the drops. Storage read/write failures are counted when a snapshot can be persisted.

Fields and string values are allowlisted. The recorder excludes page content, tab URLs, authentication tokens, labels, arbitrary error/close text and RPC payloads. Exports still reveal operational timing and build information: inspect them before sharing.

If recording was already enabled when a worker started, its initial observation is `worker.start`. Enabling later in the same worker records `diagnostics.enabled`, not a worker restart. Stop/start within the same worker continues the sequence of retained events. A new worker has a new boot ID and retains earlier events unless they have been cleared or dropped from a full ring.

## Limits

Diagnostic storage operations can affect worker scheduling, so a failure disappearing while recording is enabled does not prove that it is fixed. An empty or old snapshot does not prove that no connection attempt occurred; writes may have failed or the worker may not have run. Clearing waits for already-issued diagnostic writes before removing the log, so a stalled storage operation can delay that explicit command.

A disconnected daemon log at INFO level does not distinguish all socket, worker and controller states. Correlate the exported events with the daemon timeline. A new unpacked extension gets a different extension ID and fresh storage, which may hide a problem in an existing store installation. Keep that difference explicit when comparing experiments.

These controls do not add permissions, network requests, polling, keepalive or reconnect timers. The local enabled preference survives worker/browser restarts until recording is stopped.
