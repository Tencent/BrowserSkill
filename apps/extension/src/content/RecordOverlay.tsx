import { useTranslation } from "@browser-skill/i18n/react";
import { RiDragMove2Line, RiStopCircleLine } from "@remixicon/react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export interface RecordRequestData {
  id: string;
  onFinish: () => void;
}

type Props = {
  request: RecordRequestData | null;
};

const VIEWPORT_MARGIN = 16;
const FALLBACK_PILL_WIDTH = 360;
const FALLBACK_PILL_HEIGHT = 54;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampDragPos(
  top: number,
  left: number,
  pillWidth: number,
  pillHeight: number,
): { top: number; left: number } {
  const maxLeft = window.innerWidth - pillWidth - VIEWPORT_MARGIN;
  const maxTop = window.innerHeight - pillHeight - VIEWPORT_MARGIN;
  return {
    top: clamp(top, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, maxTop)),
    left: clamp(left, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, maxLeft)),
  };
}

export function RecordOverlay({ request }: Props) {
  const { t } = useTranslation("extension");
  const [show, setShow] = useState(false);
  const [dragPos, setDragPos] = useState<{ top: number; left: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const pillRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    originLeft: number;
    originTop: number;
    pillWidth: number;
    pillHeight: number;
  } | null>(null);

  useEffect(() => {
    if (request) {
      const raf = requestAnimationFrame(() => setShow(true));
      return () => cancelAnimationFrame(raf);
    }
    setShow(false);
  }, [request]);

  useEffect(() => {
    setDragPos(null);
    setDragging(false);
    dragStartRef.current = null;
  }, [request?.id]);

  const onDragHandlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const pill = pillRef.current;
    if (!pill) return;
    const rect = pill.getBoundingClientRect();
    dragStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      originLeft: rect.left,
      originTop: rect.top,
      pillWidth: pill.offsetWidth || rect.width || FALLBACK_PILL_WIDTH,
      pillHeight: pill.offsetHeight || rect.height || FALLBACK_PILL_HEIGHT,
    };
    setDragPos({ top: rect.top, left: rect.left });
    setDragging(true);
    event.preventDefault();
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      setDragPos(
        clampDragPos(
          start.originTop + event.clientY - start.pointerY,
          start.originLeft + event.clientX - start.pointerX,
          start.pillWidth,
          start.pillHeight,
        ),
      );
    };
    const onUp = () => {
      setDragging(false);
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
  }, [dragging]);

  if (!request) return null;

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
        data-dragging={dragging ? "true" : "false"}
        style={{
          position: "fixed",
          top: dragPos?.top,
          bottom: dragPos ? "auto" : 32,
          left: dragPos?.left ?? "50%",
          zIndex: 2147483647,
          pointerEvents: "auto",
          display: "flex",
          alignItems: "center",
          gap: 10,
          backgroundColor: "#fff",
          borderRadius: 9999,
          padding: "10px 10px 10px 20px",
          boxShadow: "0 8px 32px rgba(15,23,42,0.16), 0 2px 8px rgba(0,0,0,0.1)",
          opacity: show ? 1 : 0,
          transform: dragPos
            ? show
              ? "none"
              : "translateY(8px)"
            : show
              ? "translateX(-50%) translateY(0)"
              : "translateX(-50%) translateY(8px)",
          transition: dragging ? "none" : "opacity 300ms ease-out, transform 300ms ease-out",
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          maxWidth: "min(420px, calc(100vw - 32px))",
        }}
      >
        <div
          data-slot="record-overlay-drag-handle"
          role="img"
          aria-label={t("recordOverlay.dragHandle")}
          onPointerDown={onDragHandlePointerDown}
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            marginLeft: -8,
            padding: 4,
            color: dragging ? "#4b5563" : "#9ca3af",
            cursor: dragging ? "grabbing" : "grab",
            touchAction: "none",
            userSelect: "none",
          }}
        >
          <RiDragMove2Line size={18} aria-hidden />
        </div>
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
          style={{
            flex: 1,
            fontSize: 16,
            fontWeight: 500,
            color: "#333",
            whiteSpace: "nowrap",
            userSelect: "none",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {t("recordOverlay.recording")}
        </span>
        <button
          type="button"
          data-slot="record-overlay-finish"
          onClick={request.onFinish}
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 6,
            border: "none",
            borderRadius: 9999,
            padding: "8px 20px 8px 16px",
            fontSize: 15,
            fontWeight: 600,
            color: "#fff",
            backgroundColor: "#f97316",
            cursor: "pointer",
            transition: "background-color 150ms ease-out, opacity 150ms ease-out",
            whiteSpace: "nowrap",
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          <RiStopCircleLine size={18} color="#fff" />
          {t("recordOverlay.finish")}
        </button>
      </div>
    </>
  );
}
