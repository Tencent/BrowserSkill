import { i18n } from "@browser-skill/i18n";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interactionPreferences } from "@/lib/interaction-preferences";
import { InteractionSettings } from "./interaction-settings";

describe("automation settings", () => {
  beforeEach(() => {
    vi.spyOn(interactionPreferences, "ready").mockResolvedValue();
    vi.spyOn(interactionPreferences, "get").mockReturnValue({
      confirmTabBorrow: true,
      requestHelpEnabled: true,
      openAgentWindowMinimized: false,
    });
    vi.spyOn(interactionPreferences, "subscribe").mockReturnValue(() => {});
    vi.spyOn(interactionPreferences, "set").mockResolvedValue();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps explanations in labelled info tooltips without changing a preference on click", async () => {
    render(<InteractionSettings />);
    for (const [name, scopeKey] of [
      ["借用标签页确认说明", "popup.interaction.scope"],
      ["人工协助说明", "popup.interaction.scope"],
      ["最小化打开 Agent 窗口说明", "popup.interaction.openAgentWindowMinimizedScope"],
    ] as const) {
      const info = screen.getByRole("button", { name });
      const tooltip = document.getElementById(info.getAttribute("aria-describedby")!);
      expect(tooltip?.getAttribute("role")).toBe("tooltip");
      expect(tooltip?.textContent).toContain(i18n.t(scopeKey, { ns: "extension" }));
      fireEvent.click(info);
    }
    expect(interactionPreferences.set).not.toHaveBeenCalled();
    expect(screen.getAllByRole("tooltip")).toHaveLength(3);
    expect(document.querySelector('[data-slot="popup-interaction-settings"] > p')).toBeNull();
  });

  it("saves borrowing, help, and minimized window preferences independently without another confirmation", async () => {
    render(<InteractionSettings />);
    const borrow = screen.getByRole("switch", { name: "借用标签页前确认" });
    await waitFor(() => expect((borrow as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(borrow);
    await waitFor(() =>
      expect(interactionPreferences.set).toHaveBeenCalledWith({
        confirmTabBorrow: false,
        requestHelpEnabled: true,
        openAgentWindowMinimized: false,
      }),
    );
    const help = screen.getByRole("switch", { name: "允许请求人工协助" });
    await waitFor(() => expect((help as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(help);
    await waitFor(() =>
      expect(interactionPreferences.set).toHaveBeenCalledWith({
        confirmTabBorrow: true,
        requestHelpEnabled: false,
        openAgentWindowMinimized: false,
      }),
    );
    const minimized = screen.getByRole("switch", { name: "最小化打开 Agent 窗口" });
    await waitFor(() => expect((minimized as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(minimized);
    await waitFor(() =>
      expect(interactionPreferences.set).toHaveBeenCalledWith({
        confirmTabBorrow: true,
        requestHelpEnabled: true,
        openAgentWindowMinimized: true,
      }),
    );
  });

  it("keeps the saved switch state and reports a failed write", async () => {
    vi.mocked(interactionPreferences.set).mockRejectedValue(new Error("failed"));
    render(<InteractionSettings />);
    const borrow = screen.getByRole("switch", { name: "借用标签页前确认" });
    await waitFor(() => expect((borrow as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(borrow);
    await screen.findByRole("alert");
    expect(borrow.getAttribute("aria-checked")).toBe("true");
  });

  it("prevents writes while preferences cannot be read", async () => {
    vi.mocked(interactionPreferences.ready).mockRejectedValue(new Error("failed"));
    render(<InteractionSettings />);
    await screen.findByRole("alert");
    for (const toggle of screen.getAllByRole("switch"))
      expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(interactionPreferences.set).not.toHaveBeenCalled();
  });
});
