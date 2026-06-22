import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ControlOverlay } from "../ControlOverlay";

describe("ControlOverlay", () => {
  afterEach(() => {
    cleanup();
  });

  it("sets pointer-events none on blocker and pill when automationBypass is true", () => {
    const { container } = render(
      <ControlOverlay
        visible={true}
        interrupting={false}
        automationBypass={true}
        onInterrupt={() => {}}
      />,
    );

    const blocker = container.querySelector("[data-slot='control-overlay']")?.nextElementSibling;
    expect(blocker).toBeTruthy();
    expect((blocker as HTMLElement).style.pointerEvents).toBe("none");

    const stopBtn = container.querySelector("[data-slot='control-overlay-stop-all']");
    expect(stopBtn).toBeTruthy();
    expect((stopBtn as HTMLElement).style.pointerEvents).toBe("none");
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

    const blocker = container.querySelector("[data-slot='control-overlay']")?.nextElementSibling;
    expect(blocker).toBeTruthy();
    expect((blocker as HTMLElement).style.pointerEvents).toBe("auto");
  });
});
