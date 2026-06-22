# Extension transport layer

`apps/extension/src/transport/` is the single, swappable seam between the
browser-skill extension and whatever channel it uses to talk to the local
daemon. v0.1 ships exactly one implementation —
[`ws-transport.ts`](./ws-transport.ts) — which speaks the JSON-line wire
format defined in `crates/bsk-protocol/schema/*.json` over a plain WebSocket.

## How to fork the transport

If you want to swap the WebSocket for native messaging, `chrome.runtime`
messaging, a shared `MessageChannel`, etc., implement the
[`Transport`](./transport.ts) interface and instantiate your class in
`apps/extension/src/entrypoints/background.ts` instead of `WSTransport`.

The contract is:

```ts
import type { Transport } from "@/transport/transport";
import type { ProtocolFrame, ConnectionState } from "@/transport/types";

class MyTransport implements Transport {
  readonly state: ConnectionState;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(msg: ProtocolFrame): void;
  onMessage(handler: (msg: ProtocolFrame) => void): { dispose(): void };
  onConnectionStateChange(handler: (s: ConnectionState) => void): { dispose(): void };
}
```

### Protocol-frame contract

A `ProtocolFrame` is one of three JSON shapes (mirrors `bsk-protocol::Frame`):

```jsonc
// Request — both peers may send
{ "id": "<rpc-id>", "method": "tool.snapshot", "params": { "session_id": "ab12" } }

// Response — one of result | error, never both
{ "id": "<rpc-id>", "result": { ... } }
{ "id": "<rpc-id>", "error": { "code": "not_found", "message": "session ab12 unknown" } }

// Event — no id, no response expected
{ "event": "session.window_closed", "payload": { "session_id": "ab12" } }
```

The transport is **purely a byte pipe**. It must not interpret RPC method
names, route by id, or re-order frames. Higher-level concerns
(handshake, dispatcher, ref-store) all live in `tools/` and
`session-manager/`. The transport's only obligations are:

1. **Frame-oriented delivery.** One `send()` call ⇒ exactly one frame on
   the wire. Inbound bytes are split into discrete frames before being
   handed to message handlers.
2. **Best-effort reconnect.** When the underlying channel breaks
   unexpectedly, the transport reopens it with backoff and surfaces
   `connecting` / `disconnected` via `onConnectionStateChange`.
   `WSTransport` uses 1 s → 2 s → 4 s → 8 s → 16 s → 30 s (capped),
   resetting on a successful reconnect.
3. **State observability.** `state` must be one of `disconnected`,
   `connecting`, `connected`, or `version_skew`. Only the handshake
   logic should set `version_skew` when `protocol_version` strings differ
   but majors match; app semver is not compared. The bare transport
   stays at `connected` once the socket is open. Handshake may still
   include deprecated `min_compatible_peer` (`"0.0.0"`) alongside
   `min_compatible_protocol` for backward compatibility.
4. **No throwing on malformed frames.** Drop non-JSON inbound traffic
   silently; surface decode failures through logs only.

### Handshake responsibility

A fresh `Transport` instance is **not** authenticated. The first frame
sent over the wire **must** be `system.handshake`. Forks are expected to
preserve that contract — see `lib/instance-id.ts` and
`transport/handshake.ts` (added in M4.3) for the helper that owns the
extension side.

### Testing forks

`__tests__/ws-transport.test.ts` is the reference test suite. It uses a
hand-rolled `FakeSocket` so a new transport can copy its structure
verbatim and adapt the inner channel. See the suite for: connect/
disconnect, send/onMessage, malformed-frame tolerance, and exponential-
backoff reconnect verification.
