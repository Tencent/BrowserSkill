# Fill target boundary regression (#301)

Source: https://github.com/Tencent/BrowserSkill/pull/301

Fill accepts supported editable native inputs, textareas, and contenteditable
editing hosts. A descendant is not a fill target, including a focusable child or
one that repeats the contenteditable attribute. Rejection must precede scrolling,
focus, selection changes, input events, and content changes. Targets are never
promoted to an ancestor: default fill replaces the entire requested target.

The shared fixture matrix covers replacement, append, empty requests, native
constraints, empty editor layouts, whitespace, multiline text, Unicode, nested
editing boundaries, and foreground/background tabs. The real-browser suite also
covers observation refs, selectors, same-process frames, open shadow roots,
cancellation, focus changes, and page handlers that replace the editor. Successful
writes are checked against the final DOM and unrelated content. Browser-selected
text provides an independent multiline oracle; tests do not use the production
text reader to calculate expected results.

Run the regression with Node 22+ and a local Chrome executable:

```sh
BSK_FILL_CHROME=/path/to/chrome pnpm --filter @browser-skill/extension exec vitest run \
  src/tools/__tests__/fill.browser.test.ts
```

The suite owns an isolated headless browser and profile, gives each case a fresh
tab, and closes all targets and the browser on completion. It is skipped unless
BSK_FILL_CHROME is set; CI runs it explicitly. No browser download is required.

Validate the corpus and run the CLI smoke against a connected test extension:

```sh
pnpm eval:browser:check
BSK_AUTO_UPDATE=off pnpm eval:browser smoke --case fill-editor-roots --bsk ./target/debug/bsk
```

Smoke validates the user flow and intermediate values. The real-browser suite is
required for the stronger no-side-effect and cancellation assertions. Arbitrary
rich-text framework models, undo behavior, and rollback of page event handlers
are not guaranteed. After a mid-operation failure, observe before retrying.

Chrome can represent line breaks with DIV/BR wrappers and use non-breaking spaces
at line edges. Verification treats these browser representations as plain text;
it never inserts or removes temporary text markers in the editor.
