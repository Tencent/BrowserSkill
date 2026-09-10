import { cn } from "@browser-skill/ui";

export interface SwitchProps {
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  "aria-label": string;
  "data-slot"?: string;
}

/**
 * The popup's single toggle switch — every settings row uses this same
 * component and size; hierarchy between primary and secondary settings is
 * conveyed by copy/iconography, not by control size.
 */
export function Switch({
  checked,
  disabled = false,
  onCheckedChange,
  "aria-label": ariaLabel,
  "data-slot": dataSlot,
}: SwitchProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      data-slot={dataSlot}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-muted",
      )}
      onClick={() => onCheckedChange(!checked)}
    >
      <span
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background shadow-sm transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
        aria-hidden
      />
    </button>
  );
}
