import { useTranslation } from "@browser-skill/i18n/react";
import {
  RiAlertLine,
  RiArrowLeftSLine,
  RiCursorLine,
  RiHand,
  RiPauseLine,
  RiPlayLine,
  RiRefreshLine,
  RiStopLine,
  RiSubtractLine,
  RiTimeLine,
} from "@remixicon/react";
import { useEffect, useState } from "react";
import { COOPERATION_CONTROL, type CooperationView } from "@/cooperation/types";
import { type ControllerInfo, controllerColor } from "@/lib/controller-info";
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

function AgentTarget({
  target,
  name = "Agent",
}: {
  target?: CooperationView["target"];
  name?: string;
}) {
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
      <span>{name}</span>
    </div>
  );
}

export interface ControlOverlayProps {
  sessionId?: string | null;
  controller?: ControllerInfo;
  visible: boolean;
  state?: CooperationView;
  interrupting: boolean;
  automationBypass: boolean;
  minimized?: boolean;
  onMinimizedChange?(minimized: boolean): void;
  onInterrupt(): void;
}

export function ControlOverlay({
  sessionId,
  controller,
  visible,
  state,
  interrupting,
  automationBypass,
  minimized = false,
  onMinimizedChange,
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
  const actionLabel = controller
    ? t(resuming ? "controlOverlay.resumeController" : "controlOverlay.holdController", {
        name: controller.name,
      })
    : t(resuming ? "cooperation.resume" : "cooperation.hold");

  return (
    <>
      <ControlGlow />
      {!state && <ControlInputBlocker automationBypass={automationBypass} />}
      <AgentTarget target={state?.target} name={controller?.name} />
      <div
        className="bsk-cooperation"
        data-slot={state ? "cooperation-toolbar" : "control-overlay-card"}
        data-mode={state?.mode}
        data-minimized={minimized || undefined}
        role="toolbar"
        aria-label={t("cooperation.label")}
        onPointerDown={(event) => {
          if (state) event.preventDefault();
        }}
      >
        {minimized ? (
          <button
            className="bsk-cooperation-expand"
            type="button"
            aria-label={t("controlOverlay.expand")}
            aria-expanded={false}
            title={t("controlOverlay.expand")}
            onClick={() => onMinimizedChange?.(false)}
          >
            <RiArrowLeftSLine size={20} aria-hidden="true" />
          </button>
        ) : (
          <>
            <div className="bsk-cooperation-details">
              <div className="bsk-cooperation-header">
                <span className="bsk-cooperation-brand">
                  <img src={logoUrl} alt="" />
                  {controller ? (
                    <>
                      <span
                        className="bsk-controller-color"
                        aria-hidden="true"
                        style={{ backgroundColor: controllerColor(sessionId ?? "", controller) }}
                      />
                      <bdi className="bsk-controller-name" title={controller.name}>
                        {controller.name}
                      </bdi>
                    </>
                  ) : (
                    t("popup.brandName")
                  )}
                </span>
                <span className="bsk-cooperation-badge">{t("cooperation.label")}</span>
              </div>
              {sessionId && (
                <dl className="bsk-controller-details">
                  {controller?.project && (
                    <div>
                      <dt>{t("controlOverlay.project")}</dt>
                      <dd>
                        <bdi>{controller.project}</bdi>
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>{t("controlOverlay.session")}</dt>
                    <dd>
                      <bdi>{sessionId}</bdi>
                    </dd>
                  </div>
                </dl>
              )}
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
                  <span className="bsk-controller-action" title={actionLabel}>
                    {actionLabel}
                  </span>
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
            <button
              className="bsk-cooperation-minimize"
              type="button"
              aria-label={t("controlOverlay.minimize")}
              aria-expanded={true}
              title={t("controlOverlay.minimize")}
              onClick={() => onMinimizedChange?.(true)}
            >
              <RiSubtractLine size={16} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </>
  );
}
