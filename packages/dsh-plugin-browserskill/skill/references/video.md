# Video recording

When the user asks to record a task, control recording yourself through
`browser_inspect` with `action: "video"`. The user does not need to race to the
extension's Start button. Record only when requested. Video is separate from
semantic interaction recording, which remains unsupported by these tools.

1. Start a session without an initial URL. For an existing page, borrow its tab
   first using the normal authorization flow. Retain the session and tab IDs.
2. Start recording and wait for `recording.state: "recording"` before navigating
   or performing task operations. A start error must be reported before proceeding
   without video; never imply that capture is active after an error.
3. Execute the task on that fixed tab. Navigation/reload remain recorded; switching
   tabs does not move capture. Start is nonblocking after the first encoded frame.
4. Before stopping, wait for navigation to settle and the expected final page
   state (such as its result element), then observe to confirm the outcome. An
   action returning does not guarantee that asynchronous page updates have finished.
   Stopping during unresolved navigation produces a partial result even if the
   task action succeeded. If the page fails to settle, stop and report incomplete
   capture rather than waiting indefinitely.
5. Stop recording before stopping the session, on success or failure. Inspect
   `state`, `completeness`, `stop_reason` and `error`, then report the result.

```text
browser_session({ action: "start" })
browser_inspect({ action: "video", videoAction: "start", session: "<sessionId>", durationMs: 60000, quality: "standard" })
// Retain recording.recording_id. Navigate and perform the task only after start succeeds.
browser_inspect({ action: "video", videoAction: "status", recordingId: "<recording_id>" })
// Wait for navigation and the expected final page state before stopping.
browser_inspect({ action: "video", videoAction: "stop", recordingId: "<recording_id>" })
browser_session({ action: "stop", session: "<sessionId>" })
```

The result is a silent H.264 MP4. Default limit: 60 seconds; range: 1 second to
10 minutes. `standard` targets 1280 pixels / 15 fps; `clear` targets 1920 / 30 fps.
Choose a limit appropriate to the requested task. A duration/size limit stops the
video, not the task: do not call a capped video a recording of the entire task.
One video can record per browser. A start error includes a stable `requestId` for
retrying the same session/options if the reply was lost. A recovered recording
that has already stopped is not an active recording; inspect it before continuing.

## Preview and explicit export

Tell the user to open Features → Video recording → Recent recordings in the
extension to preview, seek, and Save MP4 as. Stopping video leaves the task running;
closing the popup does not stop recording. No save-location question is needed to
start recording or keep its result for preview.

Export through the tool only when the user specifies a destination; ask if needed:

```text
browser_inspect({ action: "video", videoAction: "save", recordingId: "<recording_id>", output: "<explicit-path.mp4>" })
```

Tool export writes on the harness host, which may be remote. The extension's Save
As writes on the browser computer. Replacing an existing file requires explicit
permission and `overwrite: true`. A partial stop/save is a tool error containing
the recording metadata and any saved path. Use status to inspect it; a file's
existence does not make the recording complete. Unsupported capture/encoding fails
explicitly; do not silently switch to another browser or recording method.

Status, stop and list remain available during navigation or human help. After
session teardown, use the recording ID to inspect or save the preserved video:
artifact access is independent of the live task. `videoAction: "list"` lists only
recordings started by this plugin instance; optional `session` filters that list.
`videoAction: "discard"` with `recordingId` deletes a stopped browser copy only when
requested. Never delete unsaved evidence merely to start another capture.

Browser copies last 24 hours, including after task teardown. Closing the tab,
disconnects or ending the session before stopping video may preserve a partial
result. Network error pages or PDF viewers may also end as partial if clean
capture cannot resume. Unresolved navigation has a 60-second fallback; the selected
duration limit can stop it sooner. A crash may lose the last incomplete fragment.
After a plugin reload, or for recordings started manually, use the extension
library to preview and save.
Interactive confirmation/help UI is replaced by a neutral waiting screen in video.
