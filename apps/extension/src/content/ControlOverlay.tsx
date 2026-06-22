import { useTranslation } from "@browser-skill/i18n/react";
import { RiStopCircleLine } from "@remixicon/react";
import { useEffect, useState } from "react";
import logoUrl from "../../assets/logo.png";

export interface ControlOverlayProps {
  visible: boolean;
  interrupting: boolean;
  automationBypass: boolean;
  onInterrupt: () => void;
}

export function ControlOverlay({
  visible,
  interrupting,
  automationBypass,
  onInterrupt,
}: ControlOverlayProps) {
  const { t } = useTranslation("extension");
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (visible) {
      const raf = requestAnimationFrame(() => setShow(true));
      return () => cancelAnimationFrame(raf);
    }
    setShow(false);
  }, [visible]);

  if (!visible) return null;

  const pointerEvents = automationBypass ? "none" : "auto";

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
        style={{
          position: "fixed",
          bottom: 32,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 2147483647,
          pointerEvents,
          display: "flex",
          alignItems: "center",
          gap: 12,
          backgroundColor: "#fff",
          borderRadius: 9999,
          padding: "10px 10px 10px 20px",
          boxShadow: "0 8px 32px rgba(124,45,18,0.16), 0 2px 8px rgba(0,0,0,0.1)",
          opacity: show ? 1 : 0,
          transition: "opacity 300ms ease-out",
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        }}
      >
        <img
          src={logoUrl}
          alt="browser-skill"
          style={{ width: 24, height: 24, borderRadius: 4, flexShrink: 0 }}
        />
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
        <button
          type="button"
          data-slot="control-overlay-stop-all"
          disabled={interrupting}
          onClick={onInterrupt}
          style={{
            pointerEvents,
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
          {interrupting ? t("controlOverlay.interrupting") : t("controlOverlay.interrupt")}
        </button>
      </div>
    </>
  );
}
