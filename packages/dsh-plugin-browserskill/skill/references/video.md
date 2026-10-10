# Video recording

The browser extension's Features → Video recording page can record an authorized
task tab as a silent MP4. The user selects the task and fixed tab, starts capture,
then previews and saves the video in the extension. Closing the popup does not
stop capture. Stopping video does not stop the task.

This plugin does not expose a video action in its injected tool schemas yet.
Do not invent a video tool or start another process to bypass that boundary.
When video is requested in this harness, explain the extension workflow and let
the user control the recording while the authorized browser task continues.

The recorded tab stays fixed across navigation and tab switching. The default
limit is 60 seconds, with a 10-minute maximum; audio is omitted. Recordings remain
in the browser for 24 hours, including after task teardown. Interruptions may
produce partial videos. The preview distinguishes partial results and files
waiting to be saved. Save As writes to the browser's computer, including when
the harness runs remotely. A crash may lose the last incomplete fragment.

Before ending a task whose complete video is still wanted, let the user stop
recording in the extension; otherwise task teardown produces a partial result.
