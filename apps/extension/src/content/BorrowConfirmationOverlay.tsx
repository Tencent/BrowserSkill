import { useTranslation } from "@browser-skill/i18n/react";
import { RiCloseLine } from "@remixicon/react";
import { type TransitionEvent, useEffect, useRef, useState } from "react";
import logoUrl from "../../assets/logo.png";

export interface BorrowRequestData {
  id: string;
  isActiveTab: boolean;
  tabTitle: string;
  timeoutMs: number;
  onAllow: () => void;
  onDeny: () => void;
}

interface Props {
  requests: BorrowRequestData[];
}

const EXIT_ANIMATION_MS = 150;

export function BorrowConfirmationOverlay({ requests }: Props) {
  const activeRequest = requests.find((r) => r.isActiveTab);
  const inactiveRequests = requests.filter((r) => !r.isActiveTab);

  return (
    <>
      {activeRequest && (
        <BorrowBackdrop>
          <BorrowRequestItem key={activeRequest.id} request={activeRequest} isModal={true} />
        </BorrowBackdrop>
      )}
      {inactiveRequests.length > 0 && (
        <BorrowToastStack>
          {inactiveRequests.map((req) => (
            <BorrowRequestItem key={req.id} request={req} isModal={false} />
          ))}
        </BorrowToastStack>
      )}
    </>
  );
}

function BorrowBackdrop({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-slot="borrow-confirmation-modal-backdrop"
      className="fixed inset-0 z-[2147483646] flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      {children}
    </div>
  );
}

function BorrowToastStack({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-slot="borrow-confirmation-toast-stack"
      className="fixed top-4 right-4 z-[2147483647] flex flex-col gap-3"
    >
      {children}
    </div>
  );
}

function BorrowRequestItem({ request, isModal }: { request: BorrowRequestData; isModal: boolean }) {
  const { t } = useTranslation("extension");
  const totalSeconds = Math.ceil(request.timeoutMs / 1000);
  const [secondsLeft, setSecondsLeft] = useState(totalSeconds);
  const [exiting, setExiting] = useState(false);
  const [awaitingAutoAllow, setAwaitingAutoAllow] = useState(false);
  const allowedRef = useRef(false);
  const onAllowRef = useRef(request.onAllow);
  const onDenyRef = useRef(request.onDeny);
  onAllowRef.current = request.onAllow;
  onDenyRef.current = request.onDeny;

  useEffect(() => {
    if (secondsLeft <= 0) {
      if (!allowedRef.current) {
        setAwaitingAutoAllow(true);
      }
      return;
    }
    const id = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [secondsLeft]);

  function triggerAllow() {
    if (allowedRef.current) return;
    allowedRef.current = true;
    setAwaitingAutoAllow(false);
    setExiting(true);
    setTimeout(() => onAllowRef.current(), EXIT_ANIMATION_MS);
  }

  function handleAllow() {
    triggerAllow();
  }

  function handleDeny() {
    if (allowedRef.current) return;
    allowedRef.current = true;
    setAwaitingAutoAllow(false);
    setExiting(true);
    setTimeout(() => onDenyRef.current(), EXIT_ANIMATION_MS);
  }

  const progress = secondsLeft / totalSeconds;
  const truncatedTitle =
    request.tabTitle.length > 30 ? `${request.tabTitle.slice(0, 30)}…` : request.tabTitle;
  const cardClass = `transition-opacity duration-150 ease-out ${exiting ? "opacity-0" : "opacity-100"}`;

  if (isModal) {
    return (
      <div
        data-slot="borrow-confirmation-modal"
        className={`flex w-[400px] flex-col gap-4 rounded-2xl bg-white px-7 pb-6 pt-7 shadow-[0_25px_50px_rgba(124,45,18,0.1)] ${cardClass}`}
      >
        <div className="flex items-center gap-2.5">
          <img src={logoUrl} alt="browser-skill" className="size-6 rounded" />
          <span className="text-base font-semibold text-[#111]">
            {t("borrowConfirmation.title")}
          </span>
        </div>
        <p className="m-0 text-sm leading-relaxed text-[#555]">{t("borrowConfirmation.body")}</p>
        <div className="flex items-center justify-center gap-3 py-2">
          <CountdownRing
            progress={progress}
            seconds={secondsLeft}
            onProgressTransitionEnd={(propertyName) => {
              if (!awaitingAutoAllow || secondsLeft !== 0) return;
              if (propertyName !== "stroke-dashoffset") return;
              triggerAllow();
            }}
          />
          <span className="text-[13px] text-gray-500">
            {t("borrowConfirmation.autoAllow", { count: secondsLeft })}
          </span>
        </div>
        <ActionButtons onDeny={handleDeny} onAllow={handleAllow} />
      </div>
    );
  }

  return (
    <div
      data-slot="borrow-confirmation-toast"
      className={`flex w-80 flex-col rounded-xl border border-[#ffedd5] bg-[#FFFBF7] p-4 pb-3.5 shadow-[0_10px_40px_rgba(124,45,18,0.1)] ${cardClass}`}
    >
      <BorrowToastHeader onDeny={handleDeny} />
      <p className="mb-2.5 text-[13px] leading-relaxed text-[#555]">
        {t("borrowConfirmation.targetTab")}
        <br />
        <span className="font-medium text-[#333]">&quot;{truncatedTitle}&quot;</span>
      </p>
      <BorrowProgressBar
        progress={progress}
        onProgressTransitionEnd={(event) => {
          if (!awaitingAutoAllow || secondsLeft !== 0) return;
          if (event.propertyName !== "width") return;
          triggerAllow();
        }}
      />
      <ActionButtons onDeny={handleDeny} onAllow={handleAllow} gapClass="gap-2" />
    </div>
  );
}

function BorrowToastHeader({ onDeny }: { onDeny: () => void }) {
  const { t } = useTranslation("extension");
  return (
    <div className="mb-2 flex items-center gap-2">
      <img src={logoUrl} alt="browser-skill" className="size-[18px] rounded" />
      <span className="flex-1 text-sm font-semibold text-[#111]">
        {t("borrowConfirmation.titleInactive")}
      </span>
      <button
        type="button"
        data-slot="borrow-confirmation-deny-button"
        onClick={onDeny}
        className="cursor-pointer border-0 bg-transparent p-0.5 text-gray-500"
        aria-label={t("borrowConfirmation.deny")}
      >
        <RiCloseLine size={16} />
      </button>
    </div>
  );
}

function BorrowProgressBar({
  progress,
  onProgressTransitionEnd,
}: {
  progress: number;
  onProgressTransitionEnd?: (event: TransitionEvent<HTMLDivElement>) => void;
}) {
  return (
    <div className="mb-3 h-1 overflow-hidden rounded-sm bg-gray-100">
      <div
        className="h-full rounded-sm bg-orange-500 transition-[width] duration-1000 ease-linear"
        style={{ width: `${progress * 100}%` }}
        onTransitionEnd={onProgressTransitionEnd}
      />
    </div>
  );
}

function ActionButtons({
  onDeny,
  onAllow,
  gapClass = "gap-2.5",
}: {
  onDeny: () => void;
  onAllow: () => void;
  gapClass?: string;
}) {
  const { t } = useTranslation("extension");
  return (
    <div className={`flex justify-end ${gapClass}`}>
      <button
        type="button"
        data-slot="borrow-confirmation-deny-button"
        onClick={onDeny}
        className="cursor-pointer rounded-lg border border-gray-200 bg-transparent px-4 py-2 text-[13px] font-medium text-gray-600"
      >
        {t("borrowConfirmation.deny")}
      </button>
      <button
        type="button"
        data-slot="borrow-confirmation-allow-button"
        onClick={onAllow}
        className="cursor-pointer rounded-lg border-0 bg-orange-500 px-4 py-2 text-[13px] font-semibold text-white"
      >
        {t("borrowConfirmation.allow")}
      </button>
    </div>
  );
}

function CountdownRing({
  progress,
  seconds,
  onProgressTransitionEnd,
}: {
  progress: number;
  seconds: number;
  onProgressTransitionEnd?: (propertyName: string) => void;
}) {
  const r = 28;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - progress);
  return (
    <svg width={72} height={72} className="-rotate-90" aria-hidden>
      <circle cx={36} cy={36} r={r} fill="none" stroke="#f3f4f6" strokeWidth={5} />
      <circle
        cx={36}
        cy={36}
        r={r}
        fill="none"
        stroke="#f97316"
        strokeWidth={5}
        strokeDasharray={circ}
        strokeDashoffset={offset}
        strokeLinecap="round"
        className="transition-[stroke-dashoffset] duration-1000 ease-linear"
        onTransitionEnd={(event) => onProgressTransitionEnd?.(event.propertyName)}
      />
      <text
        x={36}
        y={36}
        textAnchor="middle"
        dominantBaseline="central"
        className="fill-[#111] text-xl font-bold"
        style={{ transform: "rotate(90deg)", transformOrigin: "36px 36px" }}
      >
        {seconds}
      </text>
    </svg>
  );
}
