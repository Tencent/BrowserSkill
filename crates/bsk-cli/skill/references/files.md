# Upload and download

```sh
bsk upload @e3 --file ./report.pdf --session <id>
bsk download @e3 --out ./report.pdf --session <id>
```

Upload discloses the file to the site; download accepts site-controlled bytes.
Use agent-local paths, not browser-internal staging paths.

- Default upload clicks an upload button/label and intercepts its file chooser.
- If `reason=file_input_not_activated` and `effect_state=none`, re-observe. Try
  `--mode drop` once only on a clear attachment target such as a drop zone or
  composer, never whitespace or an ambiguous container. Otherwise follow
  [human-help rules](help-and-recovery.md). There is no automatic fallback between mechanisms.
- Never retry or switch upload modes for `effect_state=unknown` or `committed`.
  A successful drop proves dispatch, not site acceptance; observe the attachment.
- Download refuses overwrite by default; add `--overwrite` only when replacement
  is intended. Consult each command's help for other flags.

Remote upload/download are unsupported.
