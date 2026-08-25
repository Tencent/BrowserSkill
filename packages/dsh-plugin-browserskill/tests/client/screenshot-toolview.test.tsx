// @vitest-environment happy-dom
// browser_screenshot keyed toolview: view-model derivation from frozen blocks,
// image/path-only/running/error rendering, the registration key, and the
// session-bound attachment loader.

import type { RunningToolCall, ToolResultNode } from "@deepseek-ai/dsh-client-runtime/client";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apply } from "../../src/client/index";
import {
  ScreenshotToolView,
  type ScreenshotToolViewProps,
  viewModelOf,
} from "../../src/client/ScreenshotToolView";

const ATTACHMENT = {
  attachmentId: "sha256:abc123",
  mediaType: "image/png",
  bytes: 8,
  width: 800,
  height: 457,
  name: "screenshot-s1.png",
} as never;

function runningBlock(argsRaw: string): RunningToolCall {
  return {
    callId: "c1",
    name: "browser_screenshot",
    argsRaw,
    turn: 1,
    step: 1,
    time: 0,
    callView: null,
    subCalls: [],
  } as never;
}

function settledBlock(argsRaw: string, content: unknown[], isError = false): ToolResultNode {
  return {
    kind: "tool-result",
    seq: 1,
    time: 0,
    callId: "c1",
    call: { name: "browser_screenshot", argsRaw },
    callTime: 0,
    content,
    isError,
    callView: null,
    resultView: null,
    subCalls: [],
  } as never;
}

const IMAGE_TEXT = "[session s1] screenshot of tab 7 (800x457px)";
const PATH_TEXT = "[session s1] screenshot saved to /tmp/shot.png (800x457px, 8 bytes)";

afterEach(cleanup);

describe("viewModelOf", () => {
  it("derives the running model from the call frame", () => {
    const model = viewModelOf(runningBlock('{"session":"s1"}'));
    expect(model.state).toBe("running");
    expect(model.command).toBe("bsk screenshot --session s1");
    expect(model.image).toBeNull();
  });

  it("marks settled results carrying an image block", () => {
    const block = settledBlock("{}", [
      { type: "text", text: IMAGE_TEXT },
      { type: "image", attachment: ATTACHMENT },
    ]);
    const model = viewModelOf(block);
    expect(model.state).toBe("ok");
    expect(model.image).toBe(ATTACHMENT);
    expect(model.output).toBe(IMAGE_TEXT);
    expect(model.command).toBe("bsk screenshot --session (current)");
  });

  it("keeps the path-only form image-free", () => {
    const model = viewModelOf(settledBlock("{}", [{ type: "text", text: PATH_TEXT }]));
    expect(model.state).toBe("ok");
    expect(model.image).toBeNull();
    expect(model.summary).toBe(PATH_TEXT);
  });

  it("marks error results", () => {
    const model = viewModelOf(settledBlock("{}", [{ type: "text", text: "Error: boom" }], true));
    expect(model.state).toBe("error");
  });
});

describe("ScreenshotToolView", () => {
  const baseProps = { callId: "c1", toolName: "browser_screenshot", openFile: () => {} };
  const renderView = (
    block: ScreenshotToolViewProps["block"],
    loadImage: ScreenshotToolViewProps["loadImage"],
  ) => {
    const props = { ...baseProps, block, loadImage } as unknown as ScreenshotToolViewProps;
    return render(<ScreenshotToolView {...props} />);
  };

  it("renders the screenshot image through the loader", async () => {
    const block = settledBlock("{}", [
      { type: "text", text: IMAGE_TEXT },
      { type: "image", attachment: ATTACHMENT },
    ]);
    const loadImage = vi.fn(async () => "blob:mock-url");
    renderView(block, loadImage);
    // Collapsed row shows the summary; expand to reach the image.
    expect(screen.getByText(IMAGE_TEXT)).toBeTruthy();
    const toggle = screen.getByRole("button", { name: /screenshot/i });
    toggle.click();
    await waitFor(() => expect(loadImage).toHaveBeenCalledWith(ATTACHMENT));
    await screen.findByRole("img", { name: "screenshot-s1.png" });
  });

  it("renders the path-only form without touching the loader", async () => {
    const block = settledBlock("{}", [{ type: "text", text: PATH_TEXT }]);
    const loadImage = vi.fn(async () => "blob:unused");
    renderView(block, loadImage);
    screen.getByRole("button", { name: /screenshot/i }).click();
    await screen.findByText(PATH_TEXT, { exact: false });
    expect(loadImage).not.toHaveBeenCalled();
  });

  it("renders the running form without output", () => {
    const loadImage = vi.fn();
    renderView(runningBlock("{}"), loadImage);
    expect(screen.getByText("bsk screenshot --session (current)")).toBeTruthy();
    expect(loadImage).not.toHaveBeenCalled();
  });
});

describe("client plugin registration", () => {
  it("registers the browser_screenshot toolview and the shell observation overlay", () => {
    const registrations: { name: string; key?: string; id?: string }[] = [];
    const sessions = { binding: () => undefined };
    const ctx = {
      get: (key: string) => (key === "sessions" ? sessions : undefined),
      // cordis ctx.inject: the betterSidebar carrier upgrade stays dormant in
      // this composition (the callback only runs once the service exists).
      inject: (_deps: string[], _fn: (injected: unknown) => unknown) => {},
      slots: {
        inject: (_name: string, fn: () => unknown) => fn(),
        register: (slot: { name: string; key?: string; id?: string }, view: unknown) => {
          registrations.push(slot);
          expect(typeof view).toBe("function");
        },
      },
    };
    apply(ctx as never);
    expect(registrations).toEqual([
      { name: "tool.call.toolview", key: "browser_screenshot" },
      { name: "shell.overlay", id: "bsk-observation" },
    ]);
  });
});
