import { useTranslation } from "@browser-skill/i18n/react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import recordIconUrl from "../../assets/record-icon.png";

export interface RecordRequestData {
  id: string;
  /**
   * Epoch ms when the recording began. Supplied by the background so the timer
   * keeps counting the whole session across navigations; falls back to mount
   * time when the background could not report it.
   */
  startedAtMs?: number;
  onFinish: () => void;
}

type Props = {
  request: RecordRequestData | null;
};

const VIEWPORT_MARGIN = 16;
const DRAG_THRESHOLD_PX = 8;
const INTRO_DURATION_MS = 10_000;
const TIMER_REFRESH_MS = 250;

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampDragPos(
  top: number,
  left: number,
  panelW: number,
  panelH: number,
): { top: number; left: number } {
  const maxLeft = window.innerWidth - panelW - VIEWPORT_MARGIN;
  const maxTop = window.innerHeight - panelH - VIEWPORT_MARGIN;
  return {
    top: clamp(top, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, maxTop)),
    left: clamp(left, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, maxLeft)),
  };
}

export function RecordOverlay({ request }: Props) {
  const { t } = useTranslation("extension");
  const [show, setShow] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [dragPos, setDragPos] = useState<{ top: number; left: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const pillRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    originLeft: number;
    originTop: number;
    panelW: number;
    panelH: number;
    armed: boolean;
  } | null>(null);

  useEffect(() => {
    if (request) {
      const raf = requestAnimationFrame(() => setShow(true));
      return () => cancelAnimationFrame(raf);
    }
    setShow(false);
  }, [request]);

  const requestStartedAtMs = request?.startedAtMs;

  useEffect(() => {
    setDragPos(null);
    setDragging(false);
    dragStartRef.current = null;
    if (!request) {
      setElapsedSeconds(0);
      return;
    }

    const startedAt = requestStartedAtMs ?? Date.now();
    const updateElapsed = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)));
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, TIMER_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [request?.id, requestStartedAtMs]);

  const onPillPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest("button, a, input, textarea, select")) {
      return;
    }
    const pill = pillRef.current;
    if (!pill) return;
    const rect = pill.getBoundingClientRect();
    dragStartRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      originLeft: rect.left,
      originTop: rect.top,
      panelW: pill.offsetWidth || rect.width,
      panelH: pill.offsetHeight || rect.height,
      armed: false,
    };
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const dx = e.clientX - start.pointerX;
      const dy = e.clientY - start.pointerY;
      if (!start.armed) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        start.armed = true;
        setDragging(true);
        setDragPos({ top: start.originTop, left: start.originLeft });
      }
      setDragPos(
        clampDragPos(start.originTop + dy, start.originLeft + dx, start.panelW, start.panelH),
      );
    };
    const onUp = () => {
      const start = dragStartRef.current;
      if (!start) return;
      if (start.armed) {
        setDragging(false);
      }
      dragStartRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  if (!request) return null;

  const introVisible = elapsedSeconds * 1_000 < INTRO_DURATION_MS;
  const positioned = dragPos !== null;
  const defaultTransform = show
    ? "translateX(-50%) translateY(0)"
    : "translateX(-50%) translateY(8px)";

  return (
    <>
      <style>{`
        @keyframes bsk-rec-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.35; transform: scale(0.82); }
        }
      `}</style>

      <div
        ref={pillRef}
        data-slot="record-overlay-pill"
        data-phase={introVisible ? "intro" : "timer"}
        data-dragging={dragging ? "true" : "false"}
        onPointerDown={onPillPointerDown}
        style={{
          position: "fixed",
          ...(positioned
            ? { top: dragPos.top, left: dragPos.left, bottom: "auto" }
            : { bottom: 32, left: "50%" }),
          zIndex: 2147483647,
          pointerEvents: "auto",
          display: "flex",
          alignItems: "center",
          gap: 5,
          backgroundColor: "#fff",
          borderRadius: 9999,
          height: 50,
          boxSizing: "border-box",
          padding: "6px 8px 6px 16px",
          boxShadow: dragging
            ? "0 12px 40px rgba(15,23,42,0.22), 0 2px 8px rgba(0,0,0,0.12)"
            : "0 8px 32px rgba(15,23,42,0.16), 0 2px 8px rgba(0,0,0,0.1)",
          opacity: show ? 1 : 0,
          transform: positioned ? "none" : defaultTransform,
          transition: dragging
            ? "box-shadow 150ms ease-out"
            : "opacity 300ms ease-out, transform 300ms ease-out, box-shadow 150ms ease-out",
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          maxWidth: "min(420px, calc(100vw - 32px))",
          cursor: dragging ? "grabbing" : "grab",
          userSelect: "none",
          touchAction: "none",
        }}
      >
        <div
          data-slot="record-overlay-status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
            flex: 1,
            borderRadius: 9999,
            outline: "none",
            minHeight: 32,
            paddingRight: 4,
          }}
        >
          <span
            data-slot="record-overlay-indicator"
            style={{
              width: 9,
              height: 9,
              borderRadius: "50%",
              backgroundColor: "#ef4444",
              flexShrink: 0,
              animation: "bsk-rec-pulse 1.4s ease-in-out infinite",
            }}
          />
          <span
            data-slot="record-overlay-label"
            style={{
              display: "block",
              flex: "0 1 auto",
              fontSize: 16,
              fontWeight: 500,
              color: "#333",
              whiteSpace: "nowrap",
              userSelect: "none",
              overflow: "hidden",
              textOverflow: "ellipsis",
              width: introVisible ? "auto" : 48,
              maxWidth: introVisible ? 280 : 48,
              fontVariantNumeric: introVisible ? undefined : "tabular-nums",
              textAlign: introVisible ? "left" : "center",
              margin: 0,
              padding: 0,
              minWidth: 0,
              transition: "max-width 180ms ease-out",
            }}
          >
            {introVisible ? t("recordOverlay.recording") : formatElapsed(elapsedSeconds)}
          </span>
        </div>
        <button
          type="button"
          data-slot="record-overlay-finish"
          aria-label={t("recordOverlay.finish")}
          onClick={request.onFinish}
          style={{
            pointerEvents: "auto",
            display: "block",
            width: 32,
            height: 32,
            border: "none",
            borderRadius: 9999,
            padding: 0,
            backgroundColor: "transparent",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <img
            src={recordIconUrl}
            alt=""
            width={24}
            height={24}
            draggable={false}
            style={{ display: "block", margin: "auto" }}
          />
        </button>
      </div>
    </>
  );
}
