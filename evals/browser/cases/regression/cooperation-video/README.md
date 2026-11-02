# Continuous video progress and cooperative actions

This regression runs the actual CLI, daemon, extension and an isolated Chromium profile.
The fixture loops a bundled synthetic WebM in a real video element. No remote media, live
recording, or existing browser profile is required. A separate CDP connection checks decoded
frames, received key events and the final paused state independently of the CLI response.

Build and run from the repository root, using a cooperative CLI build:

```sh
BSK_DAEMON_WS_URL=ws://127.0.0.1:52931 pnpm --filter @browser-skill/extension build
BSK_COOP_CLI=/path/to/bsk \
BSK_COOP_CHROME=/path/to/chromium \
node evals/browser/cases/regression/cooperation-video/run.mjs
```

`BSK_COOP_PORT` must match the built extension's endpoint and must not be the normal daemon
port 52800. `BSK_COOP_EXTENSION` overrides the built extension directory. Chrome for Testing
uses `Extensions.loadUnpacked`; use `BSK_COOP_LOAD_CDP=0` with builds that support the load
extension command-line flags instead. `BSK_COOP_ARTIFACTS` selects the result directory.

The 53 cases cover continuously advancing progress during sync (including incremental sync),
dependencies without a focus target, ordinary business sliders, submitted timelines,
form-owned timelines, simultaneous video and order changes, and a programmatic focus change.
They also combine PR #497's learned-text behavior with the media fix: a learned price becomes
exact again when it belongs to the current target or an explicit dependency, bare keys remain
strict, a refused context cannot be replayed, and an explicitly observed timeline stays exact.
Review regressions cover price changes around the actual keyboard focus despite unrelated
dependencies, child `<source>`/effective source changes, and a pause button beside its labelled
timeline in one player region. Controls declare the timeline or whole player, focus the timeline,
or change a business field in the same player. Focus changes before a delta sync must refresh
semantic evidence, and a document becoming an explicit keyboard recipient revokes the key.
Closed shadow-root players also allow progress but reject a source change with or without
a simultaneous timeline update. Form-ownership cases keep the timeline's accessible name
while removing the form from the semantic tree (`role=none`, `role=presentation`, and
`display:contents`). They cover native form owners, external `form` associations, open and
closed shadow roots, custom progress widgets, and formless positive controls. The oracle
asserts the actual form owner and accessible name before changing the value, so losing a
label cannot accidentally make a negative case pass.
Positive cases require one received Space event
and a paused video. Negative cases require no key event, no simulated purchase, no pause call and
`effect_state: none`. Every created session, daemon and temporary browser profile is cleaned up.

A dependency must still cover the action's actual decision. A key without a target
or dependencies keeps the exact whole-page check. Targeted actions retain PR #497's bounded
text learning after a refusal and a fresh sync. Implicit keyboard recipients have their own
protected region; uncertain focus falls back to the whole page. Only positively identified,
non-submitted media progress may change incidentally; explicitly declaring the timeline,
its media element or a containing element protects that value. Ordinary fields/sliders and
unknown media controls keep the conservative behavior.

The two-second VP8 test clip can be regenerated with FFmpeg:

```sh
ffmpeg -f lavfi -i testsrc2=size=160x90:rate=24 -t 2 -c:v libvpx -b:v 120k -an preview.webm
```
