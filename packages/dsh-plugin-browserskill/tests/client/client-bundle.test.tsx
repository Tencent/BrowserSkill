// @vitest-environment happy-dom
// Exercise the shipped module-loader boundary: current DSH attachment clients
// export plugin hooks, not the React components exposed by the old dev package.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as primitives from "@deepseek-ai/dsh-client-ui-primitives";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as ReactDOM from "react-dom";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("expands a bundled screenshot card without host attachment components", async () => {
  const root = process.cwd();
  const output = mkdtempSync(join(tmpdir(), "bsk-client-bundle-"));
  let source: string;
  try {
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules/tsdown/dist/run.mjs"),
        "--filter",
        "@wxg-prc-cpg/browser-skill-dsh-plugin/client",
        "--out-dir",
        output,
      ],
      { cwd: root, stdio: "pipe" },
    );
    source = readFileSync(join(output, "client.cjs"), "utf8");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
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
  const url = "blob:bundled-screenshot";
  vi.spyOn(URL, "createObjectURL").mockReturnValue(url);
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
  // Replay/remount must resolve the durable attachment through its owning session.
  for (let attempt = 0; attempt < 2; attempt++) {
    const view = render(<ToolView {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /screenshot/i }));
    expect((await screen.findByRole("img", { name: "screenshot.png" })).getAttribute("src")).toBe(
      url,
    );
    expect(screen.getByText("Screenshot captured")).toBeTruthy();
    view.unmount();
  }
  expect(binding).toHaveBeenCalledWith("owning-session");
  expect(readAttachment.mock.calls).toEqual([[attachment.attachmentId], [attachment.attachmentId]]);
  expect(revoke).toHaveBeenCalledTimes(2);
}, 30_000);
