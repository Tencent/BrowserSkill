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
import { ControlGlow } from "./ControlGlow";
import { ControlInputBlocker } from "./ControlInputBlocker";

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

export interface ControlOverlayProps {
  visible: boolean;
  state?: CooperationView;
  interrupting: boolean;
  automationBypass: boolean;
  onInterrupt(): void;
}

export function ControlOverlay({
  visible,
  state,
  interrupting,
  automationBypass,
  onInterrupt,
}: ControlOverlayProps) {
  const { t } = useTranslation("extension");
  const [pending, setPending] = useState(false);
  if (!visible) return null;
  const control = async (action: "hold" | "resume") => {
    if (!state) return;
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
  const status = state?.editing && state.mode === "human" ? "editing" : state?.mode;
  const resuming = state?.mode === "held" || state?.mode === "human";
  const StatusIcon = state ? statusIcons[state.mode] : RiCursorLine;
  const stopping = !state && interrupting;
  const ActionIcon = resuming ? RiPlayLine : RiPauseLine;

  return (
    <>
      <ControlGlow />
      {!state && <ControlInputBlocker automationBypass={automationBypass} />}
      <AgentTarget target={state?.target} />
      <div
        className="bsk-cooperation"
        data-slot={state ? "cooperation-toolbar" : "control-overlay-card"}
        data-mode={state?.mode}
        role="toolbar"
        aria-label={t("cooperation.label")}
        onPointerDown={(event) => {
          if (state) event.preventDefault();
        }}
      >
        <div className="bsk-cooperation-details">
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
                <span>{status ? t(`cooperation.${status}`) : t("controlOverlay.status")}</span>
              </div>
              {status && (
                <span className="bsk-cooperation-hint">{t(`cooperation.hints.${status}`)}</span>
              )}
            </div>
          </div>
        </div>
        <div className="bsk-cooperation-actions">
          {state && (
            <button
              className="bsk-cooperation-primary"
              type="button"
              disabled={pending || state.mode === "yielding"}
              onClick={() => void control(resuming ? "resume" : "hold")}
            >
              <ActionIcon size={16} aria-hidden="true" />
              {t(resuming ? "cooperation.resume" : "cooperation.hold")}
            </button>
          )}
          <button
            className="bsk-cooperation-stop"
            data-slot="control-overlay-stop-all"
            type="button"
            disabled={stopping}
            onClick={onInterrupt}
          >
            <RiStopLine size={16} aria-hidden="true" />
            {t(stopping ? "controlOverlay.interrupting" : "cooperation.stop")}
          </button>
        </div>
      </div>
    </>
  );
}
