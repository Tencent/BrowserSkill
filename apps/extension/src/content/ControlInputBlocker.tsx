import { type SyntheticEvent, useEffect, useRef } from "react";

/** Preserve fallback input blocking until a real cooperation state is available. */
export function ControlInputBlocker({ automationBypass }: { automationBypass: boolean }) {
  const blockerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (automationBypass) return;
    const blocker = blockerRef.current;
    const stopScroll = (event: WheelEvent | TouchEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    blocker?.addEventListener("wheel", stopScroll, { passive: false });
    blocker?.addEventListener("touchmove", stopScroll, { passive: false });
    window.addEventListener("wheel", stopScroll, { capture: true, passive: false });
    window.addEventListener("touchmove", stopScroll, { capture: true, passive: false });
    return () => {
      blocker?.removeEventListener("wheel", stopScroll);
      blocker?.removeEventListener("touchmove", stopScroll);
      window.removeEventListener("wheel", stopScroll, { capture: true });
      window.removeEventListener("touchmove", stopScroll, { capture: true });
    };
  }, [automationBypass]);

  const stopPointer = (event: SyntheticEvent) => {
    if (automationBypass) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      ref={blockerRef}
      data-slot="control-overlay-blocker"
      aria-hidden="true"
      onPointerDown={stopPointer}
      onClick={stopPointer}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483646,
        pointerEvents: automationBypass ? "none" : "auto",
        background: "transparent",
      }}
    />
  );
}
