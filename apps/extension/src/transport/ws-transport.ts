import type { DiagnosticSink } from "@/lib/diagnostics";
import type { ConnectionStateHandler, Disposable, FrameHandler, Transport } from "./transport";
import type { ConnectionState, ProtocolFrame } from "./types";

const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 5_000;

export type WebSocketFactory = (url: string) => WebSocket;

export interface ReconnectOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export interface WSTransportOptions {
  url: string;
  reconnect?: ReconnectOptions;
  /**
   * Inject a fake WebSocket constructor in tests; defaults to `globalThis.WebSocket`.
   */
  webSocketFactory?: WebSocketFactory;
  diagnostics?: DiagnosticSink;
}

interface CloseLikeEvent {
  code?: number;
  reason?: string;
}

interface MessageLikeEvent {
  data: unknown;
}

/**
 * WebSocket-backed implementation of {@link Transport} (design §4.7).
 *
 * Lifecycle:
 *  - `connect()` opens a socket and resolves once it transitions to OPEN.
 *  - Inbound text frames are parsed as JSON and dispatched to message handlers.
 *  - Outbound frames are JSON-serialised and sent only when the socket is OPEN.
 *  - Unexpected closes trigger an exponential-backoff reconnect loop
 *    (1s, 2s, 4s, …, capped at 5s) until `disconnect()` is called.
 */
export class WSTransport implements Transport {
  private readonly url: string;
  private readonly factory: WebSocketFactory;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly diagnostics?: DiagnosticSink;

  private socket: WebSocket | null = null;
  private currentState: ConnectionState = "disconnected";
  private explicitlyClosed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private socketGeneration = 0;
  private connectingPromise: Promise<void> | null = null;
  private resolveConnect: ((value: void) => void) | null = null;
  private rejectConnect: ((reason: Error) => void) | null = null;

  private readonly messageHandlers = new Set<FrameHandler>();
  private readonly stateHandlers = new Set<ConnectionStateHandler>();

  constructor(options: WSTransportOptions) {
    this.url = options.url;
    this.factory = options.webSocketFactory ?? ((url: string) => new WebSocket(url));
    this.initialDelayMs = options.reconnect?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.maxDelayMs = options.reconnect?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.diagnostics = options.diagnostics;
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  connect(): Promise<void> {
    this.diagnostics?.("transport.connect.requested", {
      state: this.currentState,
      socket_generation: this.socketGeneration,
      has_socket: this.socket !== null,
      has_connecting_promise: this.connectingPromise !== null,
      has_reconnect_timer: this.reconnectTimer !== null,
    });
    if (this.currentState === "connected") return Promise.resolve();

    this.explicitlyClosed = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.connectingPromise) {
      // A previous physical attempt closed before reaching OPEN. Keep the
      // original caller's promise, but start the next socket generation.
      if (!this.socket) this.openSocket();
      return this.connectingPromise;
    }

    this.connectingPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    this.openSocket();
    return this.connectingPromise;
  }

  async disconnect(): Promise<void> {
    this.diagnostics?.("transport.disconnect.requested", {
      state: this.currentState,
      socket_generation: this.socketGeneration,
      has_socket: this.socket !== null,
    });
    this.explicitlyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.socketGeneration += 1;
    if (socket) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
    this.setState("disconnected");
    // Honour the Promise contract: if connect() never settled because
    // the caller chose to disconnect first, reject the pending promise
    // so awaiting code (e.g. ConnectionController.attach) observes the
    // outcome rather than hanging silently (review M4/M5 round 3
    // m-R3-2).
    const reject = this.rejectConnect;
    this.connectingPromise = null;
    this.resolveConnect = null;
    this.rejectConnect = null;
    reject?.(new Error("[WSTransport] disconnect during connect"));
  }

  send(msg: ProtocolFrame): void {
    if (!this.socket || this.socket.readyState !== 1 /* OPEN */) {
      this.diagnostics?.("transport.send.rejected", {
        state: this.currentState,
        socket_generation: this.socketGeneration,
        socket_ready_state: this.socket?.readyState ?? null,
        frame_kind: "method" in msg ? msg.method : "event" in msg ? msg.event : "response",
      });
      throw new Error("[WSTransport] cannot send while not connected");
    }
    this.socket.send(JSON.stringify(msg));
  }

  onMessage(handler: FrameHandler): Disposable {
    this.messageHandlers.add(handler);
    return {
      dispose: () => {
        this.messageHandlers.delete(handler);
      },
    };
  }

  onConnectionStateChange(handler: ConnectionStateHandler): Disposable {
    this.stateHandlers.add(handler);
    return {
      dispose: () => {
        this.stateHandlers.delete(handler);
      },
    };
  }

  private openSocket(): void {
    this.setState("connecting");
    const generation = ++this.socketGeneration;
    const socket = this.factory(this.url);
    this.socket = socket;
    this.diagnostics?.("transport.socket.created", {
      socket_generation: generation,
      reconnect_attempt: this.reconnectAttempt,
      url: this.url,
    });

    socket.addEventListener("open", () => {
      if (!this.isCurrentSocket(socket, generation)) return;
      this.reconnectAttempt = 0;
      this.diagnostics?.("transport.socket.open", { socket_generation: generation });
      this.setState("connected");
      const resolve = this.resolveConnect;
      this.resolveConnect = null;
      this.rejectConnect = null;
      this.connectingPromise = null;
      resolve?.();
    });

    socket.addEventListener("message", (ev: MessageEvent) => {
      if (!this.isCurrentSocket(socket, generation)) return;
      this.handleInbound((ev as unknown as MessageLikeEvent).data);
    });

    socket.addEventListener("close", (ev: Event) => {
      this.handleClose(socket, generation, ev as unknown as CloseLikeEvent);
    });

    socket.addEventListener("error", () => {
      this.diagnostics?.("transport.socket.error", { socket_generation: generation });
      // The 'close' handler always fires after 'error' in browsers, so we
      // just record the error and let close drive reconnect logic.
    });
  }

  private handleInbound(data: unknown): void {
    if (typeof data !== "string") return;
    let parsed: ProtocolFrame;
    try {
      parsed = JSON.parse(data) as ProtocolFrame;
    } catch {
      return;
    }
    for (const h of this.messageHandlers) {
      try {
        h(parsed);
      } catch (err) {
        console.error("[WSTransport] message handler threw", err);
      }
    }
  }

  private handleClose(socket: WebSocket, generation: number, _ev: CloseLikeEvent): void {
    const isCurrent = this.isCurrentSocket(socket, generation);
    this.diagnostics?.("transport.socket.close", {
      socket_generation: generation,
      current_socket_generation: this.socketGeneration,
      is_current: isCurrent,
      explicitly_closed: this.explicitlyClosed,
      close_code: _ev.code ?? null,
      close_reason: _ev.reason ?? "",
    });
    if (!isCurrent) return;
    this.socket = null;
    if (this.explicitlyClosed) {
      this.setState("disconnected");
      return;
    }
    this.setState("disconnected");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(this.initialDelayMs * 2 ** this.reconnectAttempt, this.maxDelayMs);
    this.reconnectAttempt += 1;
    this.diagnostics?.("transport.reconnect.scheduled", {
      delay_ms: delay,
      reconnect_attempt: this.reconnectAttempt,
      socket_generation: this.socketGeneration,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.explicitlyClosed) return;
      this.diagnostics?.("transport.reconnect.timer_fired", {
        reconnect_attempt: this.reconnectAttempt,
        socket_generation: this.socketGeneration,
      });
      void this.connect().catch((err) => {
        console.debug("[WSTransport] reconnect attempt failed", err);
      });
    }, delay);
  }

  private isCurrentSocket(socket: WebSocket, generation: number): boolean {
    return this.socket === socket && this.socketGeneration === generation;
  }

  private setState(next: ConnectionState): void {
    if (this.currentState === next) return;
    const previous = this.currentState;
    this.currentState = next;
    this.diagnostics?.("transport.state.changed", {
      previous,
      next,
      socket_generation: this.socketGeneration,
    });
    for (const h of this.stateHandlers) {
      try {
        h(next);
      } catch (err) {
        console.error("[WSTransport] state handler threw", err);
      }
    }
  }
}
