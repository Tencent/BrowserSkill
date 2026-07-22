import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ControlOverlay } from "../ControlOverlay";

describe("ControlOverlay", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps page blocker none under automationBypass but Interrupt stays clickable", () => {
    const { container } = render(
      <ControlOverlay
        visible={true}
        interrupting={false}
        automationBypass={true}
        onInterrupt={() => {}}
      />,
    );

    const blocker = container.querySelector("[data-slot='control-overlay-blocker']");
    expect(blocker).toBeTruthy();
    expect((blocker as HTMLElement).style.pointerEvents).toBe("none");

    const pill = container.querySelector("[data-slot='control-overlay-pill']");
    expect(pill).toBeTruthy();
    expect((pill as HTMLElement).style.pointerEvents).toBe("auto");

    const stopBtn = container.querySelector("[data-slot='control-overlay-stop-all']");
    expect(stopBtn).toBeTruthy();
    expect((stopBtn as HTMLElement).style.pointerEvents).toBe("auto");
  });

  it("uses pointer-events auto on blocker when automationBypass is false", () => {
    const { container } = render(
      <ControlOverlay
        visible={true}
        interrupting={false}
        automationBypass={false}
        onInterrupt={() => {}}
      />,
    );

    const blocker = container.querySelector("[data-slot='control-overlay-blocker']");
    expect(blocker).toBeTruthy();
    expect((blocker as HTMLElement).style.pointerEvents).toBe("auto");
  });
});
