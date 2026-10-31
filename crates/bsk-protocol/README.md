# bsk-protocol

Rust types and JSON Schemas for the browser-skill wire protocol (CLI ↔ daemon ↔ extension).

Generated JSON Schemas live in `schema/`. Guarded action parameter schemas include the
shared `ActionMetadata` fields (`context_id`, `observation_id`, `depends_on`, `expect`).
Rust operation structs describe the operation itself; merge serialized `ActionMetadata`
into the same params object when issuing a guarded request. Do not deserialize the combined
object into an operation struct and reserialize it without preserving its metadata.

`expect` supports up to 16 exact conditions. Selectors search the main document; use observed
refs for iframe/shadow-root targets. `text` compares raw `textContent`, including whitespace.
Target and attribute limits count Unicode code points. Runtime validation additionally checks
field-dependent value types and whether `attribute` is present only for attribute checks.

```bash
cargo run -p bsk-protocol --bin dump-schema --locked
```
