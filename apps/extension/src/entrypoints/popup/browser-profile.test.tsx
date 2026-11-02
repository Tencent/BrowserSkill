import { i18n } from "@browser-skill/i18n";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserProfile } from "./browser-profile";

const props = {
  instanceId: "a1234567",
  connected: true,
  sessionCount: 0,
  onSave: vi.fn(),
};

function editName(value: string) {
  fireEvent.click(screen.getByRole("button", { name: "Rename browser" }));
  const input = screen.getByRole("textbox", { name: "Browser name" });
  fireEvent.change(input, { target: { value } });
  return input;
}

describe("browser profile", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage("zh-CN");
    vi.clearAllMocks();
  });

  it("shows the saved name and copy action without a permanent naming form", () => {
    render(<BrowserProfile {...props} label="Work" />);
    expect(screen.getByText("Work")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy instructions" })).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("waits for the saved snapshot before copying the new name with the same instance id", async () => {
    const { rerender } = render(<BrowserProfile {...props} label="Personal" />);
    const input = editName("  Work profile  ");
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole("button", { name: "Copy instructions" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(props.onSave).toHaveBeenCalledWith("Work profile");
    expect(screen.queryByRole("button", { name: "Copy instructions" })).toBeNull();

    rerender(<BrowserProfile {...props} label="Work profile" connected={false} />);
    expect(screen.getByText("Work profile")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy instructions" }).hasAttribute("disabled")).toBe(
      true,
    );
    rerender(<BrowserProfile {...props} label="Work profile" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    const text = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0];
    expect(text).toContain('"Work profile"');
    expect(text).toContain("--browser a1234567 --json");
  });

  it.each(["Escape", "Cancel"])("discards edits with %s", (action) => {
    render(<BrowserProfile {...props} label="Personal" />);
    const input = editName("Temporary");
    if (action === "Escape") fireEvent.keyDown(input, { key: "Escape" });
    else fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Personal")).toBeTruthy();
    expect(props.onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Rename browser" }));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Personal");
  });

  it("supports Enter to save and allows clearing a saved name", () => {
    const { rerender } = render(<BrowserProfile {...props} label="Work" />);
    fireEvent.keyDown(editName(""), { key: "Enter" });
    expect(props.onSave).toHaveBeenCalledWith("");
    rerender(<BrowserProfile {...props} label="" />);
    expect(screen.getByText("Unnamed browser")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy instructions" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("rejects names that can be confused with an instance id", () => {
    render(<BrowserProfile {...props} label="" />);
    const input = editName("deadbeef");
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("disables renaming while a browser task is active", () => {
    render(<BrowserProfile {...props} label="Personal" sessionCount={1} />);
    const edit = screen.getByRole("button", { name: "Rename browser" });
    expect(edit.hasAttribute("disabled")).toBe(true);
    expect(edit.title).toBe("Wait for active browser tasks to finish before changing this name.");
    fireEvent.click(edit);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("blocks an open editor if a task starts, but still allows cancelling", () => {
    const { rerender } = render(<BrowserProfile {...props} label="Personal" />);
    const input = editName("Work");
    rerender(<BrowserProfile {...props} label="Personal" sessionCount={1} />);
    expect(input.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText("Wait for active browser tasks to finish before changing this name."),
    ).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it.each([
    { connected: false, instanceId: "a1234567" },
    { connected: true, instanceId: "" },
  ])("explains why copying is unavailable: %j", (unavailable) => {
    render(<BrowserProfile {...props} {...unavailable} label="Work" />);
    expect(screen.getByText(i18n.t("extension:popup.profile.unavailableHint"))).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy instructions" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it.each([
    ["zh-CN", "修改浏览器名称", "浏览器名称", "保存"],
    ["ko-KR", "브라우저 이름 변경", "브라우저 이름", "저장"],
  ])("renders the naming controls in %s", async (locale, edit, fieldName, saveName) => {
    await i18n.changeLanguage(locale);
    render(<BrowserProfile {...props} label="" />);
    fireEvent.click(screen.getByRole("button", { name: edit }));
    expect(screen.getByRole("textbox", { name: fieldName })).toBeTruthy();
    expect(screen.getByRole("button", { name: saveName })).toBeTruthy();
  });
});
