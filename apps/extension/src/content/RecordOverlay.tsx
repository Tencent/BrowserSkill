import { useTranslation } from "@browser-skill/i18n/react";

export interface RecordRequestData {
  id: string;
  onFinish: () => void;
}

type Props = {
  request: RecordRequestData | null;
};

export function RecordOverlay({ request }: Props) {
  const { t } = useTranslation("extension");

  if (!request) return null;

  return (
    <div
      className="bsk-record-panel"
      style={{
        position: "fixed",
        bottom: 24,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 2147483646,
        display: "flex",
        alignItems: "center",
        gap: 16,
        background: "rgba(15, 23, 42, 0.94)",
        color: "#f8fafc",
        padding: "12px 16px",
        borderRadius: 12,
        font: "500 14px/1.4 system-ui, sans-serif",
        boxShadow: "0 8px 32px rgba(0,0,0,0.28)",
        pointerEvents: "auto",
        maxWidth: "min(420px, calc(100vw - 32px))",
      }}
    >
      <span style={{ flex: 1 }}>{t("recordOverlay.recording")}</span>
      <button
        type="button"
        onClick={request.onFinish}
        style={{
          border: "none",
          borderRadius: 8,
          background: "#dc2626",
          color: "#fff",
          font: "600 13px/1 system-ui, sans-serif",
          padding: "8px 14px",
          cursor: "pointer",
          pointerEvents: "auto",
        }}
      >
        {t("recordOverlay.finish")}
      </button>
    </div>
  );
}
