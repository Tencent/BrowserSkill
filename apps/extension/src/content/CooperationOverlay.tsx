import { useTranslation } from "@browser-skill/i18n/react";
import {
  RiAlertLine,
  RiCursorLine,
  RiHand,
  RiPauseLine,
  RiPlayLine,
  RiRefreshLine,
  RiStopLine,
  RiTimeLine,
} from "@remixicon/react";
import { useEffect, useState } from "react";
import { COOPERATION_CONTROL, type CooperationView } from "@/cooperation/types";
import logoUrl from "../../assets/logo.png";

const statusIcons = {
  ready: RiCursorLine,
  acting: RiCursorLine,
  human: RiHand,
  held: RiPauseLine,
  yielding: RiTimeLine,
  syncing: RiRefreshLine,
  unavailable: RiAlertLine,
} satisfies Record<CooperationView["mode"], typeof RiCursorLine>;

function AgentTarget({ target }: { target?: CooperationView["target"] }) {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    setExpired(false);
    if (!target) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, target.expires - Date.now()));
    return () => clearTimeout(timer);
  }, [target]);
  if (!target || expired || target.expires <= Date.now()) return null;
  return (
    <div
      className="bsk-cooperation-target"
      aria-hidden="true"
      style={{ left: target.x, top: target.y }}
    >
      <span>Agent</span>
    </div>
  );
}

export function CooperationOverlay({ state, onStop }: { state?: CooperationView; onStop(): void }) {
  const { t } = useTranslation("extension");
  const [pending, setPending] = useState(false);
  if (!state) return null;
  const control = async (action: "hold" | "resume") => {
    setPending(true);
    try {
      await chrome.runtime.sendMessage({
        kind: COOPERATION_CONTROL,
        revision: state.revision,
        action,
      });
    } finally {
      setPending(false);
    }
  };
  const status = state.editing && state.mode === "human" ? "editing" : state.mode;
  const resuming = state.mode === "held" || state.mode === "human";
  const StatusIcon = statusIcons[state.mode];
  const ActionIcon = resuming ? RiPlayLine : RiPauseLine;

  return (
    <>
      <AgentTarget target={state.target} />
      <div
        className="bsk-cooperation"
        data-slot="cooperation-toolbar"
        data-mode={state.mode}
        role="toolbar"
        aria-label={t("cooperation.label")}
        onPointerDown={(event) => event.preventDefault()}
      >
        <div className="bsk-cooperation-header">
          <span className="bsk-cooperation-brand">
            <img src={logoUrl} alt="" />
            {t("popup.brandName")}
          </span>
          <span className="bsk-cooperation-badge">{t("cooperation.label")}</span>
        </div>
        <div className="bsk-cooperation-body">
          <span className="bsk-cooperation-icon" aria-hidden="true">
            <StatusIcon size={20} />
          </span>
          <div className="bsk-cooperation-copy" role="status" aria-live="polite">
            <div className="bsk-cooperation-status">
              <span className="bsk-cooperation-dot" aria-hidden="true" />
              <span>{t(`cooperation.${status}`)}</span>
            </div>
            <span className="bsk-cooperation-hint">{t(`cooperation.hints.${status}`)}</span>
          </div>
        </div>
        <div className="bsk-cooperation-actions">
          <button
            className="bsk-cooperation-primary"
            type="button"
            disabled={pending || state.mode === "yielding"}
            onClick={() => void control(resuming ? "resume" : "hold")}
          >
            <ActionIcon size={16} aria-hidden="true" />
            {t(resuming ? "cooperation.resume" : "cooperation.hold")}
          </button>
          <button className="bsk-cooperation-stop" type="button" onClick={onStop}>
            <RiStopLine size={16} aria-hidden="true" />
            {t("cooperation.stop")}
          </button>
        </div>
      </div>
    </>
  );
}
