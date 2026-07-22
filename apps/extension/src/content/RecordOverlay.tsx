import { useTranslation } from "@browser-skill/i18n/react";
import { RiCheckboxCircleLine } from "@remixicon/react";
import { useEffect, useState } from "react";

export interface RecordRequestData {
  id: string;
  onFinish: () => void;
}

type Props = {
  request: RecordRequestData | null;
};

export function RecordOverlay({ request }: Props) {
  const { t } = useTranslation("extension");
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (request) {
      const raf = requestAnimationFrame(() => setShow(true));
      return () => cancelAnimationFrame(raf);
    }
    setShow(false);
  }, [request]);

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
        data-slot="record-overlay-pill"
        style={{
          position: "fixed",
          bottom: 32,
          left: "50%",
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
          transform: show ? "translateX(-50%) translateY(0)" : "translateX(-50%) translateY(8px)",
          transition: "opacity 300ms ease-out, transform 300ms ease-out",
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          maxWidth: "min(420px, calc(100vw - 32px))",
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
          <RiCheckboxCircleLine size={18} color="#fff" />
          {t("recordOverlay.finish")}
        </button>
      </div>
    </>
  );
}
