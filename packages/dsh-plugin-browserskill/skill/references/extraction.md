# Current DOM reads and extraction

Use `bsk_inspect` action=read for data during animation, rather than evaluate.
`selector` reads all main-document matches, or `ref` reads an exact observed node
in a frame/shadow root. Example readFields:

```json
[{"key":"index","read":"attribute","attribute":"data-swiper-slide-index"}]
```

`readFields` is a JSON string containing key/read/optional selector/attribute.
Reads are text (exact textContent), attribute, value, checked and exists. Field
selectors are relative and must match at most one descendant. The result includes
current title/URLs, item refs/values, redacted fields and truncated. Missing
matches are empty/null; exists is false. Hidden DOM may be included. Sensitive
controls and ancestor text containing them are redacted.

Fixed synchronous isolated-world code accepts no JavaScript, callbacks, property
paths or delayed work. Inspect truncated: maxNodes defaults to 100, at most 1000;
maxBytes defaults to 262144, at most 1048576. readTimeoutMs bounds collection work
(default 3000, range 100..10000). Ambiguous fields and byte overflow fail instead
of returning plausible partial data. A read is a current sample, not a business
transaction or permission to act; it never renews contextId/observationId.
Protect record identity, meaning, price, recipient and form values with expect.
Changed-then-restored values can match; uninterrupted history is not promised.

Requires CLI/daemon/extension protocol 1.9; unsupported peers fail without script
fallback. Arbitrary evaluate retains strict checks even if it looks read-only.
For observation_changed while gathering data, use read/extract instead of a
sync/evaluate loop. Transform returned JSON on the host if needed.

For complex tables/lists, use bsk_inspect action=extract, extractKind=discover,
then extractKind=table/list with extractTarget. Lists accept itemSelector and
extractFields with {"fields":[{"key":"name","selector":"h3","read":"text"}]}.
Reads: text, href, attribute. No scrolling or pagination occurs. Inspect coverage
and warnings; completeness is unknown/incomplete, never assumed. Use output for
JSON/CSV export, extractFormat=csv for CSV plus metadata. Do not treat a list of
currently loaded virtual rows as the whole dataset.
