// Observation overlay: the default in-app carrier for live session watching.
// Expanded = draggable/resizable floating card (top-right, out of the
// composer's way); collapsed = a status capsule; "pop out" upgrades the same
// content to a native Document PiP window (user gesture required by the
// browser). Multi-session renders a meeting-style strip under the focus view.
// Visuals ride dsh's shared primitives and --dsw-alias-* tokens throughout,
// so the card reads as a native part of the shell, not a foreign widget.

import {
  Button,
  IconChevronDownOutline14,
  IconRightUpOutline16,
  IconStopFill16,
  IconWarningOutline16,
  StateDot,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
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

function dotStateOf(
  state: "active" | "idle" | "error" | "dead",
): "done" | "ongoing" | "error" | "warning" {
  switch (state) {
    case "active":
      return "ongoing";
    case "error":
      return "error";
    case "dead":
      return "warning";
    default:
      return "done";
  }
}

/** One strip item: mini frame, id, status dot, hover interrupt, pin toggle. */
function StripItem(props: {
  store: ObservationClientStore;
  obs: SessionObservation;
  pinned: boolean;
  focused: boolean;
  onTogglePin: (sessionId: string) => void;
}) {
  const { store, obs, pinned, focused, onTogglePin } = props;
  const [hover, setHover] = useState(false);
  const thumbId = obs.thumbnailAttachmentId;
  useEffect(() => {
    store.ensureThumbnail(thumbId);
  }, [store, thumbId]);
  const thumb = thumbId !== undefined ? store.getSnapshot().thumbnails[thumbId] : undefined;
  const state = obs.dead === true ? "dead" : statusOf(obs);
  return (
    <div
      className={css["strip-item"]}
      data-state={state}
      data-focused={focused || undefined}
      data-pinned={pinned || undefined}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      <button
        type="button"
        className={css["strip-main"]}
        aria-label={`${pinned ? "Unpin" : "Pin"} session ${obs.sessionId}`}
        aria-pressed={pinned}
        onClick={() => onTogglePin(obs.sessionId)}
      >
        <span className={css["strip-thumb"]}>
          {thumb?.status === "ready" && thumb.url !== undefined ? (
            <img src={thumb.url} alt="" />
          ) : (
            <span className={css["strip-thumb-empty"]} />
          )}
        </span>
        <span className={css["strip-id"]}>{obs.sessionId}</span>
        <StateDot state={dotStateOf(state)} />
        {pinned ? (
          <svg
            className={css["pin-badge"]}
            width="9"
            height="9"
            viewBox="0 0 10 10"
            aria-label="pinned"
          >
            <path
              d="M6.5 0.8 9.2 3.5 8.3 4.4 7.9 4 6.2 6.9 6.6 8.7 6 9.4 3.4 5.4 1 7.9 0.6 7.3 2.5 6 3.1 6.6 5.9 2.1 5.5 1.7Z"
              fill="currentColor"
            />
          </svg>
        ) : null}
      </button>
      {hover && !pinned && obs.dead !== true ? (
        <button
          type="button"
          className={css["strip-interrupt"]}
          aria-label={`Interrupt session ${obs.sessionId}`}
          disabled={obs.action === "idle"}
          onClick={(event) => {
            event.stopPropagation();
            void store.interrupt(obs.sessionId);
          }}
        >
          <IconStopFill16 size={8} />
        </button>
      ) : null}
    </div>
  );
}

/** The floating card / PiP shared content. */
function OverlayBody(props: {
  store: ObservationClientStore;
  focus: SessionObservation | undefined;
  sessions: readonly SessionObservation[];
  available: boolean;
  pinnedId: string | null;
  onTogglePin: (sessionId: string) => void;
  now: number;
  onPopOut?: (() => void) | undefined;
  onCollapse?: (() => void) | undefined;
  inPip: boolean;
  onHeaderPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const {
    store,
    focus,
    sessions,
    available,
    pinnedId,
    onTogglePin,
    now,
    onPopOut,
    onCollapse,
    inPip,
    onHeaderPointerDown,
  } = props;
  const [interrupting, setInterrupting] = useState(false);
  // One-time semantics hint: a shared Tooltip that retires after first use.
  const [hintSeen, setHintSeen] = useState(false);

  const thumbId = focus?.thumbnailAttachmentId;
  useEffect(() => {
    store.ensureThumbnail(thumbId);
  }, [store, thumbId]);
  const thumb = thumbId !== undefined ? store.getSnapshot().thumbnails[thumbId] : undefined;

  const canInterrupt =
    available &&
    !interrupting &&
    focus !== undefined &&
    focus.action !== "idle" &&
    focus.dead !== true;
  const onInterrupt = (): void => {
    if (!canInterrupt || focus === undefined) return;
    setHintSeen(true);
    setInterrupting(true);
    void store.interrupt(focus.sessionId).finally(() => setInterrupting(false));
  };

  const statusText = !available
    ? "browser unavailable"
    : focus === undefined
      ? "no session"
      : `${focus.sessionId} · ${focus.action === "idle" ? "idle" : focus.action} · ${formatElapsed(focus.since, now)}`;
  const state = !available ? "error" : focus !== undefined ? statusOf(focus) : "idle";

  return (
    <div className={css.body} data-state={state} data-in-pip={inPip || undefined}>
      <div
        className={css.header}
        data-testid="obs-header"
        onPointerDown={onHeaderPointerDown}
        role="presentation"
      >
        <StateDot state={state === "error" ? "error" : state === "active" ? "ongoing" : "done"} />
        <span className={css["status-text"]}>{statusText}</span>
        {onCollapse !== undefined ? (
          <button
            type="button"
            className={css["icon-button"]}
            aria-label="Collapse"
            onClick={onCollapse}
          >
            <IconChevronDownOutline14 />
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
            {!available
              ? "last frame kept"
              : thumb?.status === "error"
                ? "frame unavailable"
                : "waiting for page"}
          </div>
        )}
        {thumb?.status === "error" ? (
          <span className={css.badge} aria-label="thumbnail failed">
            <IconWarningOutline16 size={12} />
          </span>
        ) : null}
      </div>
      {sessions.length >= 2 ? (
        <div className={css.strip} data-testid="obs-strip" role="list">
          {sessions.map((obs) => (
            <StripItem
              key={obs.sessionId}
              store={store}
              obs={obs}
              pinned={pinnedId === obs.sessionId}
              focused={focus?.sessionId === obs.sessionId}
              onTogglePin={onTogglePin}
            />
          ))}
        </div>
      ) : null}
      <div className={css.actions}>
        <Tooltip
          label="Interrupt stops only the current browser action — the agent run continues (use the chat Stop button to halt the run)."
          side="top"
          maxWidth={240}
          disabled={hintSeen}
        >
          <span className={css["interrupt-wrap"]}>
            <Button
              variant="outline"
              size="sm"
              className={css.interrupt}
              icon={<IconStopFill16 />}
              disabled={!canInterrupt}
              aria-label="Interrupt the current browser action"
              onClick={onInterrupt}
            >
              {interrupting ? "Interrupting…" : "Interrupt"}
            </Button>
          </span>
        </Tooltip>
        {onPopOut !== undefined ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<IconRightUpOutline16 />}
            aria-label="Pop out into a mini window"
            onClick={onPopOut}
          >
            Pop out
          </Button>
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
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const dragRef = useRef<{
    kind: "move" | "resize";
    startX: number;
    startY: number;
    base: Point & Size;
  } | null>(null);

  // Elapsed-time ticker: 1s while anything is active.
  const anyActive = snapshot.sessions.some((s) => s.action !== "idle");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyActive]);

  // Focus: the pinned session wins while it still exists; otherwise auto-follow.
  const pinned =
    pinnedId !== null ? snapshot.sessions.find((s) => s.sessionId === pinnedId) : undefined;
  const focus = pinned ?? focusOf(snapshot.sessions);
  const onTogglePin = useCallback((sessionId: string) => {
    setPinnedId((current) => (current === sessionId ? null : sessionId));
  }, []);

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
      y: rect?.top ?? pos?.y ?? EDGE_MARGIN,
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
      sessions={snapshot.sessions}
      available={snapshot.available}
      pinnedId={pinned !== undefined ? pinnedId : null}
      onTogglePin={onTogglePin}
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
        <StateDot state={dotStateOf(state)} />
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
      : { right: EDGE_MARGIN, top: EDGE_MARGIN, width: size.w, height: size.h };
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
