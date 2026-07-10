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
  private handshakeInFlight = false;
  private lifecycleHooks: ConnectionLifecycleHooks = {};
  private disconnectRecovery: Promise<void> | null = null;

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
    this.connectionEnabled = connectionEnabled;
    this.lifecycleHooks = lifecycleHooks;
    this.instanceId = await getOrCreateInstanceId();
    this.label = await getLabel();

    transport.onConnectionStateChange((s) => {
      if (s === "disconnected") {
        this.handshake = null;
        if (this.connectionEnabled) {
          this.setState("disconnected");
          void this.recoverFromDisconnect();
        }
        return;
      }
      if (!this.connectionEnabled) return;
      if (s === "connected") {
        void this.runHandshake(browser);
        return;
      }
      this.setState(s);
    });

    transport.onMessage(() => {
      // Real RPC dispatching is wired in M5 (tools/dispatcher.ts).
    });

    if (this.connectionEnabled) {
      try {
        await transport.connect();
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.setState("disconnected");
      }
    } else {
      this.applyDisabledState();
    }
  }

  async setConnectionEnabled(enabled: boolean): Promise<void> {
    if (this.connectionEnabled === enabled) return;
    this.connectionEnabled = enabled;

    if (!enabled) {
      await this.applyDisabledState();
      return;
    }

    this.fire();
    if (!this.transport) return;
    try {
      await this.transport.connect();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.setState("disconnected");
    }
  }

  async refreshLabel(): Promise<void> {
    this.label = await getLabel();
    this.fire();
  }

  private async runHandshake(browser: { name: string; version: string }): Promise<void> {
    if (!this.transport) return;
    if (!this.connectionEnabled) return;
    if (this.handshakeInFlight) return;
    this.handshakeInFlight = true;
    this.setState("connecting");
    try {
      const outcome = await performHandshake(this.transport, {
        instanceId: this.instanceId,
        browser,
        label: this.label,
      });
      this.handshake = outcome.result;
      const verdict = computeConnectedState(outcome.result);
      if (verdict.kind === "rejected") {
        this.lastError = `version_too_old: ${verdict.reason}`;
        this.handshake = null;
        await this.transport.disconnect().catch(() => {});
        this.setState("disconnected");
        return;
      }
      this.lastError = null;
      this.setState(verdict.kind);
    } catch (err) {
      this.handshake = null;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.setState("disconnected");
    } finally {
      this.handshakeInFlight = false;
    }
  }

  private async applyDisabledState(): Promise<void> {
    this.handshake = null;
    this.lastError = null;
    await this.lifecycleHooks.beforeDisconnect?.();
    if (this.transport) {
      await this.transport.disconnect().catch(() => {});
    }
    const was = this.currentState;
    this.setState("disconnected");
    if (was === "disconnected") this.fire();
  }

  private recoverFromDisconnect(): Promise<void> {
    if (this.disconnectRecovery) return this.disconnectRecovery;
    const recovery = (async () => {
      // WSTransport schedules its reconnect timer immediately after notifying
      // state listeners. Yield once, then disconnect explicitly so that timer
      // is cancelled before local session teardown begins.
      await Promise.resolve();
      if (!this.connectionEnabled || !this.transport) return;
      await this.transport.disconnect().catch(() => {});
      try {
        await this.lifecycleHooks.onDisconnected?.();
      } catch (err) {
        console.warn("[browser-skill] session cleanup after disconnect failed", err);
      }
      if (!this.connectionEnabled) return;
      try {
        await this.transport.connect();
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.setState("disconnected");
      }
    })();
    this.disconnectRecovery = recovery.finally(() => {
      this.disconnectRecovery = null;
    });
    return this.disconnectRecovery;
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
