# Press reports the physical code for punctuation keys

## Original symptom

Pressing a punctuation shortcut such as `Ctrl+/` reported success, but the page
received `{ key: "/", code: "", keyCode: 0, ctrlKey: true }`. Handlers that key
off `event.code === "Slash"` or `event.keyCode === 191` never ran. `resolveKeyDescriptor`
returned an empty `code` and no virtual key code for single-character punctuation,
assuming Chromium would derive them from `text`; when Ctrl, Meta or Alt is held
the extension suppresses `text`, so the page had no descriptor to fall back on.

## Minimal reproduction

```html
<input id="field">
<script>
  window.count = 0;
  document.querySelector("#field").addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.code === "Slash") window.count += 1;
  });
</script>
```

Press `Ctrl+/` on the field. Before the fix `count` stayed `0` while the command
reported success; after the fix the event carries `code: "Slash"` and
`keyCode: 191`, matching Playwright's US keyboard layout.

## Expected behavior

The fixture records the keydown descriptor and reports `PRESS-PUNCT-OK` only when
the page received `key: "/"`, `code: "Slash"`, `keyCode: 191`, `ctrlKey: true`,
and no extra modifiers.

## Regression history

- Source: [#623](https://github.com/Tencent/BrowserSkill/issues/623)
- Fix: `fix(extension): give punctuation keys a physical code and key code`
  (`9cbbfbdb`, PR #637), shipped in 0.5.0
