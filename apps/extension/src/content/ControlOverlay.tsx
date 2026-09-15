import { useTranslation } from "@browser-skill/i18n/react";
import { RiStopCircleLine } from "@remixicon/react";
import { useEffect, useRef, useState } from "react";
import type { OverlayMode } from "@/lib/overlay-bridge";
import logoUrl from "../../assets/logo.png";

/** The tool the agent is running right now, as narrated by the pill. */
export interface ControlAction {
  /** Wire tool name, e.g. `tool.click`. */
  tool: string;
  /** `@ref`, selector, url or key, already truncated by the background. */
  target?: string;
}

export interface ControlOverlayProps {
  visible: boolean;
  /**
   * Authoritative control mode. `paused` renders the "you are in control"
   * pill: no blocker, no glow, a note field and a return button.
   */
  mode: OverlayMode;
  interrupting: boolean;
  automationBypass: boolean;
  /** Current agent action, or null while idle. */
  currentAction?: ControlAction | null;
  onInterrupt: () => void;
  onReturnControl: (note: string) => void;
}

/**
 * Map a wire tool name to its `controlOverlay.action.*` suffix. Anything we do
 * not narrate falls back to the generic "working" copy.
 */
const ACTION_KEY_BY_TOOL: Record<string, string> = {
  "tool.click": "click",
  "tool.dblclick": "click",
  "tool.hover": "hover",
  "tool.fill": "fill",
  "tool.press": "press",
  "tool.navigate": "navigate",
  "tool.navigate_back": "navigate",
  "tool.navigate_forward": "navigate",
  "tool.scroll": "scroll",
  "tool.scroll_to": "scroll",
  "tool.wheel": "scroll",
  "tool.select": "select",
  "tool.upload": "upload",
  "tool.download": "download",
  "tool.evaluate": "evaluate",
  "tool.reload": "reload",
};

/**
 * Cap on the note the user can hand back with the page. The daemon cuts
 * anything longer, and the note lives in its interrupt registry until a waiter
 * consumes it, so keep the field well inside that budget.
 */
export const NOTE_MAX_CHARS = 1000;

const PILL_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

function actionKey(tool: string): string {
  return ACTION_KEY_BY_TOOL[tool] ?? "working";
}

export function ControlOverlay({
  visible,
  mode,
  interrupting,
  automationBypass,
  currentAction,
  onInterrupt,
  onReturnControl,
}: ControlOverlayProps) {
  const { t } = useTranslation("extension");
  const [show, setShow] = useState(false);
  const [note, setNote] = useState("");
  const blockerRef = useRef<HTMLDivElement>(null);
  const paused = mode === "paused";

  useEffect(() => {
    if (visible) {
      const raf = requestAnimationFrame(() => setShow(true));
      return () => cancelAnimationFrame(raf);
    }
    setShow(false);
  }, [visible]);

  // A fresh hold starts with an empty note rather than the previous one.
  useEffect(() => {
    if (!paused) setNote("");
  }, [paused]);

  useEffect(() => {
    const blocker = blockerRef.current;
    if (!blocker) return;
    const stopScroll = (event: WheelEvent | TouchEvent) => {
      if (automationBypass) return;
      event.preventDefault();
      event.stopPropagation();
    };
    blocker.addEventListener("wheel", stopScroll, { passive: false });
    blocker.addEventListener("touchmove", stopScroll, { passive: false });
    return () => {
      blocker.removeEventListener("wheel", stopScroll);
      blocker.removeEventListener("touchmove", stopScroll);
    };
  }, [automationBypass]);

  useEffect(() => {
    // The paused pill never blocks the page — the user is operating it.
    if (!visible || paused || automationBypass) return;
    const stopScroll = (event: WheelEvent | TouchEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("wheel", stopScroll, { capture: true, passive: false });
    window.addEventListener("touchmove", stopScroll, { capture: true, passive: false });
    return () => {
      window.removeEventListener("wheel", stopScroll, { capture: true });
      window.removeEventListener("touchmove", stopScroll, { capture: true });
    };
  }, [visible, paused, automationBypass]);

  if (!visible) return null;

  const pointerEvents = automationBypass ? "none" : "auto";
  const action = currentAction ?? null;

  if (paused) {
    return (
      <div
        data-slot="control-overlay-pill"
        data-mode="paused"
        style={{
          position: "fixed",
          bottom: 32,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 2147483647,
          pointerEvents: "auto",
          display: "flex",
          alignItems: "center",
          gap: 8,
          backgroundColor: "#fff",
          borderRadius: 9999,
          padding: "10px 10px 10px 20px",
          boxShadow: "0 8px 32px rgba(124,45,18,0.16), 0 2px 8px rgba(0,0,0,0.1)",
          opacity: show ? 1 : 0,
          transition: "opacity 300ms ease-out",
          fontFamily: PILL_FONT,
        }}
      >
        <img
          src={logoUrl}
          alt="browser-skill"
          style={{ width: 24, height: 24, borderRadius: 4, flexShrink: 0 }}
        />
        <span
          style={{
            fontSize: 15,
            fontWeight: 500,
            color: "#333",
            whiteSpace: "nowrap",
            userSelect: "none",
          }}
        >
          {t("controlOverlay.pausedStatus")}
        </span>
        <input
          type="text"
          data-slot="control-overlay-note"
          value={note}
          maxLength={NOTE_MAX_CHARS}
          placeholder={t("controlOverlay.notePlaceholder")}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            onReturnControl(note);
          }}
          style={{
            width: 200,
            border: "1px solid #e5e7eb",
            borderRadius: 9999,
            padding: "8px 14px",
            fontSize: 14,
            color: "#333",
            outline: "none",
            fontFamily: PILL_FONT,
          }}
        />
        <button
          type="button"
          data-slot="control-overlay-return"
          onClick={() => onReturnControl(note)}
          style={{
            pointerEvents: "auto",
            border: "none",
            borderRadius: 9999,
            padding: "8px 20px",
            fontSize: 15,
            fontWeight: 600,
            color: "#fff",
            backgroundColor: "#16a34a",
            cursor: "pointer",
            whiteSpace: "nowrap",
            lineHeight: 1,
          }}
        >
          {t("controlOverlay.returnControl")}
        </button>
      </div>
    );
  }

  return (
    <>
      <style>{`
        @keyframes bsk-breathe {
          0%, 100% {
            box-shadow: inset 0 0 20px 4px rgba(249,115,22,0.25);
          }
          50% {
            box-shadow: inset 0 0 40px 8px rgba(249,115,22,0.5);
          }
        }
      `}</style>

      <div
        data-slot="control-overlay"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 2147483646,
          pointerEvents: "none",
          animation: "bsk-breathe 3s ease-in-out infinite",
          opacity: show ? 1 : 0,
          transition: "opacity 300ms ease-out",
        }}
      />

      <div
        ref={blockerRef}
        data-slot="control-overlay-blocker"
        onPointerDown={(event) => {
          if (automationBypass) return;
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          if (automationBypass) return;
          event.preventDefault();
          event.stopPropagation();
        }}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 2147483646,
          pointerEvents,
          background: "transparent",
          opacity: show ? 1 : 0,
          transition: "opacity 300ms ease-out",
        }}
      />

      <div
        data-slot="control-overlay-pill"
        data-mode="control"
        style={{
          position: "fixed",
          bottom: 32,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 2147483647,
          pointerEvents: "auto",
          display: "flex",
          alignItems: "center",
          gap: 12,
          backgroundColor: "#fff",
          borderRadius: 9999,
          padding: "10px 10px 10px 20px",
          boxShadow: "0 8px 32px rgba(124,45,18,0.16), 0 2px 8px rgba(0,0,0,0.1)",
          opacity: show ? 1 : 0,
          transition: "opacity 300ms ease-out",
          fontFamily: PILL_FONT,
        }}
      >
        <img
          src={logoUrl}
          alt="browser-skill"
          style={{ width: 24, height: 24, borderRadius: 4, flexShrink: 0 }}
        />
        <span
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 1,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontSize: 16,
              fontWeight: 500,
              color: "#333",
              whiteSpace: "nowrap",
              userSelect: "none",
            }}
          >
            {t("controlOverlay.status")}
          </span>
          <span
            data-slot="control-overlay-action"
            style={{
              fontSize: 13,
              color: "#6b7280",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              userSelect: "none",
            }}
          >
            {action
              ? `${t(`controlOverlay.action.${actionKey(action.tool)}` as "controlOverlay.action.working")}${
                  action.target ? ` ${action.target}` : ""
                }`
              : t("controlOverlay.action.idle")}
          </span>
        </span>
        <button
          type="button"
          data-slot="control-overlay-stop-all"
          disabled={interrupting}
          onClick={onInterrupt}
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
            backgroundColor: interrupting ? "#9ca3af" : "#f97316",
            cursor: interrupting ? "default" : "pointer",
            opacity: interrupting ? 0.7 : 1,
            transition: "background-color 150ms ease-out, opacity 150ms ease-out",
            whiteSpace: "nowrap",
            lineHeight: 1,
          }}
        >
          <RiStopCircleLine size={18} color="#fff" />
          {interrupting ? t("controlOverlay.takingOver") : t("controlOverlay.takeOver")}
        </button>
      </div>
    </>
  );
}
