import { useEffect, useState } from "react";

/**
 * Cosmetic in-page agent cursor. Rendered by the content script inside the
 * existing `browser-skill-overlay` shadow tree, so it inherits the host's
 * `pointer-events: none` and is removed from compositing while a capture is
 * suppressed (`data-bsk-capture-hidden`).
 *
 * The background sends one {@link CursorState} per action: `move` glides the
 * arrow to the target before the real CDP event fires, `click` adds a ripple
 * at the same point. When the agent goes quiet for
 * {@link IDLE_HIDE_MS} the cursor fades out; a `null` state (session reset /
 * explicit hide) removes it immediately.
 */

export interface CursorRipple {
  /** Monotonic per-tab id; each new id replays the ripple animation. */
  id: number;
  button: string;
}

export interface CursorState {
  /** Viewport CSS pixel, same space as `Input.dispatchMouseEvent`. */
  x: number;
  y: number;
  /** Glide time for this move; 0 means jump straight to the point. */
  durationMs: number;
  label?: string;
  ripple?: CursorRipple;
}

export interface CursorOverlayProps {
  state: CursorState | null;
}

const IDLE_HIDE_MS = 2500;
const FADE_MS = 300;
const RIPPLE_MS = 400;
const RIPPLE_SIZE_PX = 40;
const MAX_LABEL_CHARS = 40;

function rippleColor(button: string): string {
  if (button === "right") return "59,130,246";
  if (button === "middle") return "168,85,247";
  return "249,115,22";
}

function truncateLabel(label: string): string {
  return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS)}…` : label;
}

export function CursorOverlay({ state }: CursorOverlayProps) {
  const [visible, setVisible] = useState(true);

  // `state` is a fresh object per bridge message, so the idle timer restarts
  // on every move/click.
  useEffect(() => {
    if (!state) return;
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), IDLE_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  if (!state) return null;

  const ripple = state.ripple;

  return (
    <div
      data-slot="agent-cursor"
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        zIndex: 2147483647,
        pointerEvents: "none",
        opacity: visible ? 1 : 0,
        transform: `translate3d(${state.x}px, ${state.y}px, 0)`,
        // Two independent transitions on one element: the glide and the
        // fade after the agent goes idle.
        transition: `transform ${Math.max(state.durationMs, 0)}ms cubic-bezier(0.22, 1, 0.36, 1), opacity ${FADE_MS}ms ease-out`,
        willChange: "transform, opacity",
      }}
    >
      <style>{`
        @keyframes bsk-agent-cursor-ripple {
          0% { transform: scale(0.25); opacity: 0.55; }
          100% { transform: scale(1.6); opacity: 0; }
        }
      `}</style>

      <svg
        width="20"
        height="20"
        viewBox="0 0 20 20"
        aria-hidden="true"
        style={{
          display: "block",
          overflow: "visible",
          filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.35))",
        }}
      >
        <path
          d="M1.5 1.2 L1.5 16.1 L5.4 12.4 L8.2 18.6 L10.9 17.4 L8.1 11.3 L13.6 11.1 Z"
          fill="#ffffff"
          stroke="#1f2937"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>

      {state.label ? (
        <div
          data-slot="agent-cursor-label"
          className="truncate rounded-md bg-slate-900/85 px-2 py-0.5 text-[12px] font-medium text-white"
          style={{
            position: "absolute",
            left: 14,
            top: 16,
            maxWidth: 240,
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          {truncateLabel(state.label)}
        </div>
      ) : null}

      {ripple ? (
        <div
          key={ripple.id}
          data-slot="agent-cursor-ripple"
          data-button={ripple.button}
          style={{
            position: "absolute",
            left: -RIPPLE_SIZE_PX / 2,
            top: -RIPPLE_SIZE_PX / 2,
            width: RIPPLE_SIZE_PX,
            height: RIPPLE_SIZE_PX,
            borderRadius: "50%",
            pointerEvents: "none",
            backgroundColor: `rgba(${rippleColor(ripple.button)},0.45)`,
            border: `1.5px solid rgba(${rippleColor(ripple.button)},0.85)`,
            animation: `bsk-agent-cursor-ripple ${RIPPLE_MS}ms ease-out forwards`,
          }}
        />
      ) : null}
    </div>
  );
}
