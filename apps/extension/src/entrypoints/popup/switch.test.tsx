import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Switch } from "./switch";

describe("Switch", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders switch semantics with the checked state", () => {
    render(<Switch checked={true} onCheckedChange={vi.fn()} aria-label="开关" />);

    const toggle = screen.getByRole("switch", { name: "开关" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.className).toContain("h-5 w-9");
    expect(toggle.className).toContain("bg-primary");
  });

  it("calls onCheckedChange with the negated state when clicked", () => {
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onCheckedChange} aria-label="开关" />);

    const toggle = screen.getByRole("switch", { name: "开关" });
    expect(toggle.className).toContain("bg-muted");

    fireEvent.click(toggle);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });
});
