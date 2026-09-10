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
    });
    vi.spyOn(interactionPreferences, "subscribe").mockReturnValue(() => {});
    vi.spyOn(interactionPreferences, "set").mockResolvedValue();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("saves borrowing and help independently without another confirmation", async () => {
    render(<InteractionSettings />);
    const borrow = screen.getByRole("switch", { name: "借用标签页前确认" });
    await waitFor(() => expect((borrow as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(borrow);
    await waitFor(() =>
      expect(interactionPreferences.set).toHaveBeenCalledWith({
        confirmTabBorrow: false,
        requestHelpEnabled: true,
      }),
    );
    const help = screen.getByRole("switch", { name: "允许请求人工协助" });
    await waitFor(() => expect((help as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(help);
    await waitFor(() =>
      expect(interactionPreferences.set).toHaveBeenCalledWith({
        confirmTabBorrow: true,
        requestHelpEnabled: false,
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
