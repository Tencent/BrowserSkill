import { i18n } from "@browser-skill/i18n";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVideos } from "@/video/client";
import { VideoPanel } from "./video-panel";

vi.mock("@/video/client", () => ({
  useVideos: vi.fn(),
  openVideo: vi.fn(),
  videoTime: (ms: number) => String(ms / 1000),
}));

describe("video task entry", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
    vi.mocked(useVideos).mockReturnValue({
      tasks: [],
      recordings: [],
      busy: false,
      interrupting: false,
      error: "",
      run: vi.fn(),
    });
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

  it("copies a harness-neutral prompt before a task exists", async () => {
    render(<VideoPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Copy agent prompt" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    const prompt = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    expect(prompt).toContain("60-second limit and standard quality");
    expect(prompt).toContain("before navigation or task operations");
    expect(prompt).toContain("Stop recording before ending the task");
    expect(prompt).toContain("destination I specify");
    expect(prompt).not.toContain("--session");
    expect(useVideos().run).not.toHaveBeenCalled();
  });

  it("updates the prompt with selected settings and clears stale feedback", async () => {
    render(<VideoPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Copy agent prompt" }));
    await screen.findByRole("button", { name: "Copied" });
    fireEvent.change(screen.getByLabelText("Limit (1–600 seconds)"), { target: { value: "180" } });
    fireEvent.change(screen.getByLabelText("Quality"), { target: { value: "clear" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy agent prompt" }));
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls.at(-1)?.[0]).toContain(
      "180-second limit and clear quality",
    );
    await screen.findByRole("button", { name: "Copied" });
  });

  it("reports clipboard failure without claiming success and allows retry", async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("denied"));
    render(<VideoPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Copy agent prompt" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy agent prompt" }));
    await screen.findByRole("button", { name: "Copied" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps manual start behind explicit task/tab authorization", () => {
    const { container } = render(<VideoPanel />);
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    details.open = true;
    const start = screen.getByRole("button", { name: "Start recording" });
    expect(start.hasAttribute("disabled")).toBe(true);
    fireEvent.click(start);
    expect(useVideos().run).not.toHaveBeenCalled();
  });

  it("retains manual capture of the selected authorized task tab", () => {
    const state = useVideos();
    vi.mocked(useVideos).mockReturnValue({
      ...state,
      tasks: [
        {
          session_id: "task-1",
          tabs: [{ id: 7, title: "Example", url: "https://example.com", active: true }],
        },
      ],
    });
    const { container } = render(<VideoPanel />);
    container.querySelector("details")!.open = true;
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    expect(state.run).toHaveBeenCalledWith("start", {
      options: expect.objectContaining({
        session_id: "task-1",
        tab_id: 7,
        max_duration_ms: 60000,
        quality: "standard",
      }),
    });
  });
});
