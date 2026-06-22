import type { ConnectionState, ProtocolFrame } from "./types";

export interface Disposable {
  dispose(): void;
}

export type FrameHandler = (msg: ProtocolFrame) => void;
export type ConnectionStateHandler = (state: ConnectionState) => void;

/**
 * Abstraction over a bidirectional protocol channel (§4.7).
 *
 * v1 ships a single {@link WSTransport} implementation. Forks that want a
 * different transport (e.g. native messaging, MessageChannel for embedding
 * in a host page) only have to implement this interface and swap the
 * concrete class in `entrypoints/background.ts`.
 */
export interface Transport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(msg: ProtocolFrame): void;
  onMessage(handler: FrameHandler): Disposable;
  onConnectionStateChange(handler: ConnectionStateHandler): Disposable;
  readonly state: ConnectionState;
}
