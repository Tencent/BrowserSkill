import { cn } from "@browser-skill/ui";
import type { PopupStatusState } from "./use-connection-state";

const DOT_STYLES: Record<PopupStatusState, string> = {
  disconnected: "bg-muted-foreground/40",
  connected: "bg-emerald-500",
  version_skew: "bg-amber-500",
  disabled: "bg-muted-foreground/25",
};

interface ConnectionStatusIndicatorProps {
  state: PopupStatusState;
  className?: string;
}

/** Flat online-status dot (Slack / GitHub style). */
export function ConnectionStatusIndicator({ state, className }: ConnectionStatusIndicatorProps) {
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full ring-2 ring-background",
        DOT_STYLES[state],
        className,
      )}
      data-slot={`popup-state-dot-${state}`}
      aria-hidden
    />
  );
}
