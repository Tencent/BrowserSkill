import {
  EXTENSION_VERSION,
  MIN_COMPATIBLE_PROTOCOL,
  PROTOCOL_VERSION,
  performHandshake,
} from "../transport/handshake";
import type { Transport } from "../transport/transport";
import type { ConnectionState, HandshakeResult } from "../transport/types";
import { getLabel, getOrCreateInstanceId } from "./instance-id";
import { compareProtocol, parseProtocolMajor } from "./semver";

const HANDSHAKE_RETRY_DELAY_MS = 1_000;

export interface SnapshotInfo {
  state: ConnectionState;
  instanceId: string;
  label: string;
  extensionVersion: string;
  handshake: HandshakeResult | null;
  lastError: string | null;
  connectionEnabled: boolean;
}

type Listener = (s: SnapshotInfo) => void;

export interface ConnectionLifecycleHooks {
  /** Safe local teardown that must finish before an intentional disconnect. */
  beforeDisconnect?: () => void | Promise<void>;
  /** Best-effort teardown after an unexpected transport loss. */
  onDisconnected?: () => void | Promise<void>;
}

/**
 * Orchestrates Transport + handshake lifecycle for the background SW.
 *
 * Owns the canonical `ConnectionState` and `HandshakeResult` cache that
 * the popup queries via `chrome.runtime.connect` (wired in M4.5).
 */
export class ConnectionController {
  private transport: Transport | null = null;
  private currentState: ConnectionState = "disconnected";
  private handshake: HandshakeResult | null = null;
  private instanceId = "";
  private label = "";
  private lastError: string | null = null;
  private connectionEnabled = true;
  private listeners = new Set<Listener>();
  private lifecycleHooks: ConnectionLifecycleHooks = {};
  private ready = false;
  private preferenceChanged = false;
  private transition: Promise<void> | null = null;
  private cleanupNeeded = false;
  private hasConnected = false;
  private configurationKey: string | null = null;
  private pendingConfiguration: (() => void) | null = null;
  private connectionGeneration = 0;
  private handshakeAbort: AbortController | null = null;
  private handshakeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnects = 0;

  get isConnectionEnabled(): boolean {
    return this.connectionEnabled;
  }

  /**
   * Subscribe to snapshot changes. Fires immediately with the current
   * snapshot, then again on every transition.
   */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): SnapshotInfo {
    return {
      state: this.currentState,
      instanceId: this.instanceId,
      label: this.label,
      extensionVersion: EXTENSION_VERSION,
      handshake: this.handshake,
      lastError: this.lastError,
      connectionEnabled: this.connectionEnabled,
    };
  }

  async attach(
    transport: Transport,
    browser: { name: string; version: string },
    connectionEnabled = true,
    lifecycleHooks: ConnectionLifecycleHooks = {},
  ): Promise<void> {
    this.transport = transport;
    if (!this.preferenceChanged) this.connectionEnabled = connectionEnabled;
    this.lifecycleHooks = lifecycleHooks;
    this.instanceId = await getOrCreateInstanceId();
    this.label = await getLabel();

    transport.onConnectionStateChange((state) => {
      if (state === "disconnected") {
        this.cancelHandshake();
        this.handshake = null;
        this.setState("disconnected");
        if (this.intentionalDisconnects > 0) return;
        if (this.transition) {
          // The transport schedules its retry after notifying listeners. Cancel
          // it after that notification, including loss during disable cleanup.
          void Promise.resolve()
            .then(() => {
              if (this.transition) return this.disconnectTransport();
            })
            .catch((err) => this.reportError(err));
        } else if (this.connectionEnabled && this.hasConnected) {
          void this.teardown(false);
        }
        return;
      }
      if (!this.connectionEnabled || this.transition) return;
      if (state === "connected") {
        this.hasConnected = true;
        this.startHandshake(browser);
      } else {
        this.setState(state);
      }
    });

    this.applyPendingConfiguration();
    this.ready = true;
    this.fire();
    if (this.connectionEnabled) this.requestConnect();
    else await this.teardown(true);
  }

  async setConnectionEnabled(enabled: boolean): Promise<void> {
    this.preferenceChanged = true;
    if (this.connectionEnabled === enabled) return;
    this.connectionEnabled = enabled;
    this.fire();
    if (!this.ready) return;
    if (!enabled) await this.teardown(true);
    else this.requestConnect();
  }

  /** Apply only the latest configuration, after the old sessions are cleaned up. */
  reconfigureTransport(key: string, apply: () => void): Promise<void> {
    if (key === this.configurationKey) return this.transition ?? Promise.resolve();
    this.configurationKey = key;
    this.pendingConfiguration = apply;
    if (!this.ready) return Promise.resolve();
    return this.teardown(false);
  }

  /** Shared entry point for startup, wake events, keepalive, and handshake retries. */
  requestConnect(): void {
    if (!this.ready || !this.connectionEnabled || this.transition) return;
    if (this.cleanupNeeded) {
      void this.teardown(false);
      return;
    }
    if (this.handshakeRetryTimer || !this.transport || this.transport.state !== "disconnected")
      return;
    const generation = this.connectionGeneration;
    // Never hold the lifecycle operation open while an unreachable endpoint is
    // retrying: disabling or changing its configuration must remain possible.
    const onError = (err: unknown) => {
      if (generation !== this.connectionGeneration || !this.connectionEnabled || this.transition)
        return;
      this.reportError(err);
    };
    try {
      void this.transport.connect().catch(onError);
    } catch (err) {
      onError(err);
    }
  }

  async refreshLabel(): Promise<void> {
    this.label = await getLabel();
    this.fire();
  }

  private startHandshake(browser: { name: string; version: string }): void {
    this.cancelHandshake();
    const generation = ++this.connectionGeneration;
    const abort = new AbortController();
    this.handshakeAbort = abort;
    void this.runHandshake(browser, generation, abort.signal);
  }

  private async runHandshake(
    browser: { name: string; version: string },
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.transport) return;
    if (!this.connectionEnabled || this.transition) return;
    this.setState("connecting");
    try {
      const outcome = await performHandshake(
        this.transport,
        {
          instanceId: this.instanceId,
          browser,
          label: this.label,
        },
        { signal },
      );
      if (generation !== this.connectionGeneration || signal.aborted) return;
      this.handshake = outcome.result;
      const verdict = computeConnectedState(outcome.result);
      if (verdict.kind === "rejected") {
        this.lastError = `version_too_old: ${verdict.reason}`;
        this.handshake = null;
        // Preserve the rejection until the next explicit/wake-driven attempt.
        await this.disconnectTransport();
        return;
      }
      this.clearHandshakeRetry();
      this.lastError = null;
      this.setState(verdict.kind);
    } catch (err) {
      if (generation !== this.connectionGeneration || signal.aborted || isAbortError(err)) return;
      this.handshake = null;
      this.lastError = err instanceof Error ? err.message : String(err);
      const disconnect = this.disconnectTransport();
      const disconnectedGeneration = this.connectionGeneration;
      await disconnect;
      if (
        disconnectedGeneration !== this.connectionGeneration ||
        this.transition ||
        !this.connectionEnabled
      )
        return;
      this.scheduleHandshakeRetry();
    } finally {
      if (generation === this.connectionGeneration) this.handshakeAbort = null;
    }
  }

  /** Only finite teardown work is shared; the next connect is interruptible. */
  private teardown(cleanupBeforeDisconnect: boolean): Promise<void> {
    if (this.transition) return this.transition;
    this.cleanupNeeded = true;
    this.cancelHandshake();
    this.clearHandshakeRetry();
    this.handshake = null;
    this.lastError = null;
    this.fire();
    // Install the gate before disconnect can synchronously notify listeners.
    this.transition = Promise.resolve().then(async () => {
      try {
        if (cleanupBeforeDisconnect) {
          // Preserve the existing safe user-disable ordering.
          try {
            await this.lifecycleHooks.beforeDisconnect?.();
          } finally {
            await this.disconnectTransport();
          }
        } else {
          await this.disconnectTransport();
          await (this.lifecycleHooks.onDisconnected ?? this.lifecycleHooks.beforeDisconnect)?.();
        }
        this.applyPendingConfiguration();
        this.cleanupNeeded = false;
        this.hasConnected = false;
        this.setState("disconnected");
      } catch (err) {
        // Keep the pending configuration and cleanup gate for a later retry.
        this.reportError(err);
      } finally {
        this.transition = null;
        if (!this.cleanupNeeded) this.requestConnect();
      }
    });
    return this.transition;
  }

  private applyPendingConfiguration(): void {
    this.pendingConfiguration?.();
    this.pendingConfiguration = null;
  }

  private async disconnectTransport(): Promise<void> {
    this.intentionalDisconnects += 1;
    try {
      await this.transport?.disconnect();
    } finally {
      this.intentionalDisconnects -= 1;
    }
  }

  private reportError(err: unknown): void {
    this.lastError = err instanceof Error ? err.message : String(err);
    this.setState("disconnected");
    this.fire();
  }

  private cancelHandshake(): void {
    this.connectionGeneration += 1;
    this.handshakeAbort?.abort();
    this.handshakeAbort = null;
  }

  private scheduleHandshakeRetry(): void {
    if (this.handshakeRetryTimer || !this.connectionEnabled) return;
    this.handshakeRetryTimer = setTimeout(() => {
      this.handshakeRetryTimer = null;
      this.requestConnect();
    }, HANDSHAKE_RETRY_DELAY_MS);
  }

  private clearHandshakeRetry(): void {
    if (!this.handshakeRetryTimer) return;
    clearTimeout(this.handshakeRetryTimer);
    this.handshakeRetryTimer = null;
  }

  private setState(next: ConnectionState): void {
    if (this.currentState === next) return;
    this.currentState = next;
    this.fire();
  }

  private fire(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch (err) {
        console.error("[bh] connection snapshot listener threw", err);
      }
    }
  }
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError"
  );
}

/**
 * Verdict of the symmetric post-handshake compat check.
 */
export type HandshakeVerdict =
  | { kind: "connected" }
  | { kind: "version_skew" }
  | { kind: "rejected"; reason: string };

/**
 * Symmetric extension-side **protocol** compat check.
 *
 * Mirrors `evaluate_handshake_compat` in `crates/bsk-protocol/src/system.rs`.
 * Application semvers are not compared — CLI and extension ship on
 * independent version lines.
 *
 * Ordering:
 *   1. protocol major mismatch                       → `rejected`
 *   2. daemon protocol < extension's protocol floor    → `rejected`
 *   3. extension protocol < daemon's protocol floor    → `rejected` (skipped when absent)
 *   4. protocol strings equal                          → `connected`
 *   5. otherwise (same major, minor drift)             → `version_skew`
 *
 * `localMinCompatibleProtocol` defaults to {@link MIN_COMPATIBLE_PROTOCOL};
 * tests may inject a different floor.
 */
export function computeConnectedState(
  handshake: HandshakeResult,
  localMinCompatibleProtocol: string = MIN_COMPATIBLE_PROTOCOL,
): HandshakeVerdict {
  const daemonMajor = parseProtocolMajor(handshake.protocol_version);
  const ourMajor = parseProtocolMajor(PROTOCOL_VERSION);
  if (daemonMajor === null || ourMajor === null || daemonMajor !== ourMajor) {
    return {
      kind: "rejected",
      reason: `protocol-major mismatch (daemon protocol v${handshake.protocol_version}, extension protocol v${PROTOCOL_VERSION})`,
    };
  }
  if (compareProtocol(handshake.protocol_version, localMinCompatibleProtocol) === null) {
    return {
      kind: "rejected",
      reason: `daemon protocol v${handshake.protocol_version} is unparseable`,
    };
  }
  if (compareProtocol(handshake.protocol_version, localMinCompatibleProtocol)! < 0) {
    return {
      kind: "rejected",
      reason: `daemon protocol v${handshake.protocol_version} below extension min_compatible_protocol ${localMinCompatibleProtocol}`,
    };
  }
  const peerFloor = handshake.min_compatible_protocol;
  if (peerFloor) {
    if (compareProtocol(PROTOCOL_VERSION, peerFloor) === null) {
      return {
        kind: "rejected",
        reason: `daemon min_compatible_protocol ${peerFloor} is unparseable`,
      };
    }
    if (compareProtocol(PROTOCOL_VERSION, peerFloor)! < 0) {
      return {
        kind: "rejected",
        reason: `extension protocol v${PROTOCOL_VERSION} below daemon min_compatible_protocol ${peerFloor}`,
      };
    }
  }
  if (handshake.protocol_version === PROTOCOL_VERSION) {
    return { kind: "connected" };
  }
  return { kind: "version_skew" };
}

export const __testing__ = { computeConnectedState };
