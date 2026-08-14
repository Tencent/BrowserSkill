// Observation overlay: the default in-app carrier for live session watching.
// Expanded = draggable/resizable floating card (bottom-right); collapsed = a
// status capsule; "pop out" upgrades the same content to a native Document
// PiP window (user gesture required by the browser). Pure client state —
// position/size/collapse live for the page lifetime only.

import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import type { SessionObservation } from "../observation";
import css from "./ObservationOverlay.module.css";
import type { ObservationClientStore } from "./observation-store";

/** Minimal Document PiP surface (TS lib.dom lacks it). */
interface DocumentPip {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

interface Point {
  x: number;
  y: number;
}

interface Size {
  w: number;
  h: number;
}

const DEFAULT_SIZE: Size = { w: 320, h: 240 };
const MIN_SIZE: Size = { w: 240, h: 180 };
const EDGE_MARGIN = 16;

function pipApi(): DocumentPip | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { documentPictureInPicture?: DocumentPip }).documentPictureInPicture;
}

function clampSize(size: Size, viewport: Size): Size {
  const maxW = viewport.w * 0.8;
  const maxH = viewport.h * 0.8;
  return {
    w: Math.min(Math.max(size.w, MIN_SIZE.w), maxW),
    h: Math.min(Math.max(size.h, MIN_SIZE.h), maxH),
  };
}

function clampPos(pos: Point, size: Size, viewport: Size): Point {
  return {
    x: Math.min(Math.max(pos.x, 0), Math.max(0, viewport.w - size.w)),
    y: Math.min(Math.max(pos.y, 0), Math.max(0, viewport.h - size.h)),
  };
}

function formatElapsed(sinceMs: number, nowMs: number): string {
  const total = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/** Focus = most recently active session (action or latest state change). */
export function focusOf(sessions: readonly SessionObservation[]): SessionObservation | undefined {
  if (sessions.length === 0) return undefined;
  return sessions.reduce((a, b) => (a.since >= b.since ? a : b));
}

export function statusOf(obs: SessionObservation): "active" | "idle" | "error" {
  if (obs.lastError !== undefined && obs.action === "idle") return "error";
  return obs.action === "idle" ? "idle" : "active";
}

/** The floating card / PiP shared content. */
function OverlayBody(props: {
  store: ObservationClientStore;
  focus: SessionObservation | undefined;
  now: number;
  onPopOut?: (() => void) | undefined;
  onCollapse?: (() => void) | undefined;
  inPip: boolean;
  onHeaderPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const { store, focus, now, onPopOut, onCollapse, inPip, onHeaderPointerDown } = props;
  const [interrupting, setInterrupting] = useState(false);
  const [hintOpen, setHintOpen] = useState(false);
  const [hintSeen, setHintSeen] = useState(false);

  const thumbId = focus?.thumbnailAttachmentId;
  useEffect(() => {
    store.ensureThumbnail(thumbId);
  }, [store, thumbId]);
  const thumb = thumbId !== undefined ? store.getSnapshot().thumbnails[thumbId] : undefined;

  const canInterrupt = !interrupting && focus !== undefined && focus.action !== "idle";
  const onInterrupt = (): void => {
    if (!canInterrupt || focus === undefined) return;
    setHintSeen(true);
    setHintOpen(false);
    setInterrupting(true);
    void store.interrupt(focus.sessionId).finally(() => setInterrupting(false));
  };

  const actionText =
    focus === undefined ? "no session" : focus.action === "idle" ? "idle" : focus.action;
  const elapsed = focus !== undefined ? formatElapsed(focus.since, now) : "00:00";
  const state = focus !== undefined ? statusOf(focus) : "idle";

  return (
    <div className={css.body} data-state={state} data-in-pip={inPip || undefined}>
      <div
        className={css.header}
        data-testid="obs-header"
        onPointerDown={onHeaderPointerDown}
        role="presentation"
      >
        <span className={css.dot} data-state={state} aria-hidden />
        <span className={css["status-text"]}>
          {focus === undefined
            ? "browser sessions"
            : `${focus.sessionId} · ${actionText} · ${elapsed}`}
        </span>
        {onCollapse !== undefined ? (
          <button
            type="button"
            className={css["icon-button"]}
            aria-label="Collapse"
            onClick={onCollapse}
          >
            —
          </button>
        ) : null}
      </div>
      <div className={css.stage}>
        {thumb?.status === "ready" && thumb.url !== undefined ? (
          <img
            key={thumb.url}
            className={css.thumb}
            src={thumb.url}
            alt={`session ${focus?.sessionId ?? ""} view`}
          />
        ) : (
          <div className={css.placeholder}>
            {thumb?.status === "error" ? "frame unavailable" : "waiting for page"}
          </div>
        )}
        {thumb?.status === "error" ? (
          <span className={css.badge} aria-label="thumbnail failed">
            !
          </span>
        ) : null}
      </div>
      <div className={css.actions}>
        <span className={css["interrupt-wrap"]}>
          <button
            type="button"
            className={css.interrupt}
            disabled={!canInterrupt}
            aria-label="Interrupt the current browser action"
            onPointerEnter={() => {
              if (!hintSeen) setHintOpen(true);
            }}
            onPointerLeave={() => setHintOpen(false)}
            onClick={onInterrupt}
          >
            {interrupting ? "Interrupting…" : "Interrupt"}
          </button>
          {hintOpen && !hintSeen ? (
            <span className={css.hint} role="tooltip">
              Interrupt stops only the current browser action — the agent run continues (use the
              chat Stop button to halt the run).
            </span>
          ) : null}
        </span>
        {onPopOut !== undefined ? (
          <button
            type="button"
            className={css.popout}
            aria-label="Pop out into a mini window"
            onClick={onPopOut}
          >
            Pop out
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Clone the host document's style/link nodes into a PiP window. */
function cloneStylesInto(pipWindow: Window): void {
  for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
    pipWindow.document.head.appendChild(node.cloneNode(true));
  }
}

export function ObservationOverlay({ store }: { store: ObservationClientStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  const [collapsed, setCollapsed] = useState(false);
  const [pos, setPos] = useState<Point | null>(null);
  const [size, setSize] = useState<Size>(DEFAULT_SIZE);
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const dragRef = useRef<{
    kind: "move" | "resize";
    startX: number;
    startY: number;
    base: Point & Size;
  } | null>(null);

  // Elapsed-time ticker: 1s while anything is active.
  const focus = focusOf(snapshot.sessions);
  const anyActive = snapshot.sessions.some((s) => s.action !== "idle");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyActive]);

  const viewport = (): Size => ({ w: window.innerWidth, h: window.innerHeight });

  const onPointerMove = useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (drag === null) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (drag.kind === "move") {
      setPos(
        clampPos(
          { x: drag.base.x + dx, y: drag.base.y + dy },
          { w: drag.base.w, h: drag.base.h },
          viewport(),
        ),
      );
    } else {
      setSize(clampSize({ w: drag.base.w + dx, h: drag.base.h + dy }, viewport()));
    }
  }, []);
  const onPointerUp = useCallback(() => {
    dragRef.current = null;
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
  }, [onPointerMove]);

  const beginDrag = (kind: "move" | "resize") => (event: ReactPointerEvent) => {
    event.preventDefault();
    const rect = (
      event.currentTarget.closest("[data-obs-card]") as HTMLElement | null
    )?.getBoundingClientRect();
    const base = {
      x: rect?.left ?? pos?.x ?? viewport().w - size.w - EDGE_MARGIN,
      y: rect?.top ?? pos?.y ?? viewport().h - size.h - EDGE_MARGIN,
      w: rect?.width ?? size.w,
      h: rect?.height ?? size.h,
    };
    dragRef.current = { kind, startX: event.clientX, startY: event.clientY, base };
    if (kind === "move") setPos({ x: base.x, y: base.y });
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  };

  const popOut = async (): Promise<void> => {
    const pip = pipApi();
    if (pip === undefined) return;
    const win = await pip.requestWindow({ width: size.w, height: size.h });
    cloneStylesInto(win);
    win.addEventListener("pagehide", () => setPipWindow(null));
    setPipWindow(win);
  };

  // Hidden while no owned session exists (and no PiP is up).
  if (snapshot.sessions.length === 0 && pipWindow === null) return null;

  const body = (
    <OverlayBody
      store={store}
      focus={focus}
      now={now}
      inPip={pipWindow !== null}
      onPopOut={pipWindow === null && pipApi() !== undefined ? () => void popOut() : undefined}
      onCollapse={pipWindow === null ? () => setCollapsed(true) : undefined}
      onHeaderPointerDown={pipWindow === null ? beginDrag("move") : undefined}
    />
  );

  if (pipWindow !== null) {
    return createPortal(body, pipWindow.document.body);
  }

  if (collapsed) {
    const state = focus !== undefined ? statusOf(focus) : "idle";
    return (
      <button
        type="button"
        className={css.capsule}
        data-state={state}
        aria-label="Expand browser observation overlay"
        onClick={() => setCollapsed(false)}
      >
        <span className={css.dot} data-state={state} aria-hidden />
        <span className={css["capsule-text"]}>
          {snapshot.sessions.length} session{snapshot.sessions.length === 1 ? "" : "s"}
          {focus !== undefined && focus.action !== "idle"
            ? ` · ${focus.action} · ${formatElapsed(focus.since, now)}`
            : ""}
        </span>
      </button>
    );
  }

  const style: React.CSSProperties =
    pos !== null
      ? { left: pos.x, top: pos.y, width: size.w, height: size.h }
      : { right: EDGE_MARGIN, bottom: EDGE_MARGIN, width: size.w, height: size.h };
  return (
    <div className={css.card} style={style} data-obs-card data-testid="obs-card">
      {body}
      <div
        className={css["resize-handle"]}
        data-testid="obs-resize"
        aria-label="Resize overlay"
        role="separator"
        onPointerDown={beginDrag("resize")}
      />
    </div>
  );
}
