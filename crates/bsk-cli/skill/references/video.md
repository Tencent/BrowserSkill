# Video recording

Use video only when the user requests visual recording or reproduction evidence.
It records one authorized task tab as MP4/H.264, without audio. It is separate
from `bsk record`, which records semantic actions. Do not run both in one session.

```sh
bsk video start --session <session_id> --tab-id <tab_id> --duration 60s --quality standard --json
# Continue the task; start returns after the first encoded frame.
bsk video status --recording <recording_id> --json
bsk video stop --recording <recording_id> --json
bsk video save --recording <recording_id> --out <explicit-path.mp4> --json
```

Retain `recording_id` from start. Choose a task-created or borrowed tab. Omitting
`--tab-id` resolves the task's active tab once; later tab switches do not change
the capture. Navigation, reload and history navigation within that tab continue
recording. Default limit: 60 seconds; accepted range: 1 second to 10 minutes.
`--max-duration` is an alias for `--duration`.
`standard`: up to 1280 pixels / 15 fps; `clear`: up to 1920 pixels / 30 fps.
One video can record per browser. Start fails explicitly if H.264 is unavailable.

Confirm the user's desired destination before exporting unless they already
specified it. There is no implicit output path. `stop --out <path>` combines stop
and save; `--overwrite` is required to replace an existing file. The CLI writes
on its own computer, which may differ from the browser's computer. The extension
preview's Save As writes on the browser's computer.

Stop the video before stopping the task when a complete result is required.
Stopping video leaves the task active. Duration and size caps stop automatically;
subsequent `stop` calls are safe. Status and stop remain available while a page
action is waiting. A stopped artifact does not require its original task to exist.

Task teardown, closing the captured tab, disconnects and capture failures preserve
a playable partial result when possible. Always inspect `state`, `completeness`,
`stop_reason` and `error`. A saved partial video is still partial: stop/save prints
the result and exits with status 1. Do not claim success merely because a file exists.

```sh
bsk video list --browser <instance_id> --json
bsk video save --browser <instance_id> --recording <recording_id> --out <path.mp4>
bsk video discard --recording <recording_id>
```

Use `list` to recover a lost start response or discover a recording started in
the extension. Omit `--recording` only when exactly one artifact matches. Stored
videos belong to the original browser connection; reconnect that same browser
to retrieve them. They expire after 24 hours. Browser storage is bounded; save
and explicitly discard older videos when full. Never delete unsaved evidence
just to make a new capture start. A crash may lose the last unfinished fragment.

The extension offers preview, download and deletion under Features → Video
recording. Its own control overlay is omitted. During extension confirmation or
human-help UI, recording shows a neutral waiting screen until the overlay closes.
