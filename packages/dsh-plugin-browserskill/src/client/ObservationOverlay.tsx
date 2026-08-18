// Observation overlay: the default in-app carrier for live session watching.
// Expanded = draggable/resizable floating card (top-right, out of the
// composer's way); collapsed = a status capsule; "pop out" upgrades the same
// content to a native Document PiP window (user gesture required by the
// browser). Multi-session renders a meeting-style strip under the focus view.
// Visuals follow the BrowserSkill product family: @browser-skill/ui components
// and oklch tokens on a .bsk-obs scope root, so the card reads as BSK's own
// surface without leaking styles into (or inheriting themes from) the shell.

import { cn } from "@browser-skill/ui";
import {
  RiArrowDownSLine,
  RiErrorWarningLine,
  RiPictureInPicture2Line,
  RiPushpinFill,
  RiStopCircleLine,
} from "@remixicon/react";

// remixicon's component types target @types/react 19 while the dsh shell
// runs react 18 — a compile-time-only recast keeps the 18 typecheck happy.
type IconComponent = (props: { size?: number | string; className?: string }) => ReactNode;
const asIcon = (component: unknown): IconComponent => component as IconComponent;
const IconStop = asIcon(RiStopCircleLine);
const IconPip = asIcon(RiPictureInPicture2Line);
const IconDown = asIcon(RiArrowDownSLine);
const IconWarn = asIcon(RiErrorWarningLine);
const IconPin = asIcon(RiPushpinFill);

import {
  type ReactNode,
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
/** Default dock: top-right, just under the shell's top bar (no spacing tokens exist in dsh 0.1). */
const TOP_OFFSET = 64;

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

export type ResizeCorner = "nw" | "ne" | "sw" | "se";

/** Grow/shrink from one corner, keeping the opposite corner planted. */
export function applyResize(
  base: Point & Size,
  corner: ResizeCorner,
  dx: number,
  dy: number,
  viewport: Size,
): { pos: Point; size: Size } {
  const nextW = corner === "ne" || corner === "se" ? base.w + dx : base.w - dx;
  const nextH = corner === "sw" || corner === "se" ? base.h + dy : base.h - dy;
  const size = clampSize({ w: nextW, h: nextH }, viewport);
  const x = corner === "nw" || corner === "sw" ? base.x + base.w - size.w : base.x;
  const y = corner === "nw" || corner === "ne" ? base.y + base.h - size.h : base.y;
  return { pos: clampPos({ x, y }, size, viewport), size };
}

const CORNER_LABEL: Record<ResizeCorner, string> = {
  nw: "top left",
  ne: "top right",
  sw: "bottom left",
  se: "bottom right",
};

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

/** Compact toolbar icon: no label, hover bubble for the name / semantics. */
function IconAction(props: {
  label: string;
  hint: string;
  disabled?: boolean;
  danger?: boolean;
  align?: "start" | "end";
  onClick: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className={css["tool-wrap"]}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className={cn(css["tool-button"], props.danger === true && css["tool-danger"])}
        disabled={props.disabled}
        aria-label={props.label}
        onClick={props.onClick}
      >
        {props.children}
      </button>
      {open ? (
        <span className={css.hint} data-align={props.align} role="tooltip">
          {props.hint}
        </span>
      ) : null}
    </span>
  );
}

/** Flat status dot, specced after the BSK popup's ConnectionStatusIndicator. */
function StatusDot({ state }: { state: "active" | "idle" | "error" | "dead" }) {
  const color =
    state === "active"
      ? "bg-emerald-500"
      : state === "error"
        ? "bg-red-500"
        : state === "dead"
          ? "bg-amber-500"
          : "bg-muted-foreground/40";
  return (
    <span
      className={cn("size-2 shrink-0 rounded-full ring-2 ring-background", color)}
      data-state={state}
      aria-hidden
    />
  );
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
  const thumb = store.getSnapshot().displayFrames[obs.sessionId];
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
          {thumb?.url !== undefined ? (
            <img src={thumb.url} alt="" />
          ) : (
            <span className={css["strip-thumb-empty"]} />
          )}
        </span>
        <span className={css["strip-id"]}>{obs.sessionId}</span>
        <StatusDot state={state} />
        {pinned ? <IconPin size={9} className={css["pin-badge"]} aria-label="pinned" /> : null}
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
          <IconStop size={10} />
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

  const thumbId = focus?.thumbnailAttachmentId;
  useEffect(() => {
    store.ensureThumbnail(thumbId);
  }, [store, thumbId]);
  // Paint the last good frame while the next attachment decodes — swapping
  // to a placeholder (and remounting <img> with a fade) is what made the
  // card flash on every breath / action-end capture.
  const thumb =
    focus !== undefined ? store.getSnapshot().displayFrames[focus.sessionId] : undefined;
  const displayUrl = thumb?.url;

  const canInterrupt =
    available &&
    !interrupting &&
    focus !== undefined &&
    focus.action !== "idle" &&
    focus.dead !== true;
  const onInterrupt = (): void => {
    if (!canInterrupt || focus === undefined) return;
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
    <div className={cn(css.body, "bsk-obs")} data-state={state} data-in-pip={inPip || undefined}>
      <div
        className={css.header}
        data-testid="obs-header"
        onPointerDown={onHeaderPointerDown}
        role="presentation"
      >
        <StatusDot state={state === "error" ? "error" : state === "active" ? "active" : "idle"} />
        <span className={css["status-text"]}>{statusText}</span>
        {onCollapse !== undefined ? (
          <button
            type="button"
            className={css["icon-button"]}
            aria-label="Collapse"
            onClick={onCollapse}
          >
            <IconDown size={14} />
          </button>
        ) : null}
      </div>
      <div className={css.stage}>
        {displayUrl !== undefined ? (
          <img
            className={css.thumb}
            src={displayUrl}
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
            <IconWarn size={12} />
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
        <IconAction
          label={interrupting ? "Interrupting…" : "Interrupt the current browser action"}
          hint="Stop the current browser action."
          disabled={!canInterrupt}
          danger
          onClick={onInterrupt}
        >
          <IconStop size={16} />
        </IconAction>
        {onPopOut !== undefined ? (
          <IconAction
            label="Pop out into a mini window"
            hint="Pop out into a mini window"
            align="end"
            onClick={onPopOut}
          >
            <IconPip size={16} />
          </IconAction>
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
    corner?: ResizeCorner;
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
    } else if (drag.corner !== undefined) {
      const next = applyResize(drag.base, drag.corner, dx, dy, viewport());
      setPos(next.pos);
      setSize(next.size);
    }
  }, []);
  const onPointerUp = useCallback(() => {
    dragRef.current = null;
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
  }, [onPointerMove]);

  const cardOrigin = (): Point & Size => {
    const vp = viewport();
    return {
      x: pos?.x ?? vp.w - size.w - EDGE_MARGIN,
      y: pos?.y ?? TOP_OFFSET,
      w: size.w,
      h: size.h,
    };
  };

  const beginMove = (event: ReactPointerEvent) => {
    event.preventDefault();
    const rect = (
      event.currentTarget.closest("[data-obs-card]") as HTMLElement | null
    )?.getBoundingClientRect();
    const origin = cardOrigin();
    const base = {
      x: rect?.left ?? origin.x,
      y: rect?.top ?? origin.y,
      w: rect !== undefined && rect.width > 0 ? rect.width : origin.w,
      h: rect !== undefined && rect.height > 0 ? rect.height : origin.h,
    };
    dragRef.current = { kind: "move", startX: event.clientX, startY: event.clientY, base };
    setPos({ x: base.x, y: base.y });
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  };

  const beginResize = (corner: ResizeCorner) => (event: ReactPointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = (
      event.currentTarget.closest("[data-obs-card]") as HTMLElement | null
    )?.getBoundingClientRect();
    const origin = cardOrigin();
    const base = {
      x: rect?.left ?? origin.x,
      y: rect?.top ?? origin.y,
      w: rect !== undefined && rect.width > 0 ? rect.width : origin.w,
      h: rect !== undefined && rect.height > 0 ? rect.height : origin.h,
    };
    dragRef.current = {
      kind: "resize",
      corner,
      startX: event.clientX,
      startY: event.clientY,
      base,
    };
    setPos({ x: base.x, y: base.y });
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  };

  const popOut = async (): Promise<void> => {
    const pip = pipApi();
    if (pip === undefined) return;
    try {
      const win = await pip.requestWindow({ width: size.w, height: size.h });
      cloneStylesInto(win);
      win.addEventListener("pagehide", () => setPipWindow(null));
      setPipWindow(win);
    } catch {
      // requestWindow rejects without a user gesture (or when the window was
      // closed mid-request): stay on the in-page card, no state change.
    }
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
      onHeaderPointerDown={pipWindow === null ? beginMove : undefined}
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
        className={cn(css.capsule, "bsk-obs")}
        data-state={state}
        aria-label="Expand browser observation overlay"
        onClick={() => setCollapsed(false)}
      >
        <StatusDot state={state} />
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
      : { right: EDGE_MARGIN, top: TOP_OFFSET, width: size.w, height: size.h };
  return (
    <div className={cn(css.card, "bsk-obs")} style={style} data-obs-card data-testid="obs-card">
      {body}
      {(["nw", "ne", "sw", "se"] as const).map((corner) => (
        <div
          key={corner}
          className={css["resize-handle"]}
          data-corner={corner}
          data-testid={`obs-resize-${corner}`}
          aria-label={`Resize overlay from the ${CORNER_LABEL[corner]}`}
          role="separator"
          aria-valuenow={size.w}
          aria-valuetext={`${Math.round(size.w)} by ${Math.round(size.h)} pixels`}
          aria-valuemin={MIN_SIZE.w}
          aria-valuemax={Math.round(viewport().w * 0.8)}
          tabIndex={corner === "se" ? 0 : -1}
          onPointerDown={beginResize(corner)}
          onKeyDown={
            corner === "se"
              ? (event) => {
                  const step = 16;
                  const dx =
                    event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
                  const dy = event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0;
                  if (dx === 0 && dy === 0) return;
                  event.preventDefault();
                  const next = applyResize(cardOrigin(), "se", dx, dy, viewport());
                  setPos(next.pos);
                  setSize(next.size);
                }
              : undefined
          }
        />
      ))}
    </div>
  );
}
