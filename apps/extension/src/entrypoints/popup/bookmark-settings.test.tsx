import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BookmarkSettings } from "./bookmark-settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("bookmark permission", () => {
  it("requests access only on a user click and reflects denial and revocation", async () => {
    let granted = false;
    const permissions = {
      contains: vi.fn(async () => granted),
      request: vi.fn(async () => false),
      remove: vi.fn(async () => {
        granted = false;
        return true;
      }),
      onAdded: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    vi.stubGlobal("chrome", { permissions });
    render(<BookmarkSettings />);
    const toggle = screen.getByRole("switch", { name: "书签访问" });
    await waitFor(() => expect(toggle).toHaveProperty("disabled", false));
    expect(permissions.request).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    await waitFor(() => expect(permissions.request).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toggle).toHaveProperty("disabled", false));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    permissions.request.mockImplementation(async () => {
      granted = true;
      return true;
    });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(permissions.remove).toHaveBeenCalledWith({ permissions: ["bookmarks"] });
    cleanup();
    expect(permissions.onAdded.removeListener).toHaveBeenCalled();
  });

  it("keeps the control disabled when permission state cannot be read", async () => {
    const permissions = {
      contains: vi.fn().mockRejectedValue(new Error("unavailable")),
      request: vi.fn(),
      onAdded: { addListener: vi.fn(), removeListener: vi.fn() },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    vi.stubGlobal("chrome", { permissions });
    render(<BookmarkSettings />);
    await screen.findByRole("alert");
    expect(screen.getByRole("switch")).toHaveProperty("disabled", true);
    expect(permissions.request).not.toHaveBeenCalled();
  });
});
