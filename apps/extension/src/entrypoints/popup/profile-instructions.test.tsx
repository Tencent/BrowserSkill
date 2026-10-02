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
    vi.useRealTimers();
  });
  it("copies an instruction that pins every new session to this instance", async () => {
    render(<ProfileInstructions label="Work" instanceId="a1234567" connected />);
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions" }));
    const text = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0];
    expect(text).toContain('browser "Work" (instance ID: a1234567)');
    expect(text).toContain("bsk session start --browser a1234567 --json");
    expect(text).toContain('browser_session({ action: "start", browser: "a1234567" })');
    expect(text).toContain("use the tool call instead of running the CLI command separately");
    expect(text).toContain("every new session for this task");
    expect(text).toContain("Do not omit --browser / browser or switch to another instance");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });
  it.each([
    { instanceId: "a1234567", connected: false },
    { instanceId: "", connected: true },
  ])("does not copy an unavailable target: %j", (props) => {
    render(<ProfileInstructions label="Work" {...props} />);
    const button = screen.getByRole("button", { name: "Copy instructions" });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
  it("provides a compact hint on the copy button", () => {
    const { rerender } = render(
      <ProfileInstructions label="Work" instanceId="a1234567" connected={false} />,
    );
    expect(screen.getByRole("button").title).toBe(
      i18n.t("extension:popup.profile.unavailableHint"),
    );
    rerender(<ProfileInstructions label="Work" instanceId="a1234567" connected />);
    expect(screen.getByRole("button").title).toBe(i18n.t("extension:popup.profile.hint"));
  });
  it("uses the current instance after a change and hides stale copy feedback", async () => {
    let resolveCopy: () => void = () => {};
    vi.mocked(navigator.clipboard.writeText).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveCopy = resolve;
        }),
    );
    const { rerender } = render(
      <ProfileInstructions label="Work" instanceId="a1234567" connected />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions" }));
    rerender(<ProfileInstructions label="Work" instanceId="b1234567" connected />);
    await act(async () => resolveCopy());
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions" }));
    await screen.findByRole("button", { name: "Copied" });
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[1]?.[0]).toContain(
      "bsk session start --browser b1234567 --json",
    );
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[1]?.[0]).toContain(
      'browser_session({ action: "start", browser: "b1234567" })',
    );
  });
  it("reports clipboard failure and allows retry without claiming success", async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("clipboard denied"));
    render(<ProfileInstructions label="Work" instanceId="a1234567" connected />);
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("uses names only as descriptive text, including quotes and shell characters", async () => {
    const label = 'Work "A" & $(example)';
    render(<ProfileInstructions label={label} instanceId="a1234567" connected />);
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions" }));
    const text = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0];
    expect(text).toContain(JSON.stringify(label));
    expect(text).toContain("CLI: bsk session start --browser a1234567 --json");
    expect(text).toContain('browser_session({ action: "start", browser: "a1234567" })');
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });
  it("discards pending feedback when the saved name changes and copies the new name", async () => {
    let resolveCopy!: () => void;
    vi.mocked(navigator.clipboard.writeText).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveCopy = resolve;
        }),
    );
    const { rerender } = render(
      <ProfileInstructions label="Personal" instanceId="a1234567" connected />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions" }));
    rerender(<ProfileInstructions label="Work" instanceId="a1234567" connected />);
    await act(async () => resolveCopy());
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[1]?.[0]).toContain('browser "Work"');
  });
  it("does not revive pending feedback after disconnecting and reconnecting", async () => {
    let resolveCopy!: () => void;
    vi.mocked(navigator.clipboard.writeText).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveCopy = resolve;
        }),
    );
    const { rerender } = render(
      <ProfileInstructions label="Work" instanceId="a1234567" connected />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions" }));
    rerender(<ProfileInstructions label="Work" instanceId="a1234567" connected={false} />);
    rerender(<ProfileInstructions label="Work" instanceId="a1234567" connected />);
    await act(async () => resolveCopy());
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  });
  it("briefly confirms copying in the button without adding a status paragraph", async () => {
    vi.useFakeTimers();
    render(<ProfileInstructions label="" instanceId="a1234567" connected />);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Copy instructions" })),
    );
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0]).toContain(
      '"Unnamed browser"',
    );
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByRole("button", { name: "Copy instructions" })).toBeTruthy();
  });
  it.each(
    Object.keys(i18n.options.resources ?? {}),
  )("preserves the exact commands in %s instructions", async (locale) => {
    await i18n.changeLanguage(locale);
    render(<ProfileInstructions label="Work" instanceId="a1234567" connected />);
    fireEvent.click(screen.getByRole("button"));
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0]).toContain(
      "bsk session start --browser a1234567 --json",
    );
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0]).toContain(
      'browser_session({ action: "start", browser: "a1234567" })',
    );
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0]).toContain(
      "--browser / browser",
    );
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0]).not.toMatch(/{{.*?}}/);
    expect(
      await screen.findByRole("button", { name: i18n.t("extension:popup.copied") }),
    ).toBeTruthy();
  });
});
