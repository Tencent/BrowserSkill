import { LegacyReconnect } from "./local-auth";
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
  authenticate?: (socket: WebSocket, signal: AbortSignal) => Promise<void> | void;
  onAuthenticationError?: () => void;
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
 *  - `connect()` resolves after OPEN and the optional authentication prelude.
 *  - Inbound text frames are parsed as JSON and dispatched to message handlers.
 *  - Outbound frames are JSON-serialised and sent only after authentication succeeds.
 *  - Unexpected closes trigger an exponential-backoff reconnect loop
 *    (1s, 2s, 4s, …, capped at 5s) until `disconnect()` is called.
 */
export class WSTransport implements Transport {
  private url: string;
  private readonly factory: WebSocketFactory;
  private readonly authenticate?: WSTransportOptions["authenticate"];
  private readonly onAuthenticationError?: () => void;
  private authentication: AbortController | null = null;
  private authenticationTimer: ReturnType<typeof setTimeout> | null = null;
  private authFailures = 0;
  private authBackoffUntil = 0;
  private legacyReconnect = false;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;

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
    this.authenticate = options.authenticate;
    this.onAuthenticationError = options.onAuthenticationError;
    this.factory = options.webSocketFactory ?? ((url: string) => new WebSocket(url));
    this.initialDelayMs = options.reconnect?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.maxDelayMs = options.reconnect?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  /** Returns whether the URL changed. Does not reconnect. */
  setUrl(url: string): boolean {
    if (url === this.url) return false;
    this.url = url;
    return true;
  }

  resetAuthenticationBackoff(): void {
    this.authBackoffUntil = 0;
    this.authFailures = 0;
  }

  connect(): Promise<void> {
    if (this.currentState === "connected") return Promise.resolve();

    if (Date.now() < this.authBackoffUntil) return Promise.reject(new Error("local_auth_backoff"));
    this.explicitlyClosed = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.connectingPromise) {
      // A previous physical attempt closed before reaching OPEN. Keep the
      // original caller's promise, but start the next socket generation.
      const pending = this.connectingPromise;
      if (!this.socket) this.openSocket();
      return pending;
    }

    this.connectingPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    const pending = this.connectingPromise;
    this.openSocket();
    return pending;
  }

  async disconnect(): Promise<void> {
    this.explicitlyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.endAuthentication();
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
    if (
      this.currentState !== "connected" ||
      !this.socket ||
      this.socket.readyState !== 1 /* OPEN */
    ) {
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
    let socket: WebSocket;
    try {
      socket = this.factory(this.url);
    } catch (err) {
      // A rejected configuration never enters the connecting state. Settle
      // the pending attempt so callers can report it and retry after recovery.
      const reject = this.rejectConnect;
      this.connectingPromise = null;
      this.resolveConnect = null;
      this.rejectConnect = null;
      reject?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.setState("connecting");
    const generation = ++this.socketGeneration;
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (!this.isCurrentSocket(socket, generation)) return;
      const connected = () => {
        if (!this.isCurrentSocket(socket, generation)) return;
        if (socket.readyState !== 1) {
          failed(new Error("Connection closed during authentication"));
          return;
        }
        this.endAuthentication();
        this.resetAuthenticationBackoff();
        this.reconnectAttempt = 0;
        this.setState("connected");
        const resolve = this.resolveConnect;
        this.resolveConnect = null;
        this.rejectConnect = null;
        this.connectingPromise = null;
        resolve?.();
      };
      const failed = (error: unknown) => {
        if (!this.isCurrentSocket(socket, generation)) return;
        this.legacyReconnect = error instanceof LegacyReconnect;
        if (!this.legacyReconnect) this.onAuthenticationError?.();
        if (!this.legacyReconnect)
          this.authBackoffUntil = Date.now() + Math.min(30_000 * 2 ** this.authFailures++, 300_000);
        this.endAuthentication();
        const reject = this.rejectConnect;
        this.resolveConnect = null;
        this.rejectConnect = null;
        this.connectingPromise = null;
        reject?.(error instanceof Error ? error : new Error("Local authentication failed"));
        socket.close();
        this.handleClose(socket, generation, {});
      };
      if (!this.authenticate) {
        connected();
        return;
      }
      const abort = new AbortController();
      this.authentication = abort;
      this.authenticationTimer = setTimeout(
        () => failed(new Error("Local authentication timed out")),
        5_000,
      );
      try {
        Promise.resolve(this.authenticate(socket, abort.signal)).then(connected, failed);
      } catch (error) {
        failed(error);
      }
    });

    socket.addEventListener("message", (ev: MessageEvent) => {
      if (!this.isCurrentSocket(socket, generation) || this.currentState !== "connected") return;
      this.handleInbound((ev as unknown as MessageLikeEvent).data);
    });

    socket.addEventListener("close", (ev: Event) => {
      this.handleClose(socket, generation, ev as unknown as CloseLikeEvent);
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
    // No authentication frame is a business message, including a second final.
    if (
      parsed &&
      typeof parsed === "object" &&
      "type" in parsed &&
      typeof parsed.type === "string" &&
      parsed.type.startsWith("local.auth.")
    ) {
      this.onAuthenticationError?.();
      this.authFailures += 1;
      this.authBackoffUntil = Date.now() + 30_000;
      this.socket?.close();
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
    // The authenticator must observe close before deciding whether persisted
    // migration policy permits a new legacy socket. Its total timeout bounds it.
    if (this.authentication) return;
    this.endAuthentication();
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
    const delay = this.legacyReconnect
      ? 0
      : Math.max(
          this.authBackoffUntil - Date.now(),
          Math.min(this.initialDelayMs * 2 ** this.reconnectAttempt, this.maxDelayMs),
        );
    this.legacyReconnect = false;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.explicitlyClosed) return;
      void this.connect().catch((err) => {
        console.debug("[WSTransport] reconnect attempt failed", err);
      });
    }, delay);
  }

  private endAuthentication(): void {
    this.authentication?.abort();
    this.authentication = null;
    if (this.authenticationTimer) clearTimeout(this.authenticationTimer);
    this.authenticationTimer = null;
  }

  private isCurrentSocket(socket: WebSocket, generation: number): boolean {
    return this.socket === socket && this.socketGeneration === generation;
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
