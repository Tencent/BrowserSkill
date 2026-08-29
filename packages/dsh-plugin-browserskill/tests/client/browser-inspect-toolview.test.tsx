// @vitest-environment happy-dom
// browser_inspect keyed toolview: view-model derivation from frozen blocks,
// image/path-only/running/error rendering, the registration key, and the
// session-bound attachment loader.

import type { RunningToolCall, ToolResultNode } from "@deepseek-ai/dsh-client-runtime/client";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserInspectToolView,
  type BrowserInspectToolViewProps,
  viewModelOf,
} from "../../src/client/BrowserInspectToolView";
import { apply } from "../../src/client/index";

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
    name: "browser_inspect",
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
    call: { name: "browser_inspect", argsRaw },
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
    const model = viewModelOf(runningBlock('{"action":"screenshot","session":"s1"}'));
    expect(model.state).toBe("running");
    expect(model.command).toBe("bsk screenshot --session s1");
    expect(model.image).toBeNull();
  });

  it("marks settled results carrying an image block", () => {
    const block = settledBlock('{"action":"screenshot"}', [
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
    const model = viewModelOf(
      settledBlock('{"action":"screenshot"}', [{ type: "text", text: PATH_TEXT }]),
    );
    expect(model.state).toBe("ok");
    expect(model.image).toBeNull();
    expect(model.summary).toBe(PATH_TEXT);
  });

  it("marks error results", () => {
    const model = viewModelOf(
      settledBlock('{"action":"screenshot"}', [{ type: "text", text: "Error: boom" }], true),
    );
    expect(model.state).toBe("error");
  });

  it("renders non-screenshot inspect actions as ordinary terminal calls", () => {
    const model = viewModelOf(
      settledBlock('{"action":"observe","session":"s1"}', [
        { type: "text", text: "page observation" },
      ]),
    );
    expect(model.title).toBe("Observe");
    expect(model.command).toBe("bsk observe --session s1");
    expect(model.image).toBeNull();
  });

  it("preserves action-specific arguments in diagnostic command cards", () => {
    const model = viewModelOf(
      runningBlock(
        '{"action":"console","session":"s1","tabId":7,"since":4,"limit":20,"maxTextChars":500,"includeStack":true}',
      ),
    );
    expect(model.command).toBe(
      "bsk console --session s1 --tab-id 7 --since 4 --limit 20 --max-text-chars 500 --include-stack",
    );
  });
});

describe("BrowserInspectToolView", () => {
  const baseProps = { callId: "c1", toolName: "browser_inspect", openFile: () => {} };
  const renderView = (
    block: BrowserInspectToolViewProps["block"],
    loadImage: BrowserInspectToolViewProps["loadImage"],
  ) => {
    const props = { ...baseProps, block, loadImage } as unknown as BrowserInspectToolViewProps;
    return render(<BrowserInspectToolView {...props} />);
  };

  it("renders the screenshot image through the loader", async () => {
    const block = settledBlock('{"action":"screenshot"}', [
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
    const block = settledBlock('{"action":"screenshot"}', [{ type: "text", text: PATH_TEXT }]);
    const loadImage = vi.fn(async () => "blob:unused");
    renderView(block, loadImage);
    screen.getByRole("button", { name: /screenshot/i }).click();
    await screen.findByText(PATH_TEXT, { exact: false });
    expect(loadImage).not.toHaveBeenCalled();
  });

  it("renders the running form without output", () => {
    const loadImage = vi.fn();
    renderView(runningBlock('{"action":"screenshot"}'), loadImage);
    expect(screen.getByText("bsk screenshot --session (current)")).toBeTruthy();
    expect(loadImage).not.toHaveBeenCalled();
  });
});

describe("client plugin registration", () => {
  it("registers the browser_inspect toolview and the shell observation overlay", () => {
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
      { name: "tool.call.toolview", key: "browser_inspect" },
      { name: "shell.overlay", id: "bsk-observation" },
    ]);
  });
});
