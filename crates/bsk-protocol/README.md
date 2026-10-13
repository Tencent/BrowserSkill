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

Local authentication v1 precedes the business handshake. The first frame is a
`system.ping` request whose `params.local_auth` contains a client nonce, instance
ID, and active/staged credential offers (IDs and generations only). The daemon
responds with `challenge`, `pairing_required`, or `busy`. A challenge binds both
nonces, daemon/device IDs, generation, instance ID, and HTTP Origin. The extension
verifies the server HMAC before sending its client HMAC.

`local.auth.ready` completes ordinary authentication. When it carries `rotation`,
the extension durably saves a candidate key before sending `rotate_confirm`; the
daemon durably commits before replying `committed`. Recovery instead completes
with `ready.commit`, proved using the saved candidate and this connection's
transcript. Only one final message is permitted. Business `system.handshake`
must wait until that final message and all credential writes complete.

Fields are encoded as repeated `u32_be(length) || bytes`. The transcript is
`F("bsk-local-auth-v1", daemon_id, device_id, u32_be(gen), instance_id, origin,
client_nonce, server_nonce)`. Server/client proofs use HMAC-SHA256 over
`F(role, transcript)`; candidate, confirmation, and commit proofs use
`F(role, transcript, txn)` with roles `rotate`, `confirm`, and `committed`.
Confirmation and commit proofs use the candidate as the HMAC key.

Authentication frames are limited to 4 KiB, use canonical unpadded base64url,
and reject unknown fields. Senders emit unique field names. Rust deserialization
rejects duplicate fields; the extension uses JSON.parse's last-value semantics,
then applies schema checks and proof verification to that same parsed value.
Shared Rust/Web Crypto vectors are in
`tests/fixtures/local-auth-v1.json`. Errors deliberately omit input values.
Local keys are distinct from remote Bearer grants. Legacy handshakes are governed
by local policy; an unauthenticated peer can never authorize a downgrade.

```bash
cargo run -p bsk-protocol --bin dump-schema --locked
```
