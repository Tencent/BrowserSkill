# Full-page screenshots

Open **Quick actions → Full-page screenshot** in the BrowserSkill popup. Choose:

- **Full page · Automatic**: captures from the top, scrolls incrementally and follows appended content.
- **Long image · I scroll**: captures from the current position while you scroll down. Keep overlapping
  content between screens. Reopen the popup and choose **Finish and keep** when you are done.
- **Visible area**: captures the current viewport once.

The feature works with the CLI connection off. It does not require the CLI, daemon or an Agent session.
After installing or reloading the extension, refresh ordinary pages to load the new content script.

## Controls and page access

Pause and resume a capture, or finish early and keep the captured portion. While automatic capture is
paused, you can load additional content; resuming returns to the captured position. Cancel discards
the current capture. Automatic captures restore the original scroll position and temporary styles
when they finish or stop. Manual mode leaves the page at the user's chosen position.

Keep the captured tab selected and its viewport size stable. Navigation, resizing, capture failures
and storage errors preserve durable tiles and identify the result as partial. A restarted background
worker can reopen the committed portion. Individual browser operations still have timeouts, but
there is no fixed whole-job duration, scroll count, 32K image-height or 48-megapixel cutoff.

Clicking the extension grants `activeTab` for the current tab. This enables visible-area screenshots
of Chrome internal pages and the Chrome Web Store as well as ordinary websites. These restricted
pages do not permit content-script injection; automatic mode switches to manual scrolling there.
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

The automated checks cover actual scroll-offset rounding, fixed-footer overlap, capture beyond
120 frames, early finish, cancellation, DOM cleanup, paused interaction, restricted-page fallback,
streaming PNG round trips, export cancellation and disk failures. Manual alignment tests cover
fixed bars, exact pixel offsets, ambiguous repeated content and non-overlapping jumps.

Build and run the real extension in an isolated Chrome profile:

```sh
pnpm ext:build
BSK_LONG_SCREENSHOT_CHROME=/path/to/chrome pnpm --filter @browser-skill/extension exec vitest run src/long-screenshot/long-screenshot.browser.test.ts
```

The extension tests cover automatic and manual capture, popup closure, pause/resume, early finish,
page restoration, native downloads, Chrome internal pages and the Chrome Web Store. Restricted-page
tests invoke the real extension action through the browser's extension testing API to grant activeTab.

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
