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

  private socket: WebSocket | null = null;
  private currentState: ConnectionState = "disconnected";
  private explicitlyClosed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  connect(): Promise<void> {
    if (this.connectingPromise) return this.connectingPromise;
    if (this.currentState === "connected") return Promise.resolve();

    this.explicitlyClosed = false;
    this.openSocket();

    this.connectingPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    return this.connectingPromise;
  }

  async disconnect(): Promise<void> {
    this.explicitlyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
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
    const socket = this.factory(this.url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.setState("connected");
      const resolve = this.resolveConnect;
      this.resolveConnect = null;
      this.rejectConnect = null;
      this.connectingPromise = null;
      resolve?.();
    });

    socket.addEventListener("message", (ev: MessageEvent) => {
      this.handleInbound((ev as unknown as MessageLikeEvent).data);
    });

    socket.addEventListener("close", (ev: Event) => {
      this.handleClose(ev as unknown as CloseLikeEvent);
    });

    socket.addEventListener("error", () => {
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

  private handleClose(_ev: CloseLikeEvent): void {
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
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.explicitlyClosed) return;
      this.openSocket();
    }, delay);
  }

  private setState(next: ConnectionState): void {
    if (this.currentState === next) return;
    this.currentState = next;
    for (const h of this.stateHandlers) {
      try {
        h(next);
      } catch (err) {
        console.error("[WSTransport] state handler threw", err);
      }
    }
  }
}
