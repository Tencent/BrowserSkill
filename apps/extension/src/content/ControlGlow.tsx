export function ControlGlow() {
  return (
    <>
      {/* Paint both viewport-sized shadows once and animate only the brighter
          layer's opacity, for a bounded number of pulses. Animating box-shadow
          would repaint the viewport every frame. */}
      <style>{`
        @keyframes bsk-breathe {
          0%, 100% {
            opacity: 0;
          }
          50% {
            opacity: 1;
          }
        }

        .bsk-control-glow-pulse {
          animation: bsk-breathe 3s ease-in-out 2;
        }

        @media (prefers-reduced-motion: reduce) {
          .bsk-control-glow-pulse {
            animation: none;
          }
        }
      `}</style>

      <div
        data-slot="control-overlay"
        aria-hidden="true"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 2147483646,
          pointerEvents: "none",
          boxShadow: "inset 0 0 20px 4px rgba(249,115,22,0.25)",
        }}
      >
        <div
          data-slot="control-overlay-pulse"
          className="bsk-control-glow-pulse"
          style={{
            position: "absolute",
            inset: 0,
            boxShadow: "inset 0 0 40px 8px rgba(249,115,22,0.5)",
            opacity: 0,
          }}
        />
      </div>
    </>
  );
}
