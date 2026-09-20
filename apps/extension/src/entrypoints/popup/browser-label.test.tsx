import { i18n } from "@browser-skill/i18n";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserLabel } from "./browser-label";

describe("browser label", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
  });

  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage("zh-CN");
    vi.restoreAllMocks();
  });

  it("saves a trimmed human-readable browser name", () => {
    const onSave = vi.fn();
    render(<BrowserLabel label="" onSave={onSave} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Browser name" }), {
      target: { value: "  Work profile  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("Work profile");
  });

  it("supports Enter to save and Escape to discard", () => {
    const onSave = vi.fn();
    render(<BrowserLabel label="Personal" onSave={onSave} />);
    const input = screen.getByRole("textbox", { name: "Browser name" });

    fireEvent.change(input, { target: { value: "Work" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSave).toHaveBeenCalledWith("Work");

    fireEvent.change(input, { target: { value: "Temporary" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("Personal");
  });

  it("allows clearing a saved name", () => {
    const onSave = vi.fn();
    render(<BrowserLabel label="Work" onSave={onSave} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Browser name" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("");
  });

  it("rejects names that can be confused with an instance id", () => {
    const onSave = vi.fn();
    render(<BrowserLabel label="" onSave={onSave} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Browser name" }), {
      target: { value: "deadbeef" },
    });

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("follows a label update from the background snapshot", () => {
    const onSave = vi.fn();
    const { rerender } = render(<BrowserLabel label="Personal" onSave={onSave} />);

    rerender(<BrowserLabel label="Work" onSave={onSave} />);

    expect((screen.getByRole("textbox", { name: "Browser name" }) as HTMLInputElement).value).toBe(
      "Work",
    );
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  });

  it.each([
    ["zh-CN", "浏览器名称", "保存"],
    ["ko-KR", "브라우저 이름", "저장"],
  ])("renders the naming controls in %s", async (locale, fieldName, saveName) => {
    await i18n.changeLanguage(locale);
    render(<BrowserLabel label="" onSave={vi.fn()} />);

    expect(screen.getByRole("textbox", { name: fieldName })).toBeTruthy();
    expect(screen.getByRole("button", { name: saveName })).toBeTruthy();
  });
});
