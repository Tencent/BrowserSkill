/**
 * Shared view logic for the observation carriers (the floating overlay card
 * and the better-sidebar tab): the store-backed view model (snapshot, focus
 * pinning, elapsed ticker) and the Document PiP pop-out. Extracted from
 * ObservationOverlay so both carriers run the same focus/interrupt behavior
 * without duplicating hooks.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { SessionObservation } from "../observation";
import type { ObservationClientStore, OverlaySnapshot } from "./observation-store";

/**
 * Auto-follow focus: the most recently touched session, but never yank focus
 * to a session whose latest action failed (errors flag the strip item, they
 * do not steal the stage) or one already reported dead.
 */
export function focusOf(sessions: readonly SessionObservation[]): SessionObservation | undefined {
  if (sessions.length === 0) return undefined;
  const byRecency = [...sessions].sort((a, b) => b.since - a.since);
  const healthy = byRecency.find((s) => s.lastError === undefined && s.dead !== true);
  return healthy ?? byRecency[0];
}

export function statusOf(obs: SessionObservation): "active" | "idle" | "error" {
  if (obs.lastError !== undefined && obs.action === "idle") return "error";
  return obs.action === "idle" ? "idle" : "active";
}

/** Minimal Document PiP surface (TS lib.dom lacks it). */
export interface DocumentPip {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

export function pipApi(): DocumentPip | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { documentPictureInPicture?: DocumentPip }).documentPictureInPicture;
}

/** Clone the host document's style/link nodes into a PiP window. */
export function cloneStylesInto(pipWindow: Window): void {
  for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
    pipWindow.document.head.appendChild(node.cloneNode(true));
  }
}

export interface ObservationView {
  readonly snapshot: OverlaySnapshot;
  /** Pinned session wins while it still exists; otherwise auto-follow. */
  readonly focus: SessionObservation | undefined;
  readonly pinnedId: string | null;
  readonly onTogglePin: (sessionId: string) => void;
  /** 1s ticker while anything is active (drives the elapsed readout). */
  readonly now: number;
}

/**
 * The store-backed observation view model. Holds the feed for the component
 * lifetime (refcounted — overlapping carriers never kill each other's
 * stream).
 */
export function useObservationView(store: ObservationClientStore): ObservationView {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    store.acquire();
    return () => store.release();
  }, [store]);

  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const pinned =
    pinnedId !== null ? snapshot.sessions.find((s) => s.sessionId === pinnedId) : undefined;
  const focus = pinned ?? focusOf(snapshot.sessions);
  const onTogglePin = useCallback((sessionId: string) => {
    setPinnedId((current) => (current === sessionId ? null : sessionId));
  }, []);

  const anyActive = snapshot.sessions.some((s) => s.action !== "idle");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyActive]);

  return { snapshot, focus, pinnedId: pinned !== undefined ? pinnedId : null, onTogglePin, now };
}

export interface PipHandle {
  /** The open PiP window, or null while the content renders in its carrier. */
  readonly pipWindow: Window | null;
  /** Whether the browser exposes Document PiP (Chrome-only today). */
  readonly pipSupported: boolean;
  /**
   * Upgrade the content into a native PiP window. Rejects silently without a
   * user gesture (or when closed mid-request): the carrier keeps the content.
   */
  readonly popOut: (size?: { width: number; height: number }) => void;
}

export function usePip(): PipHandle {
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const popOut = useCallback((size?: { width: number; height: number }): void => {
    const pip = pipApi();
    if (pip === undefined) return;
    void pip
      .requestWindow(size)
      .then((win) => {
        cloneStylesInto(win);
        win.addEventListener("pagehide", () => setPipWindow(null));
        setPipWindow(win);
      })
      .catch(() => {});
  }, []);
  return { pipWindow, pipSupported: pipApi() !== undefined, popOut };
}
