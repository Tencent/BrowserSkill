# Full-page screenshots

Open the BrowserSkill extension popup, choose **Quick actions → Full-page screenshot**, and click
**Start capture**. This feature works with the connection switch off; it does not require an Agent,
a session, or the CLI.

The extension scrolls an ordinary HTTP/HTTPS page to load content, returns to the top, and captures
overlapping viewport images. It stitches them into a PNG at the browser's native pixel scale.
The captured width is the current content viewport, excluding the scrollbar. Fixed headers and
footers appear only at the corresponding page edge; sticky elements retain their place in document
flow while the capture runs.

Keep the target tab selected and avoid scrolling or resizing its window. Closing the popup does
not stop the task. Press **Esc**, use the page's cancel button, or reopen the quick action and choose
**Cancel** to stop it. The page's original scroll position and temporary styling are restored on
completion, cancellation and failure. A content-side watchdog restores the page if the background
worker disappears.

When finished, a preview tab opens with fit-to-width and 25%, 50% and 100% zoom options. Choose
**Download PNG** to save the original image. The popup can reopen the latest completed preview.
Images stay in the extension's local IndexedDB, with no upload. Each new capture prunes previews
older than 24 hours and keeps at most five recent results. Download images you want to retain.

## Scope and limits

- Captures the top-level page vertically, not the contents of nested scrolling panels, virtual
  lists or independently scrolling frames. Horizontally overflowing content outside the viewport
  is excluded.
- Lazy images get a bounded loading period. Pages that continually change their layout may fail
  with a retry message instead of producing an incorrectly stitched image.
- The canvas is limited to 32,760 pixels per side and 48 million pixels total. Preparation and
  capture each allow at most 120 steps, with an overall execution budget of three minutes and
  bounded individual browser calls. Oversized pages fail explicitly without a truncated download.
- Browser-internal pages, extension stores and pages without the content script cannot be captured.
  After installing/reloading the extension, refresh an already-open webpage before capturing it.
- An Agent-controlled tab cannot be captured concurrently by the quick action.

The normal backend uses `tabs.captureVisibleTab`. If its initial window-surface readback fails or
times out, the feature acquires a temporary debugger attachment and uses `Page.captureScreenshot`
from the renderer. Chrome may show its debugging indicator during this fallback. The backend is
chosen before page measurement; an image never mixes viewport sizes from different backends.
The temporary attachment is released before previewing, and a failed attach never detaches
another debugger.

## Implementation and verification

The feature lives in `apps/extension/src/long-screenshot`. The content script owns reversible page
preparation; the background owns a single cancellable job, captures and local storage. `capture.ts`
is independent of popup and CLI transport, so a future API can reuse the engine without changing
the UI. This release does not add a CLI command or protocol field.

The tests cover pixel boundary rounding, bottom-of-page overlap, bitmap release, DOM restoration,
cancellation, job isolation, backend ownership, UI states and interrupted workers.

After building the extension, run real-browser integration tests with an isolated Chrome binary:

```sh
pnpm ext:build
BSK_LONG_SCREENSHOT_CHROME=/path/to/chrome pnpm --filter @browser-skill/extension exec vitest run src/long-screenshot/long-screenshot.browser.test.ts
```

The test owns its profile and disables the CLI connection. It exercises the shipped quick action,
PNG persistence, preview and download. A separate pixel oracle runs the actual DOM preparation and
capture engine against a standalone headless renderer, including fractional and Retina scales:

```sh
BSK_LONG_SCREENSHOT_RENDERER=/path/to/chrome-headless-shell pnpm --filter @browser-skill/extension exec vitest run src/long-screenshot/renderer.browser.test.ts
```

Set `BSK_LONG_SCREENSHOT_OUTPUT` to a directory to retain PNG evidence.
