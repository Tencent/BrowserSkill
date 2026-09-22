import { i18n } from "@browser-skill/i18n";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileInstructions } from "./profile-instructions";

describe("profile instructions", () => {
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
    vi.restoreAllMocks();
  });
  it("copies an instruction that pins every new session to this instance", async () => {
    render(<ProfileInstructions instanceId="a1234567" connected />);
    fireEvent.click(screen.getByRole("button", { name: "Copy profile instructions" }));
    const text = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0];
    expect(text).toContain("bsk session start --browser a1234567 --json");
    expect(text).toContain('browser_session({ action: "start", browser: "a1234567" })');
    expect(text).toContain("use the tool call instead of running the CLI command separately");
    expect(text).toContain("every new session for this task");
    expect(text).toContain("Do not omit --browser / browser or switch to another instance");
    expect(await screen.findByRole("status")).toBeTruthy();
  });
  it.each([
    { instanceId: "a1234567", connected: false },
    { instanceId: "", connected: true },
  ])("does not copy an unavailable target: %j", (props) => {
    render(<ProfileInstructions {...props} />);
    const button = screen.getByRole("button", { name: "Copy profile instructions" });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
  it("uses the current instance after a change and hides stale copy feedback", async () => {
    let resolveCopy: () => void = () => {};
    vi.mocked(navigator.clipboard.writeText).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveCopy = resolve;
        }),
    );
    const { rerender } = render(<ProfileInstructions instanceId="a1234567" connected />);
    fireEvent.click(screen.getByRole("button", { name: "Copy profile instructions" }));
    rerender(<ProfileInstructions instanceId="b1234567" connected />);
    await act(async () => resolveCopy());
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy profile instructions" }));
    await screen.findByRole("status");
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[1]?.[0]).toContain(
      "bsk session start --browser b1234567 --json",
    );
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[1]?.[0]).toContain(
      'browser_session({ action: "start", browser: "b1234567" })',
    );
  });
  it("reports clipboard failure and allows retry without claiming success", async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("clipboard denied"));
    render(<ProfileInstructions instanceId="a1234567" connected />);
    fireEvent.click(screen.getByRole("button", { name: "Copy profile instructions" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy profile instructions" }));
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it.each(["zh-CN", "ko-KR"])("preserves the exact command in %s instructions", async (locale) => {
    await i18n.changeLanguage(locale);
    render(<ProfileInstructions instanceId="a1234567" connected />);
    fireEvent.click(screen.getByRole("button"));
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0]).toContain(
      "bsk session start --browser a1234567 --json",
    );
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0]).toContain(
      'browser_session({ action: "start", browser: "a1234567" })',
    );
    expect(await screen.findByRole("status")).toBeTruthy();
  });
});
