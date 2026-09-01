import type { ConnectionStateHandler, Disposable, FrameHandler, Transport } from "./transport";
import type { ConnectionState, ProtocolFrame } from "./types";

const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 5_000;
const DEFAULT_OPEN_PROBE_TIMEOUT_MS = 1_000;

export type WebSocketFactory = (url: string) => WebSocket;
export type WebSocketOpenProbe = (url: string) => boolean | Promise<boolean>;

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
  /**
   * Optional quiet availability check before constructing `WebSocket`.
   * Chrome reports failed classic WebSocket handshakes in chrome://extensions,
   * so the default uses `WebSocketStream` when available and falls back to
   * allowing the classic connection on browsers without that API.
   */
  openProbe?: WebSocketOpenProbe | null;
}

interface CloseLikeEvent {
  code?: number;
  reason?: string;
}

interface MessageLikeEvent {
  data: unknown;
}

interface WebSocketStreamLike {
  opened: Promise<unknown>;
  close?: (options?: { closeCode?: number; reason?: string }) => void;
}

type WebSocketStreamConstructor = new (
  url: string,
  options?: { signal?: AbortSignal },
) => WebSocketStreamLike;

function defaultOpenProbe(url: string): boolean | Promise<boolean> {
  const ctor = (globalThis as { WebSocketStream?: WebSocketStreamConstructor }).WebSocketStream;
  if (!ctor) return true;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_OPEN_PROBE_TIMEOUT_MS);
  let stream: WebSocketStreamLike;
  try {
    stream = new ctor(url, { signal: controller.signal });
  } catch {
    clearTimeout(timer);
    return Promise.resolve(false);
  }

  return stream.opened.then(
    () => {
      clearTimeout(timer);
      try {
        stream.close?.({ closeCode: 1000, reason: "probe complete" });
      } catch {
        // ignore
      }
      return true;
    },
    () => {
      clearTimeout(timer);
      return false;
    },
  );
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
  private url: string;
  private readonly factory: WebSocketFactory;
  private readonly openProbe: WebSocketOpenProbe | null;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;

  private socket: WebSocket | null = null;
  private openingSocket = false;
  private currentState: ConnectionState = "disconnected";
  private explicitlyClosed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private socketGeneration = 0;
  private connectingPromise: Promise<void> | null = null;
  private resolveConnect: ((value: void) => void) | null = null;
  private rejectConnect: ((reason: Error) => void) | null = null;
  private lastSocketError: Error | null = null;

  private readonly messageHandlers = new Set<FrameHandler>();
  private readonly stateHandlers = new Set<ConnectionStateHandler>();

  constructor(options: WSTransportOptions) {
    this.url = options.url;
    this.factory = options.webSocketFactory ?? ((url: string) => new WebSocket(url));
    this.openProbe = options.openProbe === undefined ? defaultOpenProbe : options.openProbe;
    this.initialDelayMs = options.reconnect?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.maxDelayMs = options.reconnect?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  async setUrl(url: string): Promise<void> {
    const next = url.trim();
    if (this.url === next) return;
    this.url = next;
    await this.disconnect();
  }

  connect(): Promise<void> {
    if (this.currentState === "connected") return Promise.resolve();

    this.explicitlyClosed = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.connectingPromise) {
      // A previous physical attempt closed before reaching OPEN. Keep the
      // original caller's promise, but start the next socket generation.
      if (!this.socket && !this.openingSocket) void this.openSocket();
      return this.connectingPromise;
    }

    this.connectingPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    void this.openSocket();
    return this.connectingPromise;
  }

  async disconnect(): Promise<void> {
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

  private async openSocket(): Promise<void> {
    if (this.openingSocket) return;
    this.openingSocket = true;
    this.setState("connecting");
    const generation = ++this.socketGeneration;
    const probeResult = this.canOpenSocket();
    const canOpen = typeof probeResult === "boolean" ? probeResult : await probeResult;
    if (!this.isCurrentGeneration(generation)) {
      this.openingSocket = false;
      return;
    }
    if (!canOpen) {
      this.openingSocket = false;
      this.setState("disconnected", this.connectionError());
      this.scheduleReconnect();
      return;
    }
    let socket: WebSocket;
    try {
      socket = this.factory(this.url);
    } catch (err) {
      this.openingSocket = false;
      this.setState("disconnected", this.connectionError(err));
      this.scheduleReconnect();
      return;
    }
    if (!this.isCurrentGeneration(generation)) {
      this.openingSocket = false;
      try {
        socket.close();
      } catch {
        // ignore
      }
      return;
    }
    this.socket = socket;
    this.openingSocket = false;

    socket.addEventListener("open", () => {
      if (!this.isCurrentSocket(socket, generation)) return;
      this.lastSocketError = null;
      this.reconnectAttempt = 0;
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
      if (!this.isCurrentSocket(socket, generation)) return;
      this.lastSocketError = this.connectionError();
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
    if (!this.isCurrentSocket(socket, generation)) return;
    this.socket = null;
    if (this.explicitlyClosed) {
      this.setState("disconnected");
      return;
    }
    const error = this.lastSocketError;
    this.lastSocketError = null;
    this.setState("disconnected", error ?? undefined);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(this.initialDelayMs * 2 ** this.reconnectAttempt, this.maxDelayMs);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.explicitlyClosed) return;
      void this.connect().catch((err) => {
        console.debug("[WSTransport] reconnect attempt failed", err);
      });
    }, delay);
  }

  private isCurrentSocket(socket: WebSocket, generation: number): boolean {
    return this.socket === socket && this.socketGeneration === generation;
  }

  private isCurrentGeneration(generation: number): boolean {
    return this.socketGeneration === generation && !this.explicitlyClosed;
  }

  private canOpenSocket(): boolean | Promise<boolean> {
    if (!this.openProbe) return true;
    try {
      return this.openProbe(this.url);
    } catch {
      return false;
    }
  }

  private connectionError(cause?: unknown): Error {
    const suffix = cause instanceof Error && cause.message ? ` (${cause.message})` : "";
    return new Error(
      `Cannot reach daemon WebSocket endpoint ${this.url}. Start bsk or check the SSH tunnel.${suffix}`,
    );
  }

  private setState(next: ConnectionState, error?: Error): void {
    if (this.currentState === next) return;
    this.currentState = next;
    for (const h of this.stateHandlers) {
      try {
        h(next, error);
      } catch (err) {
        console.error("[WSTransport] state handler threw", err);
      }
    }
  }
}
