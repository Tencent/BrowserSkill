# Fill notifies each final value once

## Original symptom

Filling a text field without clearing first (`clear_before: false` / `--no-clear`)
made every `input` listener run twice for the same final value. The first event
was the trusted native one from `Input.insertText`; the completion step then
dispatched a second synthetic `input` with the same value. Applications that
validate or persist on `input` (form validation, autosave, analytics) executed
that work twice.

## Minimal reproduction

An empty text input with one `input` listener:

```html
<input id="field">
<script>
  window.inputValues = [];
  document.querySelector("#field").addEventListener("input", () => {
    window.inputValues.push(document.querySelector("#field").value);
  });
</script>
```

Fill `#field` with `Hello` without clearing. Before the fix the listener received
`["Hello", "Hello"]`; the expected result is `["Hello"]`. A fill that clears first
is allowed to notify twice (`""` for the clear, then the new value), because those
are two distinct value changes.

## Expected behavior

One text insertion notifies the page exactly once for the final value. The
fixture records `input` and `change` events, then reports `FILL-EVENTS-OK` only
when the input notified once with `Hello`, a `change` for `Hello` was observed,
and the final field value is `Hello`.

## Regression history

- Source: [#624](https://github.com/Tencent/BrowserSkill/issues/624)
- Fix: `fix(fill): notify each final value once` (`f95f9e3c`), shipped in 0.5.0
