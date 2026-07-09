import { useTranslation } from "@browser-skill/i18n/react";
import { RiArrowDownSLine } from "@remixicon/react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import logoUrl from "../../assets/logo.png";

export interface HelpRequestData {
  id: string;
  prompt: string;
  /** Custom overlay title; falls back to i18n when omitted. */
  title?: string;
  /** CSS selectors to scroll to + flash-highlight. */
  selectors: string[];
  onContinue: (note: string) => void;
  onCancel: () => void;
}

interface Props {
  request: HelpRequestData | null;
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface PanelPos {
  top?: number;
  bottom?: number;
  left: number;
  placement: PanelPlacement;
}

type PanelPlacement = "above" | "below";

const PANEL_GAP = 12;
const VIEWPORT_MARGIN = 16;
const PANEL_WIDTH = 420;
const FALLBACK_PANEL_H = 180;
const FALLBACK_PANEL_H_COLLAPSED = 44;

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

function boxesEqual(a: Box[], b: Box[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (box, i) =>
        box.top === b[i]?.top &&
        box.left === b[i]?.left &&
        box.width === b[i]?.width &&
        box.height === b[i]?.height,
    )
  );
}

function panelPosEqual(a: PanelPos | null, b: PanelPos | null): boolean {
  return (
    a?.top === b?.top &&
    a?.bottom === b?.bottom &&
    a?.left === b?.left &&
    a?.placement === b?.placement
  );
}

/** Union of multiple viewport boxes into one anchor rect. */
function unionBox(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  let top = Number.POSITIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const b of boxes) {
    top = Math.min(top, b.top);
    left = Math.min(left, b.left);
    right = Math.max(right, b.left + b.width);
    bottom = Math.max(bottom, b.top + b.height);
  }
  return { top, left, width: right - left, height: bottom - top };
}

function choosePlacement(anchor: Box, panelH: number): PanelPlacement {
  const viewportH = window.innerHeight;
  const anchorBottom = anchor.top + anchor.height;
  const spaceBelow = viewportH - anchorBottom;
  const spaceAbove = anchor.top;
  const minSpace = panelH + PANEL_GAP + VIEWPORT_MARGIN;

  if (spaceBelow >= minSpace) {
    return "below";
  }
  if (spaceAbove >= minSpace) {
    return "above";
  }
  return spaceBelow >= spaceAbove ? "below" : "above";
}

/** Place the panel near the anchor on a stable side, clamped to the viewport. */
function placePanel(
  anchor: Box,
  panelW: number,
  panelH: number,
  placement: PanelPlacement,
): PanelPos {
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const anchorBottom = anchor.top + anchor.height;
  const anchorCenterX = anchor.left + anchor.width / 2;

  const minCenterX = VIEWPORT_MARGIN + panelW / 2;
  const maxCenterX = viewportW - VIEWPORT_MARGIN - panelW / 2;
  const left =
    minCenterX <= maxCenterX ? clamp(anchorCenterX, minCenterX, maxCenterX) : viewportW / 2;

  if (placement === "below") {
    const top = clamp(
      anchorBottom + PANEL_GAP,
      VIEWPORT_MARGIN,
      viewportH - panelH - VIEWPORT_MARGIN,
    );
    return { top, left, placement };
  }

  let bottom = viewportH - anchor.top + PANEL_GAP;
  const maxBottom = Math.max(VIEWPORT_MARGIN, viewportH - panelH - VIEWPORT_MARGIN);
  bottom = clamp(bottom, VIEWPORT_MARGIN, maxBottom);
  return { bottom, left, placement };
}

/** Returns null for invalid selectors instead of throwing. */
function querySelectorSafe(selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

/** Resolve selectors to their first matching element's viewport rect. */
function measure(selectors: string[]): Box[] {
  const boxes: Box[] = [];
  for (const sel of selectors) {
    const el = querySelectorSafe(sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    boxes.push({ top: r.top, left: r.left, width: r.width, height: r.height });
  }
  return boxes;
}

export function HelpRequestOverlay({ request }: Props) {
  const { t } = useTranslation("extension");
  const [note, setNote] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [panelPos, setPanelPos] = useState<PanelPos | null>(null);
  const [dragPos, setDragPos] = useState<{ top: number; left: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const bannerRef = useRef<HTMLDivElement>(null);
  const lastScrolledIdRef = useRef<string | null>(null);
  const placementRef = useRef<{ requestId: string; placement: PanelPlacement } | null>(null);
  const userMovedRef = useRef(false);
  const dragStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    originLeft: number;
    originTop: number;
    panelW: number;
    panelH: number;
  } | null>(null);

  // Reset the note and collapse state whenever a new request appears.
  useEffect(() => {
    setNote("");
    setCollapsed(false);
    placementRef.current = null;
    setDragPos(null);
    setDragging(false);
    userMovedRef.current = false;
    dragStartRef.current = null;
  }, [request?.id]);

  // Scroll the first matched target into view once per distinct request id.
  useLayoutEffect(() => {
    if (!request) return;
    if (lastScrolledIdRef.current === request.id) return;
    for (const sel of request.selectors) {
      const el = querySelectorSafe(sel);
      if (el) {
        lastScrolledIdRef.current = request.id;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        break;
      }
    }
  }, [request]);

  // Keep highlight boxes aligned with the page as it scrolls / resizes.
  useEffect(() => {
    if (!request) {
      setBoxes([]);
      return;
    }
    const update = () => {
      const nextBoxes = measure(request.selectors);
      setBoxes((prev) => (boxesEqual(prev, nextBoxes) ? prev : nextBoxes));
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    const interval = window.setInterval(update, 500);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      window.clearInterval(interval);
    };
  }, [request]);

  const onHeaderPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      if (e.target instanceof Element && e.target.closest("button, input, textarea, a, select"))
        return;
      const banner = bannerRef.current;
      if (!banner) return;
      const rect = banner.getBoundingClientRect();
      dragStartRef.current = {
        pointerX: e.clientX,
        pointerY: e.clientY,
        originLeft: rect.left,
        originTop: rect.top,
        panelW: banner.offsetWidth || PANEL_WIDTH,
        panelH: banner.offsetHeight || (collapsed ? FALLBACK_PANEL_H_COLLAPSED : FALLBACK_PANEL_H),
      };
      userMovedRef.current = true;
      setDragPos({ top: rect.top, left: rect.left });
      setDragging(true);
      e.preventDefault();
    },
    [collapsed],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const dx = e.clientX - start.pointerX;
      const dy = e.clientY - start.pointerY;
      setDragPos(
        clampDragPos(start.originTop + dy, start.originLeft + dx, start.panelW, start.panelH),
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

  // Anchor the panel near matched targets; re-run when highlights or collapse change.
  useLayoutEffect(() => {
    if (!request) {
      setPanelPos(null);
      return;
    }
    if (userMovedRef.current) return;
    const measured = boxes.length > 0 ? boxes : measure(request.selectors);
    const anchor = unionBox(measured);
    const banner = bannerRef.current;
    if (!anchor || !banner) {
      setPanelPos(null);
      return;
    }
    const rect = banner.getBoundingClientRect();
    let panelW = banner.offsetWidth || rect.width;
    let panelH = banner.offsetHeight || rect.height;
    if (panelW === 0) {
      panelW = Math.min(PANEL_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
    }
    if (panelH === 0) {
      panelH = collapsed ? FALLBACK_PANEL_H_COLLAPSED : FALLBACK_PANEL_H;
    }
    if (placementRef.current?.requestId !== request.id) {
      placementRef.current = {
        requestId: request.id,
        placement: choosePlacement(anchor, panelH),
      };
    }
    const nextPos = placePanel(anchor, panelW, panelH, placementRef.current.placement);
    setPanelPos((prev) => (panelPosEqual(prev, nextPos) ? prev : nextPos));
  }, [request, boxes, collapsed]);

  if (!request) return null;

  return (
    <>
      <style>{`
        @keyframes bsk-help-flash {
          0%, 100% { box-shadow: 0 0 0 2px rgba(249,115,22,0.9), 0 0 12px 2px rgba(249,115,22,0.5); }
          50% { box-shadow: 0 0 0 3px rgba(249,115,22,1), 0 0 22px 6px rgba(249,115,22,0.8); }
        }

        .bsk-help-banner {
          --bsk-help-ease: cubic-bezier(0.32, 0.72, 0, 1);
          --bsk-help-duration: 320ms;
          --bsk-help-banner-width: ${PANEL_WIDTH}px;
          position: fixed;
          bottom: 24px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 2147483647;
          display: flex;
          flex-direction: column;
          gap: 10px;
          width: var(--bsk-help-banner-width);
          max-width: calc(100vw - ${VIEWPORT_MARGIN * 2}px);
          background: #fff;
          border-radius: 16px;
          padding: 16px;
          box-shadow: 0 12px 40px rgba(124,45,18,0.18), 0 2px 8px rgba(0,0,0,0.1);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          transition:
            padding var(--bsk-help-duration) var(--bsk-help-ease),
            gap var(--bsk-help-duration) var(--bsk-help-ease),
            width var(--bsk-help-duration) var(--bsk-help-ease);
        }

        .bsk-help-banner[data-collapsed="true"] {
          gap: 0;
          width: var(--bsk-help-banner-width);
          padding: 10px 12px;
        }

        .bsk-help-drag-strip {
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          height: 12px;
          margin: -8px 0 -10px;
          cursor: grab;
          user-select: none;
          touch-action: none;
        }

        .bsk-help-drag-pill {
          width: 32px;
          height: 4px;
          border-radius: 999px;
          background: #d1d5db;
          transition: background-color 160ms var(--bsk-help-ease);
        }

        .bsk-help-drag-strip:hover .bsk-help-drag-pill {
          background: #9ca3af;
        }

        .bsk-help-banner[data-dragging="true"] .bsk-help-drag-strip {
          cursor: grabbing;
        }

        .bsk-help-banner[data-dragging="true"] .bsk-help-drag-pill {
          background: #6b7280;
        }

        .bsk-help-banner[data-collapsed="true"] .bsk-help-drag-strip {
          margin: -6px 0 -8px;
        }

        .bsk-help-header {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .bsk-help-title {
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          font-size: 15px;
          font-weight: 600;
          color: #111;
        }

        .bsk-help-banner[data-collapsed="true"] .bsk-help-title {
          white-space: nowrap;
        }

        .bsk-help-header-actions {
          flex-shrink: 0;
          display: flex;
          align-items: center;
          gap: 10px;
          margin-left: auto;
          overflow: hidden;
          max-width: 0;
          opacity: 0;
          transform: translateX(8px);
          pointer-events: none;
          transition:
            max-width var(--bsk-help-duration) var(--bsk-help-ease),
            opacity 220ms var(--bsk-help-ease),
            transform var(--bsk-help-duration) var(--bsk-help-ease);
        }

        .bsk-help-banner[data-collapsed="true"] .bsk-help-header-actions {
          max-width: 280px;
          opacity: 1;
          transform: translateX(0);
          pointer-events: auto;
        }

        .bsk-help-collapse-toggle {
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          cursor: pointer;
          border: none;
          background: transparent;
          padding: 4px;
          line-height: 1;
          color: #6b7280;
          margin-left: auto;
          transition: margin-left var(--bsk-help-duration) var(--bsk-help-ease);
        }

        .bsk-help-banner[data-collapsed="true"] .bsk-help-collapse-toggle {
          margin-left: 0;
        }

        .bsk-help-collapse-icon {
          display: flex;
          transition: transform var(--bsk-help-duration) var(--bsk-help-ease);
        }

        .bsk-help-banner[data-collapsed="true"] .bsk-help-collapse-icon {
          transform: rotate(180deg);
        }

        .bsk-help-body {
          display: grid;
          grid-template-rows: 1fr;
          min-width: 0;
          transition: grid-template-rows var(--bsk-help-duration) var(--bsk-help-ease);
        }

        .bsk-help-banner[data-collapsed="true"] .bsk-help-body {
          position: absolute;
          grid-template-rows: 0fr;
          width: 0;
          height: 0;
          overflow: hidden;
          pointer-events: none;
        }

        .bsk-help-body-inner {
          overflow: hidden;
          min-height: 0;
          min-width: 0;
        }

        .bsk-help-body-content {
          display: flex;
          flex-direction: column;
          gap: 10px;
          opacity: 1;
          transform: translateY(0);
          transition:
            opacity 220ms var(--bsk-help-ease),
            transform var(--bsk-help-duration) var(--bsk-help-ease);
        }

        .bsk-help-banner[data-collapsed="true"] .bsk-help-body-content {
          opacity: 0;
          transform: translateY(6px);
        }

        .bsk-help-prompt {
          margin: 0;
          font-size: 14px;
          line-height: 1.5;
          color: #444;
        }

        .bsk-help-note-input {
          width: 100%;
          box-sizing: border-box;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          padding: 8px 10px;
          font-size: 13px;
          font-family: inherit;
        }

        .bsk-help-footer-actions {
          display: flex;
          justify-content: flex-end;
          gap: 10px;
        }

        .bsk-help-btn-cancel {
          cursor: pointer;
          border: 1px solid #e5e7eb;
          background: transparent;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 500;
          color: #4b5563;
          flex-shrink: 0;
        }

        .bsk-help-btn-continue {
          cursor: pointer;
          border: none;
          background: #f97316;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 600;
          color: #fff;
          flex-shrink: 0;
        }

        .bsk-help-header-actions .bsk-help-btn-cancel,
        .bsk-help-header-actions .bsk-help-btn-continue {
          padding: 6px 12px;
        }

        .bsk-help-header-actions .bsk-help-btn-continue {
          padding: 6px 14px;
        }

        .bsk-help-footer-actions .bsk-help-btn-cancel {
          padding: 8px 16px;
        }

        .bsk-help-footer-actions .bsk-help-btn-continue {
          padding: 8px 18px;
        }

        @media (prefers-reduced-motion: reduce) {
          .bsk-help-banner,
          .bsk-help-header-actions,
          .bsk-help-collapse-toggle,
          .bsk-help-collapse-icon,
          .bsk-help-body,
          .bsk-help-body-content,
          .bsk-help-drag-strip,
          .bsk-help-drag-pill {
            transition-duration: 0.01ms !important;
          }
        }
      `}</style>

      {boxes.map((b, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: boxes are positional
          key={i}
          data-slot="help-highlight"
          style={{
            position: "fixed",
            top: b.top,
            left: b.left,
            width: b.width,
            height: b.height,
            borderRadius: 6,
            zIndex: 2147483646,
            pointerEvents: "none",
            animation: "bsk-help-flash 1.2s ease-in-out infinite",
          }}
        />
      ))}

      <div
        ref={bannerRef}
        data-slot="help-request-banner"
        data-collapsed={collapsed ? "true" : "false"}
        data-anchored={panelPos ? "true" : "false"}
        data-dragging={dragging ? "true" : "false"}
        data-placement={panelPos?.placement}
        className="bsk-help-banner"
        style={
          dragPos
            ? {
                top: dragPos.top,
                left: dragPos.left,
                bottom: "auto",
                transform: "none",
              }
            : panelPos
              ? {
                  top: panelPos.top ?? "auto",
                  left: panelPos.left,
                  bottom: panelPos.bottom ?? "auto",
                  transform: "translateX(-50%)",
                }
              : undefined
        }
      >
        <div
          data-slot="help-drag-handle"
          className="bsk-help-drag-strip"
          role="img"
          aria-label={t("helpRequest.dragHandle")}
          onPointerDown={onHeaderPointerDown}
        >
          <span className="bsk-help-drag-pill" aria-hidden />
        </div>

        <div className="bsk-help-header">
          <img
            src={logoUrl}
            alt="browser-skill"
            style={{ width: 22, height: 22, borderRadius: 4 }}
          />
          <span className="bsk-help-title">{request.title ?? t("helpRequest.title")}</span>
          <div className="bsk-help-header-actions" aria-hidden={!collapsed}>
            <button
              type="button"
              data-slot={collapsed ? "help-cancel-button" : undefined}
              className="bsk-help-btn-cancel"
              tabIndex={collapsed ? 0 : -1}
              onClick={() => request.onCancel()}
            >
              {t("helpRequest.cancel")}
            </button>
            <button
              type="button"
              data-slot={collapsed ? "help-continue-button" : undefined}
              className="bsk-help-btn-continue"
              tabIndex={collapsed ? 0 : -1}
              onClick={() => request.onContinue(note)}
            >
              {t("helpRequest.continue")}
            </button>
          </div>
          <button
            type="button"
            data-slot="help-collapse-toggle"
            className="bsk-help-collapse-toggle"
            aria-label={collapsed ? t("helpRequest.expand") : t("helpRequest.collapse")}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((c) => !c)}
          >
            <span className="bsk-help-collapse-icon">
              <RiArrowDownSLine size={20} aria-hidden />
            </span>
          </button>
        </div>

        <div className="bsk-help-body" aria-hidden={collapsed}>
          <div className="bsk-help-body-inner">
            <div className="bsk-help-body-content">
              <p className="bsk-help-prompt">{request.prompt}</p>
              <input
                type="text"
                className="bsk-help-note-input"
                aria-label={t("helpRequest.noteLabel")}
                placeholder={t("helpRequest.notePlaceholder")}
                value={note}
                tabIndex={collapsed ? -1 : 0}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="bsk-help-footer-actions">
                <button
                  type="button"
                  data-slot={collapsed ? undefined : "help-cancel-button"}
                  className="bsk-help-btn-cancel"
                  tabIndex={collapsed ? -1 : 0}
                  onClick={() => request.onCancel()}
                >
                  {t("helpRequest.cancel")}
                </button>
                <button
                  type="button"
                  data-slot={collapsed ? undefined : "help-continue-button"}
                  className="bsk-help-btn-continue"
                  tabIndex={collapsed ? -1 : 0}
                  onClick={() => request.onContinue(note)}
                >
                  {t("helpRequest.continue")}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
