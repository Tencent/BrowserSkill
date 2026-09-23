// @vitest-environment happy-dom
// Exercise the shipped module-loader boundary: current DSH attachment clients
// export plugin hooks, not the React components exposed by the old dev package.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as primitives from "@deepseek-ai/dsh-client-ui-primitives";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as ReactDOM from "react-dom";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

let source: string;

// Share one client-only build across these host-contract cases. Resolve the
// public CLI entry from this file so neither cwd nor tsdown's layout matters.
beforeAll(async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const output = mkdtempSync(join(tmpdir(), "bsk-client-bundle-"));
  try {
    await promisify(execFile)(
      process.execPath,
      [
        createRequire(import.meta.url).resolve("tsdown/run"),
        "--filter",
        "@wxg-prc-cpg/browser-skill-dsh-plugin/client",
        "--out-dir",
        output,
      ],
      { cwd: root },
    );
    source = readFileSync(join(output, "client.cjs"), "utf8");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 30_000);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setupClient() {
  const host: Record<string, unknown> = {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "react-dom": ReactDOM,
    "@deepseek-ai/dsh-client-ui-primitives": primitives,
    "@deepseek-ai/dsh-client-ui-attachment": { apply() {}, inject: ["slots"] },
  };
  let client!: { apply(ctx: unknown): void };
  new Function("window", source)({
    __ModuleLoader__: {
      load: ({ factory }: { factory: (require: (id: string) => unknown) => typeof client }) => {
        client = factory((id) => {
          if (!(id in host)) throw new Error(`Unexpected client external: ${id}`);
          return host[id];
        });
      },
    },
  });

  const attachment = {
    attachmentId: "sha256:screenshot",
    mediaType: "image/png",
    bytes: 4,
    width: 800,
    height: 457,
    name: "screenshot.png",
  };
  const readAttachment = vi.fn(async () => ({
    ok: true,
    value: { attachment, data: [137, 80, 78, 71] },
  }));
  const binding = vi.fn(() => ({ session: { readAttachment } }));
  let nextURL = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:screenshot-${++nextURL}`);
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  let ToolView!: React.ComponentType<Record<string, unknown>>;
  client.apply({
    get: () => ({ binding }),
    inject() {},
    slots: {
      inject: (_name: string, callback: () => void) => callback(),
      register: ({ key }: { key?: string }, view: typeof ToolView) => {
        if (key === "browser_inspect") ToolView = view;
      },
    },
  });
  const props = {
    sessionId: "owning-session",
    callId: "c1",
    toolName: "browser_inspect",
    openFile() {},
    block: {
      kind: "tool-result",
      callId: "c1",
      call: { name: "browser_inspect", argsRaw: '{"action":"screenshot"}' },
      content: [
        { type: "text", text: "Screenshot captured" },
        { type: "image", attachment },
      ],
    },
  };
  return { ToolView, props, attachment, readAttachment, binding, revoke };
}

it("expands a bundled screenshot card without host attachment components", async () => {
  const { ToolView, props, attachment, readAttachment, binding, revoke } = setupClient();
  // Replay/remount must resolve the durable attachment through its owning session.
  for (let attempt = 0; attempt < 2; attempt++) {
    const view = render(<ToolView {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /screenshot/i }));
    expect((await screen.findByRole("img", { name: "screenshot.png" })).getAttribute("src")).toBe(
      `blob:screenshot-${attempt + 1}`,
    );
    expect(screen.getByText("Screenshot captured")).toBeTruthy();
    view.unmount();
  }
  expect(binding).toHaveBeenCalledWith("owning-session");
  expect(readAttachment.mock.calls).toEqual([[attachment.attachmentId], [attachment.attachmentId]]);
  expect(revoke).toHaveBeenCalledTimes(2);
});

it("preserves the preview on host rerenders and reloads only when its session changes", async () => {
  const { ToolView, props, readAttachment, binding, revoke } = setupClient();
  const view = render(<ToolView {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /screenshot/i }));
  await screen.findByRole("img", { name: "screenshot.png" });
  fireEvent.click(screen.getByRole("button", { name: "Open screenshot screenshot.png" }));
  const preview = screen.getByRole("dialog", { name: "Screenshot preview" });
  expect(preview.hasAttribute("open")).toBe(true);

  await act(async () => view.rerender(<ToolView {...props} openFile={() => {}} />));
  expect(screen.getByRole("dialog", { name: "Screenshot preview" })).toBe(preview);
  expect(preview.hasAttribute("open")).toBe(true);
  expect(readAttachment).toHaveBeenCalledTimes(1);
  expect(revoke).not.toHaveBeenCalled();

  view.rerender(<ToolView {...props} sessionId="next-session" />);
  await waitFor(() =>
    expect(screen.getByRole("img").getAttribute("src")).toBe("blob:screenshot-2"),
  );
  expect(binding).toHaveBeenLastCalledWith("next-session");
  expect(readAttachment).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:screenshot-1");
});
