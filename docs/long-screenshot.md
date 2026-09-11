# Full-page screenshots

Available from extension Quick Actions or from an Agent through `bsk screenshot --full-page`.
The capture, disk tiles and streaming PNG encoder are shared.

Open **Quick actions → Full-page screenshot** in the BrowserSkill popup. Choose:

- **Full page · Automatic**: captures from the top, scrolls incrementally and follows appended content.
- **Long image · I scroll**: captures from the current position while you scroll down. Keep overlapping
  content between screens. Reopen the popup and choose **Finish and keep** when you are done.
- **Visible area**: captures the current viewport once.

The Quick Actions feature works with the CLI connection off. It does not require the CLI, daemon or an Agent session.
After installing or reloading the extension, automatic capture reconnects the screenshot content
script in already-open pages on demand. Injection targets only the captured document and retries
once; navigation, cancellation and timeouts remain errors instead of changing capture mode.

## Agent and CLI

```sh
bsk screenshot --session <id> --full-page --out page.png
bsk screenshot --session <id> --full-page --timeout 5m --out page.png --json
```

The default viewport screenshot and `--ref` crop are unchanged. `--full-page` is exclusive
with `--ref`. An optional `--tab-id` must identify the selected tab in the session's Agent
Window; the tab must have been created or borrowed by that session. Automatic document
scrolling is transient page input and obeys the existing user-interrupt gate. It supports
scriptable HTTP(S) pages, not restricted browser pages or nested/virtualized scrollers.

Agent capture restores scroll and temporary styles on completion, failure, timeout or
cancellation. Ctrl-C cancels capture or transfer; a page navigation or tab switch stops the
capture. Unlike interactive Quick Actions, an Agent failure never returns partial success.
The capture/encoding deadline is two minutes by default and can be changed with `--timeout`.
No fixed page-height or full-image canvas limit is added. Infinite scrolling may reach the
deadline. The popup and any existing user previews are independent of Agent captures.

`bsk screenshot --full-page` uses `tool.screenshot_full_page`, followed by internal
`tool.screenshot_read` and `tool.screenshot_release` RPCs. This distinct capture method lets
the daemon gate scrolling and wait for cancellation cleanup without changing the existing
passive `tool.screenshot` route. Full-page requests use `session_id`, optional `tab_id` and
optional `timeout_ms`. Results contain dimensions, `format: "png"`, `tab_id`, `byte_size`,
optional dialogs and an opaque session-scoped `capture_id`; they contain no whole-image
base64 or agent filesystem path. Read requests use `session_id`, `capture_id` and byte
`offset`, returning at most 256 KiB encoded as `data_base64`, `next_offset` and `eof`.
Release uses `session_id` and `capture_id` and returns `released`.

The extension streams its PNG to OPFS; the CLI receives bounded chunks and atomically
replaces the chosen output only after validating the complete byte count. Existing screenshot
JSON output fields are preserved. There is no preview tab, browser download or additional
permission. Exports are released after successful saving or local failure/cancellation,
on session stop, and after ten minutes without reads. Closed-session exports are also swept
once per minute. After a worker restart, orphan Agent scratch directories are removed before
the next full-page capture; popup previews are retained. CLI or browser crashes can therefore
leave temporary disk data until this cleanup runs. Matching CLI and extension builds are
required. Restart a running daemon after updating the CLI (`bsk daemon restart`); older extensions reject the new RPC rather than returning an incorrect viewport.

## Controls and page access

Pause and resume a capture, or finish early and keep the captured portion. While automatic capture is
paused, you can load additional content; resuming returns to the captured position. Cancel discards
the current capture. Automatic captures restore the original scroll position and temporary styles
when they finish or stop. Manual mode leaves the page at the user's chosen position.

The popup's finished result belongs to its source tab and page. Switching to another webpage,
navigating the source tab, or closing it discards that popup state; returning later starts fresh.
Reopening the popup on the same page retains the result. Opening the capture's own preview does
not count as leaving the capture flow, and an already-open preview remains usable for export
after the popup state is cleared.

Keep the captured tab selected and its viewport size stable. Navigation, resizing, capture failures
and storage errors preserve durable tiles and identify the result as partial. A restarted background
worker can reopen the committed portion. Individual browser operations still have timeouts, but
there is no fixed whole-job duration, scroll count, 32K image-height or 48-megapixel cutoff.
Navigation checks observe the top-level document. Background loading of ads or other embedded
frames does not cancel an otherwise stable capture just because the tab reports `loading`.

Clicking the extension grants `activeTab` for the current tab. This enables visible-area screenshots
of Chrome internal pages and the Chrome Web Store as well as ordinary websites. These restricted
pages do not permit content-script injection. Automatic mode explains the failure and offers an
explicit **Use manual scrolling** action; it never silently changes the selected capture mode.
Browser/enterprise capture policies and user permissions still apply. Restricted-page support does
not bypass Chrome's scripting or debugger restrictions.

Manual mode matches overlapping pixels without reading the page DOM. It excludes static header
and footer bands for alignment and replaces the reliable overlap to remove old floating footers.
Blank/repeated/animated or insufficiently overlapping content may be ambiguous. In that case the
capture keeps its last good frame and asks the user to scroll back for more overlap; it never invents
a match. Independently scrolling panels, moving sidebars and virtualized layouts can still need
manual adjustment; this is not a promise of automatic capture of every browser UI.

## Storage, memory and export

New captures are a collection of 512-pixel-high PNG tiles in the extension's Origin Private File
System (OPFS), with a small durable manifest. Only the current screenshot and a small working canvas
are decoded while capturing. Appending content and replacing a footer do not allocate a full-page
canvas. Thumbnails are generated for fitting large images into the preview.

The preview mounts only visible tiles and adjacent tiles. It rebases its scrollbar for very long
images to avoid CSS element-height limits. Zooming to original size loads original tiles.
Previous single-PNG previews stored in IndexedDB remain readable.

Downloading launches a dedicated worker. It reads tiles sequentially, applies the PNG Up filter and
uses native streaming zlib compression to write PNG chunks to an OPFS file. The browser downloads
the resulting file; no full-image pixel buffer or base64 export is built. Export can be cancelled
without losing the captured tiles. There is no upload and no new third-party encoding dependency.

Disk usage grows with the capture. Browser storage quotas, available disk space, PNG format bounds
and external image-viewer capabilities remain real constraints. The preview does not decode the
entire exported PNG, so its working memory is independent of total image height. This controls the
screenshot feature's buffers, not the memory used by a webpage's own DOM or loading behavior.

## Verification

For the actual CLI → daemon → extension chain, build `bsk` and the extension, then run:

```sh
cargo build -p bsk --locked
pnpm ext:build
BSK_LONG_SCREENSHOT_CHROME=/path/to/chrome BSK_LONG_SCREENSHOT_CLI="$PWD/target/debug/bsk" pnpm --filter @browser-skill/extension exec vitest run src/long-screenshot/agent.browser.test.ts
```

This suite uses an isolated browser profile and daemon. It verifies PNG scanlines and fixed
footers, multi-chunk transfer, captures beyond 32K pixels, original page restoration, timeout,
Ctrl-C, the page Escape control, output failures and scratch-file cleanup. The regular suites cover chunk ownership,
invalid offsets, expiration, CLI flag validation and the unchanged viewport/ref routes.


The automated checks cover actual scroll-offset rounding, fixed-footer overlap, capture beyond
120 frames, early finish, cancellation, DOM cleanup, paused interaction, restricted-page errors,
streaming PNG round trips, export cancellation and disk failures. Manual alignment tests cover
fixed bars, exact pixel offsets, ambiguous repeated content and non-overlapping jumps.

Build and run the real extension in an isolated Chrome profile:

```sh
pnpm ext:build
BSK_LONG_SCREENSHOT_CHROME=/path/to/chrome pnpm --filter @browser-skill/extension exec vitest run src/long-screenshot/long-screenshot.browser.test.ts
```

The extension tests cover automatic and manual capture, popup closure, pause/resume, early finish,
page restoration, reconnecting after an extension reload, native downloads, Chrome internal pages
and the Chrome Web Store. Restricted-page
tests invoke the real extension action through the browser's extension testing API to grant activeTab.
Set `BSK_LONG_SCREENSHOT_URL` to additionally check an ordinary public website and
`BSK_LONG_SCREENSHOT_OUTPUT` to retain its result metadata and preview screenshot.

A standalone renderer suite exercises the production capture, OPFS store, PNG export and built
preview, including fractional/Retina scales, lazy loading and a 3,170 × 100,062-pixel result:

```sh
BSK_LONG_SCREENSHOT_RENDERER=/path/to/chrome-headless-shell pnpm --filter @browser-skill/extension exec vitest run src/long-screenshot/renderer.browser.test.ts
```

Set `BSK_LONG_SCREENSHOT_OUTPUT` to retain PNGs and buffer measurements. The 100,062-pixel run used
only canvases at most 512 pixels high; instrumented canvas and live ImageBitmap RGBA buffers peaked
at 43,705,488 bytes (about 41.7 MiB), while a full RGBA image would require 1,268,786,160 bytes.
This measurement excludes codec internals, ImageData/filter buffers, JavaScript heap, GPU copies,
the webpage and other Chrome processes; it is not a measurement of total browser memory.
