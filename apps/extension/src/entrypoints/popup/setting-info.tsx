import { RiInformationLine } from "@remixicon/react";
import { type ReactNode, useId } from "react";

/** Place inside a relative settings row so long hints stay within the popup. */
export function SettingInfo({
  label,
  children,
  "data-slot": dataSlot,
}: {
  label: string;
  children: ReactNode;
  "data-slot"?: string;
}) {
  const tooltipId = useId();
  return (
    <span className="group inline-flex shrink-0">
      <button
        type="button"
        aria-label={label}
        aria-describedby={tooltipId}
        data-slot={dataSlot}
        className="flex size-4 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <RiInformationLine className="size-3.5" aria-hidden />
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-0 z-10 mb-1.5 w-56 whitespace-normal rounded-md bg-foreground/65 px-2 py-1 text-[10px] font-medium leading-snug text-background opacity-0 shadow-md backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {children}
      </span>
    </span>
  );
}
