# HAR recording

Use HAR capture when the user asks for an HTTP Archive of a browser flow (for
example, validation evidence for their own site). It records one controlled tab.

Start capture **before the first navigation**, perform the flow, then stop and
export **before** ending the session:

```sh
bsk har start --session <id>
bsk navigate https://example.com --session <id>
# snapshot / click / fill / press as needed
bsk har stop --session <id> --out artifacts/validation.har
bsk session stop <id>
```

- `bsk har status --session <id>` reports entries, in-flight requests, retained
  body bytes, and truncation.
- HAR capture is limited to dedicated Agent Window tabs; it cannot record normal
  or borrowed user tabs.
- Response/request content is captured by default, capped at 1 MiB per body,
  20 MiB total, and 5,000 entries. Use `--no-content` or the
  `--max-*-bytes` / `--max-entries` flags when appropriate.
- Authorization, Cookie, Set-Cookie, API-key headers, and common sensitive query
  parameters are redacted by default. `--include-sensitive` disables this
  protection; only use it when the user explicitly needs an unredacted archive
  and understands that the file may contain credentials.
- A `truncated=true` stop result or CLI warning means the archive hit a limit, CDP
  detached, or requests did not settle before the stop timeout. Treat it as
  incomplete validation evidence.
- `bsk session stop` discards any still-active recording, so always run
  `bsk har stop` first.
